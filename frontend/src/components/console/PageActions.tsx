import { useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Keep each panel's handlers in place while presenting its actions beside the page title. */
export function PageActions({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { setHost(document.getElementById('admin-page-actions')); }, []);
  return host ? createPortal(children, host) : <div className="admin-inline-actions">{children}</div>;
}
