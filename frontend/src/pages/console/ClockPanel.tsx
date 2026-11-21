import { useState } from 'react';
import { AsyncState } from '../../components/AsyncState';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';

interface Clock {
  now: string;
  systemNow: string;
  offsetMs: number;
  frozen: boolean;
}

export function ClockPanel() {
  const clock = useAsync(() => api<Clock>('/test-admin/clock'), [], 3000);
  const [target, setTarget] = useState('');
  const [freeze, setFreeze] = useState(false);
  const [msg, setMsg] = useState<string>();
  const put = async (body: unknown) => {
    try {
      await api('/test-admin/clock', { method: 'PUT', body });
      setMsg(undefined);
      clock.reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <AsyncState {...clock} onRetry={clock.reload}>
      {(c) => (
        <div className="card admin-clock-card">
          <p>Now: <code>{c.now}</code> {c.frozen ? <span className="pill warn">frozen</span> : null}</p>
          <p className="muted">System time: {c.systemNow}</p>
          {msg ? <div className="state state-error" role="alert">{msg}</div> : null}
          <div className="row-wrap">
            {[['+1 hour', 3_600_000], ['+1 day', 86_400_000], ['+7 days', 604_800_000]].map(([label, ms]) => (
              <button key={String(label)} onClick={() => put({ advanceMs: ms })}>{label}</button>
            ))}
            <button onClick={() => put({ reset: true })}>Reset to real time</button>
          </div>
          <div className="admin-log-filters admin-clock-form">
            <label>Set to <input type="datetime-local" value={target} onChange={(e) => setTarget(e.target.value)} /></label>
            <label className="admin-check"><input type="checkbox" checked={freeze} onChange={(e) => setFreeze(e.target.checked)} /> freeze</label>
            <button className="admin-primary" disabled={!target} onClick={() => put({ setTo: new Date(target).toISOString(), freeze })}>Apply</button>
          </div>
        </div>
      )}
    </AsyncState>
  );
}
