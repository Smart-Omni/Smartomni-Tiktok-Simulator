import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createSession, endSession, switchSessionShop } from './endpoints';
import { load, saveSession, SESSION_CHANGED } from './session';
import type { DemoSession, Role, SignInIdentity } from './types';

/**
 * Demo sign-in state. One session per role and tab, stored under `sim.demo-session.{ROLE}` (see `session.ts`).
 * Not a TikTok or SmartOmni login.
 */
export interface AuthValue {
  buyer: DemoSession | null;
  seller: DemoSession | null;
  session: (role: Role) => DemoSession | null;
  signIn: (identity: SignInIdentity) => Promise<DemoSession>;
  signOut: (role: Role) => Promise<void>;
  /** Moves the signed-in seller to another of their shops. */
  switchShop: (shopId: string) => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

const isExpired = (s: DemoSession) => new Date(s.expiresAt).getTime() <= Date.now();

function loadValid(role: Role): DemoSession | null {
  const s = load(role);
  if (s && isExpired(s)) {
    saveSession(role, null);
    return null;
  }
  return s;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<Record<Role, DemoSession | null>>(() => ({
    BUYER: loadValid('BUYER'),
    SELLER: loadValid('SELLER'),
  }));

  useEffect(() => {
    const reload = () => setSessions({ BUYER: loadValid('BUYER'), SELLER: loadValid('SELLER') });
    window.addEventListener(SESSION_CHANGED, reload);
    return () => window.removeEventListener(SESSION_CHANGED, reload);
  }, []);

  const put = useCallback((role: Role, s: DemoSession | null) => {
    saveSession(role, s);
    setSessions((prev) => ({ ...prev, [role]: s }));
  }, []);

  const signIn = useCallback(
    async (identity: SignInIdentity) => {
      const s = await createSession(identity);
      put(s.role, s);
      return s;
    },
    [put],
  );

  const signOut = useCallback(
    async (role: Role) => {
      const s = sessions[role];
      put(role, null);
      if (s) {
        try {
          await endSession(s);
        } catch {
          /* already expired or API down: the local sign-out is what matters */
        }
      }
    },
    [put, sessions],
  );

  const switchShop = useCallback(
    async (shopId: string) => {
      const s = sessions.SELLER;
      if (s) put('SELLER', await switchSessionShop(s, shopId));
    },
    [put, sessions],
  );

  const value = useMemo<AuthValue>(
    () => ({
      buyer: sessions.BUYER,
      seller: sessions.SELLER,
      session: (role) => sessions[role],
      signIn,
      signOut,
      switchShop,
    }),
    [sessions, signIn, signOut, switchShop],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
