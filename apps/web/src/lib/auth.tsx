import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, useLocation } from 'react-router-dom';
import { api, ApiError } from './api';
import { Spinner } from '@/components/ui';

export interface Me {
  user: { id: string; email: string; fullName: string; platformRole: 'SUPER_ADMIN' | 'NETWORK_OPERATOR' | 'NONE'; totpEnabled: boolean };
  mfaVerified: boolean;
  mfaRequired: boolean;
  mfaEnrollmentRequired: boolean;
  memberships: Array<{ companyId: string; role: 'OWNER' | 'STAFF'; companyName: string }>;
}

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.get<Me>('/api/auth/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });
}

export const isSilva = (me: Me | null | undefined) => me?.user.platformRole === 'SUPER_ADMIN' || me?.user.platformRole === 'NETWORK_OPERATOR';
export const isSuperAdmin = (me: Me | null | undefined) => me?.user.platformRole === 'SUPER_ADMIN';

export function useSignOut() {
  const qc = useQueryClient();
  return async () => {
    await api.post('/api/auth/logout').catch(() => {});
    qc.clear();
    window.location.assign('/login');
  };
}

/** Gate for authenticated areas. Sends users through MFA steps before anything else. */
export function RequireAuth({ area, children }: { area: 'admin' | 'portal'; children: ReactNode }) {
  const { data: me, isLoading } = useMe();
  const loc = useLocation();
  if (isLoading) return <Spinner />;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  if (me.mfaRequired) return <Navigate to="/mfa" replace />;
  if (area === 'admin') {
    if (!isSilva(me)) return <Navigate to="/portal" replace />;
    if (me.mfaEnrollmentRequired) return <Navigate to="/mfa/setup" replace />;
  }
  if (area === 'portal' && !isSilva(me) && me.memberships.length === 0) {
    return <div className="p-10 text-sm text-muted">Your account is not linked to a business yet. Contact Silva Solutions.</div>;
  }
  if (area === 'portal' && isSilva(me)) return <Navigate to="/admin" replace />;
  return <>{children}</>;
}

// ---- Active company (portal) ----------------------------------------------------
const CompanyCtx = createContext<{ companyId: string; role: 'OWNER' | 'STAFF'; companyName: string; setCompanyId: (id: string) => void } | null>(null);
const KEY = 'ssn.activeCompany';

export function CompanyProvider({ children }: { children: ReactNode }) {
  const { data: me } = useMe();
  const memberships = me?.memberships ?? [];
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem(KEY));
  const active = memberships.find((m) => m.companyId === selected) ?? memberships[0];
  useEffect(() => {
    if (active) localStorage.setItem(KEY, active.companyId);
  }, [active]);
  const value = useMemo(
    () => (active ? { companyId: active.companyId, role: active.role, companyName: active.companyName, setCompanyId: setSelected } : null),
    [active],
  );
  if (!value) return null;
  return <CompanyCtx.Provider value={value}>{children}</CompanyCtx.Provider>;
}

export function useCompany() {
  const v = useContext(CompanyCtx);
  if (!v) throw new Error('useCompany outside CompanyProvider');
  return { ...v, isOwner: v.role === 'OWNER', base: `/api/companies/${v.companyId}` };
}
