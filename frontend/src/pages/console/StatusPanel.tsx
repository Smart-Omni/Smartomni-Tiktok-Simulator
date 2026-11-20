import { useState } from 'react';
import { AsyncState } from '../../components/AsyncState';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';

interface Status {
  service: string;
  database: { status: string; name: string };
  worker: { enabled: boolean; running: boolean; workerId: string; lastTickAt: string | null; lastError: string | null };
  webhookJobs: Record<string, number>;
  clock: { now: string; systemNow: string; offsetMs: number; frozen: boolean };
  seed: Record<string, number> | null;
  publicApiBaseUrl: string;
  hostCallbackBaseUrl: string;
}

export function StatusPanel({ onSeeded }: { onSeeded: () => void }) {
  const status = useAsync(() => api<Status>('/test-admin/status'), [], 5000);
  const [msg, setMsg] = useState<string>();
  const seed = async () => {
    setMsg('Seeding...');
    try {
      await api('/test-admin/seed', { method: 'POST' });
      setMsg('Seed applied (idempotent).');
      status.reload();
      onSeeded();
    } catch (e) {
      setMsg(`Seed failed: ${(e as Error).message}`);
    }
  };
  return (
    <AsyncState {...status} onRetry={status.reload}>
      {(s) => (
        <div>
          <div className="grid admin-health-grid">
            <div className="card"><h3>Database</h3><span className={`pill ${s.database.status === 'up' ? 'ok' : 'bad'}`}>{s.database.status}</span> <span className="muted">{s.database.name}</span></div>
            <div className="card">
              <h3>Webhook worker</h3>
              <span className={`pill ${s.worker.running ? 'ok' : 'warn'}`}>{s.worker.running ? 'running' : s.worker.enabled ? 'stopped' : 'disabled'}</span>
              <div className="muted">{s.worker.workerId}</div>
              {s.worker.lastError ? <div className="muted">last error: {s.worker.lastError}</div> : null}
            </div>
            <div className="card"><h3>Business clock</h3>{s.clock.now}<div className="muted">{s.clock.frozen ? 'frozen' : `offset ${s.clock.offsetMs} ms`}</div></div>
            <div className="card"><h3>Webhook jobs</h3>{Object.keys(s.webhookJobs).length === 0 ? <span className="muted">none</span> : Object.entries(s.webhookJobs).map(([k, v]) => <div key={k}>{k}: {v}</div>)}</div>
          </div>
          <div className="card">
            <h3>Seed data</h3>
            {s.seed ? <dl className="admin-seed-counts">{Object.entries(s.seed).map(([label, count]) => <div key={label}><dt>{label}</dt><dd>{count.toLocaleString()}</dd></div>)}</dl> : <span className="muted">unavailable</span>}
            <div><button onClick={seed}>Run seed (idempotent)</button> {msg ? <span className="muted">{msg}</span> : null}</div>
          </div>
          <div className="card muted">API base: {s.publicApiBaseUrl} / callback host: {s.hostCallbackBaseUrl}</div>
        </div>
      )}
    </AsyncState>
  );
}
