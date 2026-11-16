/**
 * 录制捕获。关键事实（MDN getDisplayMedia）：
 * - 必须传 video（video:false 会直接 TypeError 拒绝）；只取音频轨时，
 *   拿到流后立即停掉视频轨。
 * - 标签页音频只在 Chrome/Edge 捕获；Firefox/Safari 的 getDisplayMedia
 *   不带音频；移动浏览器不支持。
 * - 需要安全上下文（HTTPS）+ 用户手势；每次调用都弹选择器，权限不持久。
 * - Chrome 选择器里选“Chrome 标签页”后左下角有“共享标签页音频”开关，
 *   勾上才有声音；不勾会录成静音，本应用检测到无音频轨时如实提示。
 */
import type { RecordingSource } from './types';

export type CaptureState = 'available' | 'blocked' | 'unsupported';

export function detectCaptureState(): CaptureState {
  if (typeof window === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'unsupported';
  const md = navigator.mediaDevices;
  if (md && typeof md.getDisplayMedia === 'function') return 'available';
  // 接口根本不存在：如果在 iframe 里，就是容器没给 display-capture 权限；
  // 顶层页里不存在，才是浏览器真的不支持。
  if (window.self !== window.top) return 'blocked';
  return 'unsupported';
}

export const CAPTURE_STATE_COPY: Record<CaptureState, string> = {
  available: '可以录制标签页音频：点“开始录制”，在弹窗里选 Suno 标签页并勾选“共享标签页音频”。',
  blocked:
    '当前页面被容器拦住了标签页捕获（iframe 没有 display-capture 权限），录制按钮已禁用。请用顶层页打开本站（Cloudflare Pages 地址直接打开），或改用麦克风录音 / 上传文件。',
  unsupported:
    '当前浏览器不支持标签页音频捕获（需要桌面 Chrome / Edge 的 HTTPS 页面）。请在电脑 Chrome 里打开本站，或改用麦克风录音 / 上传文件。',
};

const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

export function pickRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const t of PREFERRED_MIME_TYPES) {
    try {
      if (MediaRecorder.isTypeSupported(t)) return t;
    } catch {
      // 忽略单个类型探测失败
    }
  }
  return undefined;
}

export interface ActiveRecording {
  stop: () => Promise<Blob>;
  cancel: () => void;
  stream: MediaStream;
  /** 录制 chunk 统计（断点定位用）：MediaRecorder 每 250 ms 吐一个 chunk。 */
  stats: () => { chunkCount: number; totalBytes: number };
}

function recordStream(stream: MediaStream, mimeType: string | undefined): ActiveRecording {
  // 音乐录制：192 kbps，避免默认码率在低声部出现可闻压缩伪影；
  // v1 没设码率，Chrome 默认 opus 码率偏低，是“录音时低声部已卡顿”
  // 的嫌疑点之一（另一点是后台标签页节流，见 RecordView 前台警告）。
  const recorder = new MediaRecorder(
    stream,
    mimeType ? { mimeType, audioBitsPerSecond: 192000 } : { audioBitsPerSecond: 192000 },
  );
  const chunks: Blob[] = [];
  let totalBytes = 0;
  recorder.ondataavailable = (e: BlobEvent) => {
    if (e.data.size > 0) {
      chunks.push(e.data);
      totalBytes += e.data.size;
    }
  };
  let resolveStop: (blob: Blob) => void = () => undefined;
  const stopped = new Promise<Blob>((resolve) => {
    resolveStop = resolve;
  });
  recorder.onstop = () => {
    resolveStop(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
  };
  recorder.start(250);
  return {
    stream,
    stats: () => ({ chunkCount: chunks.length, totalBytes }),
    stop: () => {
      return new Promise<Blob>((resolve) => {
        if (recorder.state === 'inactive') {
          resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
          return;
        }
        const done = stopped.then(resolve);
        recorder.stop();
        return done;
      });
    },
    cancel: () => {
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch {
        // 已停
      }
      for (const track of stream.getTracks()) track.stop();
    },
  };
}

/**
 * 标签页音频录制：只要音频轨，视频轨拿到就停。
 * 返回的 stop() 会同时停掉所有轨道（结束浏览器里的分享提示）。
 * 无音频轨时直接报错（不静默录成静音）。
 */
export async function startTabCapture(): Promise<ActiveRecording> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'browser' } as MediaTrackConstraints,
    audio: true,
  });
  for (const track of stream.getVideoTracks()) track.stop();
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    for (const track of stream.getTracks()) track.stop();
    throw new Error('NO_AUDIO_TRACK');
  }
  const audioOnly = new MediaStream(audioTracks);
  const rec = recordStream(audioOnly, pickRecorderMimeType());
  const originalStop = rec.stop;
  return {
    stream: audioOnly,
    stats: rec.stats,
    cancel: () => {
      rec.cancel();
      for (const track of stream.getTracks()) track.stop();
    },
    stop: async () => {
      const blob = await originalStop();
      for (const track of stream.getTracks()) track.stop();
      return blob;
    },
  };
}

export interface MicOptions {
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
}

/** 麦克风录制：三开关原样传给浏览器（约束是请求不是命令，以浏览器实际为准）。 */
export async function startMicCapture(opts: MicOptions): Promise<ActiveRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      noiseSuppression: opts.noiseSuppression,
      echoCancellation: opts.echoCancellation,
      autoGainControl: opts.autoGainControl,
      sampleRate: 48000,
      channelCount: 2,
    },
    video: false,
  });
  return recordStream(stream, pickRecorderMimeType());
}

/** 把录好的 Blob 解码成各声道 Float32Array（用 AudioContext 解码器）。 */
export async function decodeBlob(
  blob: Blob,
  ctx: BaseAudioContext,
): Promise<{ channels: Float32Array[]; sampleRate: number; durationSec: number }> {
  const buf = await blob.arrayBuffer();
  const audioBuf = await ctx.decodeAudioData(buf);
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < audioBuf.numberOfChannels; ch++) {
    channels.push(audioBuf.getChannelData(ch).slice());
  }
  return { channels, sampleRate: audioBuf.sampleRate, durationSec: audioBuf.duration };
}

export function sourceLabel(source: RecordingSource): string {
  if (source === 'tab') return '标签页录制';
  if (source === 'mic') return '麦克风录制';
  return '上传文件';
}
