import { useEffect, useRef, type ReactNode } from 'react';

interface WaveformProps {
  /** 单声道混合峰值（0..1），每列一个值。 */
  peaks: number[];
  durationSec: number;
  /**
   * 框选噪声段的旧接口：v2 引擎（FFmpeg afftdn）不再采样，全部可选；
   * 不传 onSelect 时只显示波形，不可拖动。
   */
  noiseStartSec?: number;
  noiseEndSec?: number;
  onSelect?: (startSec: number, endSec: number) => void;
}

/** 波形画布：v2 只作显示。 */
export default function Waveform(props: WaveformProps): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{ startX: number; active: boolean }>({ startX: 0, active: false });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = 120;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    const styles = getComputedStyle(canvas);
    const accent = styles.getPropertyValue('--accent').trim() || '#0a7aff';
    // 噪声段底色（v2 不再框选：只有调用方传了起止才画）
    if (
      props.noiseStartSec !== undefined &&
      props.noiseEndSec !== undefined
    ) {
      const x0 = (props.noiseStartSec / props.durationSec) * width;
      const x1 = (props.noiseEndSec / props.durationSec) * width;
      ctx.fillStyle = 'rgba(10, 122, 255, 0.15)';
      ctx.fillRect(x0, 0, Math.max(2, x1 - x0), height);
    }
    // 波形
    ctx.fillStyle = accent;
    const peaks = props.peaks;
    const colW = width / peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const h = Math.max(1, peaks[i] * height * 0.9);
      const x = i * colW;
      ctx.fillRect(x, (height - h) / 2, Math.max(1, colW - 0.5), h);
    }
  }, [props.peaks, props.noiseStartSec, props.noiseEndSec, props.durationSec]);

  const secFromEvent = (e: React.PointerEvent<HTMLCanvasElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    return ratio * props.durationSec;
  };

  return (
    <canvas
      ref={canvasRef}
      className="waveform"
      role="img"
      aria-label="波形图"
      onPointerDown={(e) => {
        if (!props.onSelect) return;
        dragRef.current = { startX: secFromEvent(e), active: true };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!dragRef.current.active || !props.onSelect) return;
        const cur = secFromEvent(e);
        const start = Math.min(dragRef.current.startX, cur);
        const end = Math.max(dragRef.current.startX, cur);
        if (end - start >= 0.2) props.onSelect(start, end);
      }}
      onPointerUp={(e) => {
        if (!dragRef.current.active) return;
        dragRef.current.active = false;
        if (!props.onSelect) return;
        const cur = secFromEvent(e);
        const start = Math.min(dragRef.current.startX, cur);
        const end = Math.max(dragRef.current.startX, cur);
        if (end - start >= 0.2) props.onSelect(start, end);
      }}
    />
  );
}
