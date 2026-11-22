import type { ReactNode } from 'react';

/** Keep controls inside the panel that owns them. */
export function PageActions({ children }: { children: ReactNode }) {
  return <div className="admin-inline-actions" role="group" aria-label="Panel actions">{children}</div>;
}
