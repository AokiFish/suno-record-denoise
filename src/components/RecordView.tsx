import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  CAPTURE_STATE_COPY,
  decodeBlob,
  detectCaptureState,
  sourceLabel,
  startMicCapture,
  startTabCapture,
  type ActiveRecording,
  type CaptureState,
} from '../audio/capture';
import { newRecordingId, saveRecording } from '../audio/db';
import { validateDuration, validateUploadFile } from '../audio/validate';
import type { RecordingMeta, RecordingSource } from '../audio/types';
import { copy } from '../copy.zh';

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function RecordView(props: {
  onSaved: (id: string) => void;
  onStatus: (msg: string) => void;
}): ReactNode {
  const [captureState] = useState<CaptureState>(() => detectCaptureState());
  const [active, setActive] = useState<{ kind: RecordingSource; rec: ActiveRecording } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ns, setNs] = useState(true);
  const [ec, setEc] = useState(true);
  const [agc, setAgc] = useState(false);
  const [level, setLevel] = useState(0);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const meterCtxRef = useRef<AudioContext | null>(null);
  const meterRafRef = useRef(0);

  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - started) / 1000));
    }, 500);
    return () => window.clearInterval(timer);
  }, [active]);

  useEffect(() => {
    return () => {
      window.cancelAnimationFrame(meterRafRef.current);
      void meterCtxRef.current?.close().catch(() => undefined);
    };
  }, []);

  const decodeCtx = () => new OfflineAudioContext(1, 1, 44100);

  async function saveBlob(blob: Blob, source: RecordingSource): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const decoded = await decodeBlob(blob, decodeCtx());
      const dur = validateDuration(decoded.durationSec);
      if (!dur.ok) {
        setError(copy.record.errTooLong);
        return;
      }
      const meta: RecordingMeta = {
        id: newRecordingId(),
        title: `${sourceLabel(source)} ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        createdAt: Date.now(),
        source,
        durationSec: decoded.durationSec,
        sampleRate: decoded.sampleRate,
        channels: decoded.channels.length,
        mimeType: blob.type || 'audio/webm',
        sizeBytes: blob.size,
        settings: null,
        metrics: null,
      };
      await saveRecording(meta, blob);
      props.onStatus(copy.record.saved);
      props.onSaved(meta.id);
    } catch {
      setError(copy.record.errDecode);
    } finally {
      setBusy(false);
    }
  }

  async function startTab(): Promise<void> {
    setError('');
    try {
      const rec = await startTabCapture();
      setElapsed(0);
      setActive({ kind: 'tab', rec });
    } catch (e) {
      if (e instanceof Error && e.message === 'NO_AUDIO_TRACK') {
        setError(copy.record.errNoAudioTrack);
      } else if (e instanceof DOMException && e.name === 'NotAllowedError') {
        setError(copy.record.errCaptureDenied);
      } else {
        setError(copy.record.errGeneric);
      }
    }
  }

  async function startMic(): Promise<void> {
    setError('');
    try {
      const rec = await startMicCapture({
        noiseSuppression: ns,
        echoCancellation: ec,
        autoGainControl: agc,
      });
      const ctx = new AudioContext();
      meterCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(rec.stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        setLevel(Math.min(1, Math.sqrt(sum / data.length) * 3));
        meterRafRef.current = requestAnimationFrame(tick);
      };
      tick();
      setElapsed(0);
      setActive({ kind: 'mic', rec });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'NotAllowedError') {
        setError(copy.record.errMicDenied);
      } else {
        setError(copy.record.errGeneric);
      }
    }
  }

  async function stopActive(): Promise<void> {
    if (!active) return;
    const { kind, rec } = active;
    setActive(null);
    window.cancelAnimationFrame(meterRafRef.current);
    setLevel(0);
    void meterCtxRef.current?.close().catch(() => undefined);
    meterCtxRef.current = null;
    const blob = await rec.stop();
    if (blob.size === 0) {
      setError(copy.record.errGeneric);
      return;
    }
    await saveBlob(blob, kind);
  }

  async function onUploadFile(file: File): Promise<void> {
    setError('');
    const check = validateUploadFile(file.name, file.size);
    if (!check.ok) {
      setError(check.code === 'FILE_TOO_LARGE' ? copy.record.errTooLarge : copy.record.errFormat);
      return;
    }
    await saveBlob(file, 'upload');
  }

  const recording = active !== null;
  return (
    <div>
      <section className="card" aria-labelledby="tab-title">
        <h2 id="tab-title">{copy.record.tabTitle}</h2>
        <p>{copy.record.tabHint}</p>
        <div
          className={`notice ${captureState === 'available' ? 'ok' : 'warn'}`}
          role="status"
        >
          {CAPTURE_STATE_COPY[captureState]}
        </div>
        {recording && active.kind === 'tab' && (
          <p aria-live="polite">
            {copy.record.tabRecording} {formatElapsed(elapsed)}
          </p>
        )}
        {!recording && (
          <button
            type="button"
            className="primary"
            disabled={captureState !== 'available' || busy}
            onClick={() => void startTab()}
          >
            {copy.record.tabButton}
          </button>
        )}
        {recording && active.kind === 'tab' && (
          <button type="button" className="primary" disabled={busy} onClick={() => void stopActive()}>
            {copy.record.tabStop}（{formatElapsed(elapsed)}）
          </button>
        )}
      </section>

      <section className="card" aria-labelledby="mic-title">
        <h2 id="mic-title">{copy.record.micTitle}</h2>
        <p>{copy.record.micHint}</p>
        <label>
          <input type="checkbox" checked={ns} onChange={(e) => setNs(e.target.checked)} />
          {copy.record.nsLabel}
        </label>
        <label>
          <input type="checkbox" checked={ec} onChange={(e) => setEc(e.target.checked)} />
          {copy.record.ecLabel}
        </label>
        <label>
          <input type="checkbox" checked={agc} onChange={(e) => setAgc(e.target.checked)} />
          {copy.record.agcLabel}
        </label>
        {recording && active.kind === 'mic' && (
          <div className="progress" aria-label="输入电平">
            <div style={{ width: `${Math.round(level * 100)}%` }} />
          </div>
        )}
        {!recording && (
          <button type="button" className="primary" disabled={busy} onClick={() => void startMic()}>
            {copy.record.micButton}
          </button>
        )}
        {recording && active.kind === 'mic' && (
          <button type="button" className="primary" disabled={busy} onClick={() => void stopActive()}>
            {copy.record.micStop}（{formatElapsed(elapsed)}）
          </button>
        )}
      </section>

      <section className="card" aria-labelledby="upload-title">
        <h2 id="upload-title">{copy.record.uploadTitle}</h2>
        <p>{copy.record.uploadHint}</p>
        <input
          ref={fileRef}
          type="file"
          accept=".wav,.mp3,.flac,.m4a,audio/wav,audio/mpeg,audio/flac,audio/mp4"
          aria-label={copy.record.uploadButton}
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void onUploadFile(file);
            e.target.value = '';
          }}
        />
      </section>

      {busy && <p aria-live="polite">{copy.record.saving}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p className="muted">已保存的录音在“录音库”里，随时打开再降噪。</p>
    </div>
  );
}
