import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  computeMetrics,
  findQuietestWindow,
  learnNoiseProfile,
  processAudio,
  HIGHPASS_HZ,
} from '../audio/dsp';
import { abGains, integratedLoudness } from '../audio/loudness';
import { decodeBlob } from '../audio/capture';
import { getRecordingAudio, getRecordingMeta, updateRecordingMeta } from '../audio/db';
import { encodeWav16 } from '../audio/wav';
import { buildReport, downloadBlob, downloadJson } from '../audio/report';
import type { DenoiseMetrics, DenoiseSettings, RecordingMeta } from '../audio/types';
import Waveform from './Waveform';
import { copy } from '../copy.zh';

type PlayingSide = 'orig' | 'proc' | null;

function computePeaks(channels: Float32Array[], columns = 400): number[] {
  const data = channels[0];
  const peaks: number[] = [];
  const per = Math.max(1, Math.floor(data.length / columns));
  for (let i = 0; i < columns; i++) {
    let peak = 0;
    const start = i * per;
    for (let j = start; j < Math.min(start + per, data.length); j += 4) {
      const v = Math.abs(data[j]);
      if (v > peak) peak = v;
    }
    peaks.push(Math.min(1, peak));
  }
  return peaks;
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function Workbench(props: {
  recordingId: string | null;
  onStatus: (msg: string) => void;
}): ReactNode {
  const [meta, setMeta] = useState<RecordingMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [channels, setChannels] = useState<Float32Array[] | null>(null);
  const [sampleRate, setSampleRate] = useState(44100);
  const [title, setTitle] = useState('');
  const [strength, setStrength] = useState(0.5);
  const [noiseStart, setNoiseStart] = useState(0);
  const [noiseEnd, setNoiseEnd] = useState(1);
  const [autoNoise, setAutoNoise] = useState(true);
  const [processed, setProcessed] = useState<Float32Array[] | null>(null);
  const [metrics, setMetrics] = useState<DenoiseMetrics | null>(null);
  const [ab, setAb] = useState<{ gainOriginalDb: number; gainProcessedDb: number; diffLu: number } | null>(null);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState<PlayingSide>(null);
  const [playOffset, setPlayOffset] = useState(0);
  const [nowSec, setNowSec] = useState(0);

  const ctxRef = useRef<AudioContext | null>(null);
  const origBufRef = useRef<AudioBuffer | null>(null);
  const procBufRef = useRef<AudioBuffer | null>(null);
  const gainOrigRef = useRef<GainNode | null>(null);
  const gainProcRef = useRef<GainNode | null>(null);
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const startedAtRef = useRef(0);
  const offsetRef = useRef(0);
  const playingRef = useRef<PlayingSide>(null);
  const durationSec = meta?.durationSec ?? 0;

  const peaks = useMemo(
    () => (channels ? computePeaks(channels) : []),
    [channels],
  );

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setLoadError('');
    try {
      const m = await getRecordingMeta(id);
      if (!m) {
        setLoadError(copy.workbench.noRecording);
        return;
      }
      const blob = await getRecordingAudio(id);
      if (!blob) {
        setLoadError(copy.workbench.noRecording);
        return;
      }
      const decoded = await decodeBlob(blob, new OfflineAudioContext(2, 1, 44100));
      setMeta(m);
      setTitle(m.title);
      setChannels(decoded.channels);
      setSampleRate(decoded.sampleRate);
      const s = m.settings;
      if (s) {
        setStrength(s.strength);
        setNoiseStart(s.noiseStartSec);
        setNoiseEnd(s.noiseEndSec);
        setAutoNoise(s.autoNoise);
      } else {
        const q = findQuietestWindow(decoded.channels, decoded.sampleRate);
        setNoiseStart(q.startSec);
        setNoiseEnd(q.endSec);
        setAutoNoise(true);
      }
    } catch {
      setLoadError(copy.workbench.noRecording);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (props.recordingId) void load(props.recordingId);
    else setLoading(false);
  }, [props.recordingId, load]);

  const runProcess = useCallback(
    async (ch: Float32Array[], sr: number, str: number, ns: number, ne: number) => {
      setProcessing(true);
      setProgress(0);
      try {
        const profile = str > 0 ? learnNoiseProfile(ch, sr, ns, ne) : null;
        const out = await processAudio(ch, sr, {
          strength: str,
          highpassHz: HIGHPASS_HZ,
          noiseProfile: profile,
          onProgress: (p) => setProgress(p),
        });
        const met = computeMetrics(ch, out, sr);
        const lufsOrig = integratedLoudness(ch, sr);
        const lufsProc = integratedLoudness(out, sr);
        const gains = abGains(lufsOrig, lufsProc);
        setProcessed(out);
        setMetrics(met);
        setAb({
          gainOriginalDb: gains.gainAdb,
          gainProcessedDb: gains.gainBdb,
          diffLu: gains.diffLu,
        });
        procBufRef.current = null;
        if (meta) {
          const settings: DenoiseSettings = {
            strength: str,
            noiseStartSec: ns,
            noiseEndSec: ne,
            highpassHz: HIGHPASS_HZ,
            autoNoise,
          };
          await updateRecordingMeta(meta.id, { settings, metrics: met });
        }
      } finally {
        setProcessing(false);
        setProgress(1);
      }
    },
    [meta, autoNoise],
  );

  // 强度变化后 400 ms 防抖再重算；重算期间上一版仍可播放
  useEffect(() => {
    if (!channels || loading) return;
    const timer = window.setTimeout(() => {
      void runProcess(channels, sampleRate, strength, noiseStart, noiseEnd);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [channels, sampleRate, strength, noiseStart, noiseEnd, loading, runProcess]);

  function ensureCtx(): AudioContext {
    if (!ctxRef.current) {
      ctxRef.current = new AudioContext();
    }
    return ctxRef.current;
  }

  function makeBuffer(ctx: AudioContext, chs: Float32Array[], sr: number): AudioBuffer {
    const buf = ctx.createBuffer(chs.length, chs[0].length, sr);
    chs.forEach((ch, i) => buf.copyToChannel(ch as Float32Array<ArrayBuffer>, i));
    return buf;
  }

  function stopSources(): void {
    for (const s of sourcesRef.current) {
      try {
        s.stop();
      } catch {
        // 已停
      }
      s.disconnect();
    }
    sourcesRef.current = [];
  }

  function currentOffset(): number {
    if (playingRef.current && ctxRef.current) {
      return Math.min(
        durationSec,
        offsetRef.current + (ctxRef.current.currentTime - startedAtRef.current),
      );
    }
    return offsetRef.current;
  }

  function startBoth(offset: number, side: Exclude<PlayingSide, null>): void {
    const ctx = ensureCtx();
    if (!origBufRef.current && channels) {
      origBufRef.current = makeBuffer(ctx, channels, sampleRate);
    }
    if (!procBufRef.current && processed) {
      procBufRef.current = makeBuffer(ctx, processed, sampleRate);
    }
    if (!origBufRef.current || !procBufRef.current) return;
    stopSources();
    if (!gainOrigRef.current) {
      gainOrigRef.current = ctx.createGain();
      gainOrigRef.current.connect(ctx.destination);
    }
    if (!gainProcRef.current) {
      gainProcRef.current = ctx.createGain();
      gainProcRef.current.connect(ctx.destination);
    }
    const g = ab ?? { gainOriginalDb: 0, gainProcessedDb: 0, diffLu: 0 };
    gainOrigRef.current.gain.setValueAtTime(
      side === 'orig' ? Math.pow(10, g.gainOriginalDb / 20) : 0,
      ctx.currentTime,
    );
    gainProcRef.current.gain.setValueAtTime(
      side === 'proc' ? Math.pow(10, g.gainProcessedDb / 20) : 0,
      ctx.currentTime,
    );
    const srcO = ctx.createBufferSource();
    srcO.buffer = origBufRef.current;
    srcO.connect(gainOrigRef.current);
    const srcP = ctx.createBufferSource();
    srcP.buffer = procBufRef.current;
    srcP.connect(gainProcRef.current);
    srcO.start(0, offset);
    srcP.start(0, offset);
    sourcesRef.current = [srcO, srcP];
    startedAtRef.current = ctx.currentTime;
    offsetRef.current = offset;
    playingRef.current = side;
    setPlaying(side);
    setPlayOffset(offset);
  }

  async function togglePlay(): Promise<void> {
    const ctx = ensureCtx();
    await ctx.resume();
    if (playingRef.current) {
      offsetRef.current = currentOffset();
      stopSources();
      playingRef.current = null;
      setPlaying(null);
      setPlayOffset(offsetRef.current);
      return;
    }
    startBoth(offsetRef.current, 'proc');
  }

  function switchSide(side: Exclude<PlayingSide, null>): void {
    const ctx = ctxRef.current;
    if (!ctx || !playingRef.current || !gainOrigRef.current || !gainProcRef.current) {
      startBoth(offsetRef.current, side);
      return;
    }
    const offset = currentOffset();
    const g = ab ?? { gainOriginalDb: 0, gainProcessedDb: 0, diffLu: 0 };
    const t = ctx.currentTime;
    gainOrigRef.current.gain.setTargetAtTime(
      side === 'orig' ? Math.pow(10, g.gainOriginalDb / 20) : 0,
      t,
      0.005,
    );
    gainProcRef.current.gain.setTargetAtTime(
      side === 'proc' ? Math.pow(10, g.gainProcessedDb / 20) : 0,
      t,
      0.005,
    );
    offsetRef.current = offset;
    startedAtRef.current = t;
    playingRef.current = side;
    setPlaying(side);
  }

  function seek(sec: number): void {
    const wasPlaying = playingRef.current;
    offsetRef.current = sec;
    setPlayOffset(sec);
    setNowSec(sec);
    if (wasPlaying) {
      stopSources();
      startBoth(sec, wasPlaying);
    }
  }

  // 播放进度显示（250 ms 一跳，避免高频重渲染）
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (playingRef.current) {
        const off = currentOffset();
        setNowSec(off);
        if (off >= durationSec - 0.05) {
          offsetRef.current = 0;
          stopSources();
          playingRef.current = null;
          setPlaying(null);
          setPlayOffset(0);
          setNowSec(0);
        }
      }
    }, 250);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durationSec]);

  // 键盘：空格播放/暂停，A/B 切换
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        void togglePlay();
      } else if (e.key === 'a' || e.key === 'A') {
        switchSide('orig');
      } else if (e.key === 'b' || e.key === 'B') {
        switchSide('proc');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels, processed, ab]);

  // 离开工作台时停掉播放
  useEffect(() => {
    return () => {
      stopSources();
      void ctxRef.current?.close().catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onSelectNoise(start: number, end: number): void {
    setNoiseStart(start);
    setNoiseEnd(end);
    setAutoNoise(false);
  }

  function onAutoNoise(): void {
    if (!channels) return;
    const q = findQuietestWindow(channels, sampleRate);
    setNoiseStart(q.startSec);
    setNoiseEnd(q.endSec);
    setAutoNoise(true);
  }

  function exportWav(): void {
    if (!processed || !meta) return;
    const blob = encodeWav16(processed, sampleRate);
    const base = meta.title.replace(/[\\/:*?"<>|]/g, '').trim() || 'denoised';
    downloadBlob(blob, `${base}-denoised.wav`);
  }

  function exportReport(): void {
    if (!processed || !meta || !metrics || !ab) return;
    const settings: DenoiseSettings = {
      strength,
      noiseStartSec: noiseStart,
      noiseEndSec: noiseEnd,
      highpassHz: HIGHPASS_HZ,
      autoNoise,
    };
    downloadJson(
      buildReport(meta, settings, metrics, {
        gainOriginalDb: ab.gainOriginalDb,
        gainProcessedDb: ab.gainProcessedDb,
        loudnessDiffLu: ab.diffLu,
      }),
      `${meta.id}-denoise-report.json`,
    );
  }

  async function onTitleBlur(): Promise<void> {
    if (!meta || title === meta.title) return;
    await updateRecordingMeta(meta.id, { title });
    setMeta({ ...meta, title });
  }

  if (loading) return <div className="card">{copy.workbench.loading}</div>;
  if (loadError || !meta || !channels) {
    return (
      <div className="card" role="alert">
        <p>{loadError || copy.workbench.noRecording}</p>
      </div>
    );
  }

  return (
    <div>
      <section className="card" aria-label="当前录音">
        <label>
          标题
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => void onTitleBlur()}
          />
        </label>
        <p className="muted">
          {formatTime(durationSec)} · {sampleRate} Hz · {channels.length} 声道
        </p>
      </section>

      <section className="card" aria-label="波形与噪声学习">
        <h2>{copy.workbench.noiseLabel}</h2>
        <p>{copy.workbench.noiseHint}</p>
        <Waveform
          peaks={peaks}
          durationSec={durationSec}
          noiseStartSec={noiseStart}
          noiseEndSec={noiseEnd}
          onSelect={onSelectNoise}
        />
        <p className="muted">
          学习段：{noiseStart.toFixed(1)}–{noiseEnd.toFixed(1)} 秒
          {autoNoise ? '（自动取最安静处）' : '（手动框选）'}
        </p>
        <button type="button" className="ghost" onClick={onAutoNoise}>
          {copy.workbench.autoNoise}
        </button>
      </section>

      <section className="card" aria-label="降噪强度">
        <label htmlFor="strength">
          {copy.workbench.strengthLabel}：{Math.round(strength * 100)}%
        </label>
        <input
          id="strength"
          type="range"
          min={0}
          max={100}
          value={Math.round(strength * 100)}
          aria-label={copy.workbench.strengthLabel}
          onChange={(e) => setStrength(Number(e.target.value) / 100)}
        />
        {processing && (
          <div>
            <p aria-live="polite">{copy.workbench.processing}</p>
            <div className="progress">
              <div style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          </div>
        )}
        {!processing && processed && <p className="muted">降噪完成，强度 {Math.round(strength * 100)}%。</p>}
      </section>

      <section className="card" aria-label="试听对比">
        <div className="player-row" role="group" aria-label="原声与降噪后切换">
          <button
            type="button"
            className="ghost"
            aria-pressed={playing === 'orig'}
            onClick={() => {
              if (playing === 'orig') void togglePlay();
              else if (playing) switchSide('orig');
              else startBoth(playOffset, 'orig');
            }}
          >
            {copy.workbench.original}
          </button>
          <button
            type="button"
            className="ghost"
            aria-pressed={playing === 'proc'}
            onClick={() => {
              if (playing === 'proc') void togglePlay();
              else if (playing) switchSide('proc');
              else startBoth(playOffset, 'proc');
            }}
          >
            {copy.workbench.processed}
          </button>
          <button type="button" className="primary" onClick={() => void togglePlay()}>
            {playing ? '暂停' : '播放'}
          </button>
          <span className="muted">
            {formatTime(playing ? nowSec : playOffset)} / {formatTime(durationSec)} ·{' '}
            {copy.workbench.sameVolumeNote}
          </span>
        </div>
        <label htmlFor="seek">播放位置</label>
        <input
          id="seek"
          type="range"
          min={0}
          max={Math.max(1, Math.floor(durationSec))}
          step={0.1}
          value={playing ? nowSec : playOffset}
          aria-label="播放位置"
          onChange={(e) => seek(Number(e.target.value))}
        />
        {ab && (
          <p className="muted">
            同响度后差值 {ab.diffLu.toFixed(2)} LU（目标 &lt;0.2 LU）
          </p>
        )}
      </section>

      <details className="card">
        <summary>{copy.workbench.detailsTitle}</summary>
        {metrics && (
          <dl className="metrics">
            <div>
              <dt>{copy.workbench.metrics.noiseFloor}</dt>
              <dd>
                {metrics.noiseFloorBeforeDb.toFixed(1)} → {metrics.noiseFloorAfterDb.toFixed(1)} dBFS
              </dd>
            </div>
            <div>
              <dt>{copy.workbench.metrics.snrChange}</dt>
              <dd>{metrics.snrChangeDb >= 0 ? '+' : ''}{metrics.snrChangeDb.toFixed(1)} dB</dd>
            </div>
            <div>
              <dt>{copy.workbench.metrics.spectralDistance}</dt>
              <dd>{metrics.spectralDistanceDb.toFixed(2)} dB</dd>
            </div>
            <div>
              <dt>{copy.workbench.metrics.truePeak}</dt>
              <dd>
                {metrics.truePeakBeforeDbTp.toFixed(1)} → {metrics.truePeakAfterDbTp.toFixed(1)} dBTP（估算）
              </dd>
            </div>
            <div>
              <dt>{copy.workbench.metrics.clipped}</dt>
              <dd>
                {metrics.clippedBefore} → {metrics.clippedAfter}
              </dd>
            </div>
            <div>
              <dt>{copy.workbench.metrics.silence}</dt>
              <dd>
                {metrics.silenceOk
                  ? copy.workbench.metrics.silenceOk
                  : copy.workbench.metrics.silenceBad}
                （{metrics.silenceMaxDb.toFixed(1)} dBFS）
              </dd>
            </div>
          </dl>
        )}
        {metrics && metrics.clippedAfter > metrics.clippedBefore && (
          <p className="error">{copy.workbench.warnClipped}</p>
        )}
        {metrics && !metrics.silenceOk && (
          <p className="error">{copy.workbench.warnSilence}</p>
        )}
        {metrics && metrics.spectralDistanceDb > 3 && (
          <p className="error">{copy.workbench.warnSpectral}</p>
        )}
      </details>

      <section className="card" aria-label="导出">
        <h2>导出</h2>
        <div className="player-row">
          <button type="button" className="primary" disabled={!processed} onClick={exportWav}>
            {copy.workbench.exportWav}
          </button>
          <button type="button" className="ghost" disabled={!processed || !metrics} onClick={exportReport}>
            {copy.workbench.exportReport}
          </button>
        </div>
        <p className="muted">WAV 为 44.1 kHz、16-bit，可直接上传 Audio Lab。</p>
      </section>

      <section className="card" aria-label="诚实说明">
        <h2>{copy.workbench.honestTitle}</h2>
        <p>{copy.workbench.honestBody}</p>
      </section>
    </div>
  );
}
