import { Component, Suspense, lazy, useState, type ReactNode } from 'react';
import { copy } from './copy.zh';
import RecordView from './components/RecordView';

const Workbench = lazy(() => import('./components/Workbench'));
const Library = lazy(() => import('./components/Library'));

type Tab = 'record' | 'workbench' | 'library';

class ChunkErrorBoundary extends Component<
  { children: ReactNode; onRetry: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="card" role="alert">
          <p>这一页没加载出来。</p>
          <button
            type="button"
            className="primary"
            onClick={() => {
              this.setState({ failed: false });
              this.props.onRetry();
            }}
          >
            重新加载
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App(): ReactNode {
  const [tab, setTab] = useState<Tab>('record');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const openWorkbench = (id: string) => {
    setActiveId(id);
    setTab('workbench');
  };

  return (
    <div className="app">
      <header>
        <h1>{copy.appTitle}</h1>
        <p>{copy.appSubtitle}</p>
      </header>
      <nav className="tabs" aria-label="主导航">
        <button
          type="button"
          aria-selected={tab === 'record'}
          onClick={() => setTab('record')}
        >
          {copy.tabs.record}
        </button>
        <button
          type="button"
          aria-selected={tab === 'workbench'}
          onClick={() => setTab('workbench')}
        >
          {copy.tabs.workbench}
        </button>
        <button
          type="button"
          aria-selected={tab === 'library'}
          onClick={() => setTab('library')}
        >
          {copy.tabs.library}
        </button>
      </nav>
      <div aria-live="polite" className="muted" role="status">
        {status}
      </div>
      <main>
        {tab === 'record' && (
          <RecordView onSaved={openWorkbench} onStatus={setStatus} />
        )}
        {tab === 'workbench' && (
          <ChunkErrorBoundary onRetry={() => setReloadKey((k) => k + 1)}>
            <Suspense fallback={<div className="card">正在打开降噪工作台…</div>}>
              <Workbench key={reloadKey} recordingId={activeId} onStatus={setStatus} />
            </Suspense>
          </ChunkErrorBoundary>
        )}
        {tab === 'library' && (
          <ChunkErrorBoundary onRetry={() => setReloadKey((k) => k + 1)}>
            <Suspense fallback={<div className="card">正在打开录音库…</div>}>
              <Library key={reloadKey} onOpen={openWorkbench} />
            </Suspense>
          </ChunkErrorBoundary>
        )}
      </main>
      <footer>{copy.footer}</footer>
    </div>
  );
}
