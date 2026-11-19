import { SESSION_EXPIRED } from './session';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public requestId?: string,
    /** Domain rule code from a `{code, message}` error body, e.g. coupon_expired or insufficient_stock. */
    public code?: string,
  ) {
    super(message);
  }
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  demoSession?: string;
}

/**
 * Same-origin calls. The test-admin token is added by the reverse proxy (nginx / Vite dev proxy),
 * never by browser code, so it is not part of the bundle.
 */
export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  // FormData (file upload) is sent as is, so the browser sets the multipart boundary itself.
  const form = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  if (opts.body !== undefined && !form) headers['content-type'] = 'application/json';
  if (opts.demoSession) headers['x-demo-session'] = opts.demoSession;
  let res: Response;
  try {
    res = await fetch(path, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : form ? (opts.body as FormData) : JSON.stringify(opts.body) });
  } catch {
    throw new ApiError('Cannot reach the simulator API (is it running?)', 0);
  }
  const requestId = res.headers.get('x-request-id') ?? undefined;
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    // Expired or revoked demo session: SessionExpiryWatcher signs that role out. Test-admin calls never carry one.
    if (res.status === 401 && opts.demoSession && !path.startsWith('/test-admin')) {
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED, { detail: opts.demoSession }));
    }
    const msg = typeof data === 'object' && data && 'message' in data ? String((data as { message: unknown }).message) : `HTTP ${res.status}`;
    const code = typeof data === 'object' && data && 'code' in data ? String((data as { code: unknown }).code) : undefined;
    throw new ApiError(msg, res.status, requestId, code);
  }
  return data as T;
}

export const vnd = (n: number): string => new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(n);
