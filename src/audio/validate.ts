export const MAX_FILE_BYTES = 80 * 1024 * 1024; // 80 MB
export const MAX_DURATION_SEC = 600; // 10 分钟
const ALLOWED_EXTS = new Set(['wav', 'mp3', 'flac', 'm4a']);

export type UploadErrorCode = 'UNSUPPORTED_FORMAT' | 'FILE_TOO_LARGE' | 'DURATION_TOO_LONG';

export function validateUploadFile(
  fileName: string,
  sizeBytes: number,
): { ok: true } | { ok: false; code: UploadErrorCode } {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  if (!ALLOWED_EXTS.has(ext)) return { ok: false, code: 'UNSUPPORTED_FORMAT' };
  if (sizeBytes > MAX_FILE_BYTES) return { ok: false, code: 'FILE_TOO_LARGE' };
  return { ok: true };
}

/** 解码后按真实时长校验（浏览器里 decodeAudioData 之后调用）。 */
export function validateDuration(
  durationSec: number,
): { ok: true } | { ok: false; code: UploadErrorCode } {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return { ok: false, code: 'UNSUPPORTED_FORMAT' };
  }
  if (durationSec > MAX_DURATION_SEC) return { ok: false, code: 'DURATION_TOO_LONG' };
  return { ok: true };
}
