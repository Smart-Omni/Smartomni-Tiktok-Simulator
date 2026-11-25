import type { DemoSession } from './types';

export type { DemoSession };

/** sessionStorage key shared by the legacy pages and the new AuthProvider. */
export const sessionKey = (role: string) => `sim.demo-session.${role}`;
/** Fired on window when a legacy page signs in or out, so AuthProvider can pick the change up. */
export const SESSION_CHANGED = 'sim:demo-session-changed';
/** Fired on window by api() when a request made with a demo session gets 401; `detail` is the session token. */
export const SESSION_EXPIRED = 'sim:demo-session-expired';

export function load(role: string): DemoSession | null {
  try {
    const raw = sessionStorage.getItem(sessionKey(role));
    return raw ? (JSON.parse(raw) as DemoSession) : null;
  } catch {
    return null;
  }
}

/**
 * Stores or drops the tab's session for a role (sessionStorage; not a TikTok or SmartOmni credential). A seller
 * session is also shared browser-wide, because SmartOmni may open the consent page in another tab.
 */
export function saveSession(role: 'SELLER' | 'BUYER', s: DemoSession | null) {
  const previous = load(role);
  try {
    if (s) sessionStorage.setItem(sessionKey(role), JSON.stringify(s));
    else sessionStorage.removeItem(sessionKey(role));
  } catch {
    /* storage unavailable: keep in memory only */
  }
  if (role !== 'SELLER') return;
  if (s) {
    try {
      localStorage.setItem(sessionKey(role), JSON.stringify(s));
    } catch {
      /* storage unavailable: the consent page cannot see the sign-in */
    }
  } else if (previous) forgetSharedSeller(previous.sessionToken);
}

/** The seller signed in last in this browser and not signed out since: the only account that may authorize an app. */
export function sharedSeller(): DemoSession | null {
  try {
    const raw = localStorage.getItem(sessionKey('SELLER'));
    const s = raw ? (JSON.parse(raw) as DemoSession) : null;
    return s && new Date(s.expiresAt).getTime() > Date.now() ? s : null;
  } catch {
    return null;
  }
}

/** Drops the shared seller sign-in only if it is `token`, so another account signed in since stays. */
export function forgetSharedSeller(token: string) {
  try {
    if (sharedSeller()?.sessionToken === token) localStorage.removeItem(sessionKey('SELLER'));
  } catch {
    /* storage unavailable */
  }
}
