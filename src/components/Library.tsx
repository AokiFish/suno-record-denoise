import { useEffect, useState, type ReactNode } from 'react';
import { countRecordings, deleteRecording, getRecordingAudio, listRecordingMeta } from '../audio/db';
import { sourceLabel } from '../audio/capture';
import type { RecordingMeta } from '../audio/types';
import { copy } from '../copy.zh';

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function Library(props: { onOpen: (id: string) => void }): ReactNode {
  const [count, setCount] = useState<number | null>(null);
  const [rows, setRows] = useState<RecordingMeta[]>([]);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [listeningId, setListeningId] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState('');

  async function load(): Promise<void> {
    setLoading(true);
    setError(false);
    try {
      const [c, metas] = await Promise.all([countRecordings(), listRecordingMeta()]);
      setCount(c);
      setRows(metas);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function toggleListen(id: string): Promise<void> {
    if (listeningId === id) {
      setListeningId(null);
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      setAudioUrl('');
      return;
    }
    const blob = await getRecordingAudio(id);
    if (!blob) return;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(URL.createObjectURL(blob));
    setListeningId(id);
  }

  async function onDelete(id: string): Promise<void> {
    if (!window.confirm(copy.library.deleteConfirm)) return;
    await deleteRecording(id);
    await load();
  }

  if (loading) return <div className="card">正在打开录音库…</div>;

  if (error) {
    return (
      <div className="card" role="alert">
        <p>{copy.library.loadError}</p>
        <button type="button" className="primary" onClick={() => void load()}>
          {copy.library.retry}
        </button>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>
        {copy.library.title}（{count ?? rows.length} {copy.library.countLabel}）
      </h2>
      {rows.length === 0 && <p>{copy.library.empty}</p>}
      {rows.map((row) => (
        <div className="list-row" key={row.id}>
          <div>
            <strong>{row.title}</strong>
            <div className="muted">
              {sourceLabel(row.source)} · {formatDuration(row.durationSec)} ·{' '}
              {new Date(row.createdAt).toLocaleString('zh-CN', { hour12: false })}
            </div>
          </div>
          <div className="player-row">
            <button type="button" className="ghost" onClick={() => void toggleListen(row.id)}>
              {copy.library.listen}
            </button>
            <button type="button" className="ghost" onClick={() => props.onOpen(row.id)}>
              {copy.library.open}
            </button>
            <button type="button" className="danger" onClick={() => void onDelete(row.id)}>
              {copy.library.delete}
            </button>
          </div>
          {listeningId === row.id && audioUrl && (
            <audio
              controls
              {...({ loading: 'lazy' } as const)}
              preload="metadata"
              src={audioUrl}
            />
          )}
        </div>
      ))}
    </div>
  );
}
