/**
 * IndexedDB 录音库。音频 Blob 与元数据分两个 store：
 * - recordings：只有元数据（小字段），列表与计数不拉音频；
 * - audio：id → Blob，打开工作台时才取。
 * 计数用 IDBObjectStore.count()（聚合计数，不拉行）。
 */
import type { RecordingMeta } from './types';

const DB_NAME = 'suno-record-denoise';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('recordings')) {
        const store = db.createObjectStore('recordings', { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('audio')) {
        db.createObjectStore('audio', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(storeNames: string[], mode: IDBTransactionMode, fn: (tx: IDBTransaction) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(storeNames, mode);
        const req = fn(transaction);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        transaction.oncomplete = () => db.close();
        transaction.onerror = () => reject(transaction.error);
      }),
  );
}

export async function countRecordings(): Promise<number> {
  return tx(['recordings'], 'readonly', (t) => t.objectStore('recordings').count());
}

export async function listRecordingMeta(): Promise<RecordingMeta[]> {
  const all = await tx(['recordings'], 'readonly', (t) =>
    t.objectStore('recordings').getAll(),
  );
  return (all as RecordingMeta[]).sort((a, b) => b.createdAt - a.createdAt);
}

export async function getRecordingMeta(id: string): Promise<RecordingMeta | null> {
  const meta = await tx(['recordings'], 'readonly', (t) =>
    t.objectStore('recordings').get(id),
  );
  return (meta as RecordingMeta | undefined) ?? null;
}

export async function getRecordingAudio(id: string): Promise<Blob | null> {
  const row = await tx(['audio'], 'readonly', (t) => t.objectStore('audio').get(id));
  const rec = row as { id: string; blob: Blob } | undefined;
  return rec?.blob ?? null;
}

export async function saveRecording(meta: RecordingMeta, blob: Blob): Promise<void> {
  await tx(['recordings', 'audio'], 'readwrite', (t) => {
    t.objectStore('recordings').put(meta);
    t.objectStore('audio').put({ id: meta.id, blob });
    // 返回最后一次 put 的请求即可；事务完成即代表两边都写了
    return t.objectStore('audio').get(meta.id);
  });
}

export async function updateRecordingMeta(
  id: string,
  patch: Partial<Pick<RecordingMeta, 'title' | 'settings' | 'metrics'>>,
): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('recordings', 'readwrite');
    const store = transaction.objectStore('recordings');
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const meta = getReq.result as RecordingMeta | undefined;
      if (!meta) {
        reject(new Error('NOT_FOUND'));
        return;
      }
      store.put({ ...meta, ...patch });
    };
    getReq.onerror = () => reject(getReq.error);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function deleteRecording(id: string): Promise<void> {
  await tx(['recordings', 'audio'], 'readwrite', (t) => {
    t.objectStore('recordings').delete(id);
    t.objectStore('audio').delete(id);
    return t.objectStore('recordings').get(id);
  });
}

export function newRecordingId(): string {
  return `rec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
