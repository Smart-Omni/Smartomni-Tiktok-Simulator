import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useAuth } from '@/lib/auth';
import { saveSession, SESSION_CHANGED, SESSION_EXPIRED } from '@/lib/session';
import type { Role } from '@/lib/types';
import { loginUrl } from './RequireRole';

/**
 * Listens for the 401s that api() reports for demo-session requests: drops that role's session,
 * says so once, and sends the user to sign in again with the current page as `next`.
 */
export function SessionExpiryWatcher() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const handled = useRef(new Set<string>());
  // Latest values for the window listener, which is registered once.
  const latest = useRef({ auth, navigate, location });
  latest.current = { auth, navigate, location };

  useEffect(() => {
    const onExpired = (e: Event) => {
      const token = (e as CustomEvent<string>).detail;
      const { auth, navigate, location } = latest.current;
      const role: Role | undefined = auth.buyer?.sessionToken === token ? 'BUYER' : auth.seller?.sessionToken === token ? 'SELLER' : undefined;
      if (!role || handled.current.has(token)) return;
      handled.current.add(token);
      saveSession(role, null);
      window.dispatchEvent(new Event(SESSION_CHANGED));
      toast.error('Your session has expired. Please sign in again.');
      navigate(loginUrl(location.pathname + location.search, role), { replace: true });
    };
    window.addEventListener(SESSION_EXPIRED, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED, onExpired);
  }, []);

  return null;
}
