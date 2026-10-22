import { useQuery } from '@tanstack/react-query';
import {
  BarChart3,
  Bell,
  Building2,
  CreditCard,
  FileClock,
  Layers,
  LayoutDashboard,
  Map,
  Megaphone,
  MonitorPlay,
  Receipt,
  Settings,
  Store,
} from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { api } from '@/lib/api';
import { isSuperAdmin, useMe } from '@/lib/auth';

export function AdminLayout() {
  const { data: me } = useMe();
  const superAdmin = isSuperAdmin(me);
  const pending = useQuery({
    queryKey: ['admin', 'pending-count'],
    queryFn: () => api.get<{ total: number }>('/api/admin/campaigns?status=SUBMITTED,UNDER_REVIEW&pageSize=1'),
    refetchInterval: 60_000,
  });
  const count = pending.data?.total ?? 0;
  return (
    <AppShell
      subtitle={superAdmin ? 'Silva admin' : 'Network operations'}
      nav={[
        {
          items: [
            { to: '/admin', label: 'Overview', icon: LayoutDashboard, end: true },
            { to: '/admin/companies', label: 'Companies', icon: Building2 },
            { to: '/admin/establishments', label: 'Establishments', icon: Store },
            { to: '/admin/screens', label: 'Smart TVs', icon: MonitorPlay },
            {
              to: '/admin/campaigns',
              label: 'Campaigns',
              icon: Megaphone,
              badge: count > 0 ? <span className="tabular rounded-full bg-accent px-1.5 text-[11px] font-semibold text-accent-ink">{count}</span> : undefined,
            },
            { to: '/admin/network', label: 'Advertising network', icon: Layers },
            { to: '/admin/zones', label: 'Geographic zones', icon: Map },
          ],
        },
        {
          group: 'Business',
          items: [
            ...(superAdmin
              ? [
                  { to: '/admin/subscriptions', label: 'Subscriptions', icon: CreditCard },
                  { to: '/admin/billing', label: 'Billing', icon: Receipt },
                ]
              : []),
            { to: '/admin/analytics', label: 'Analytics', icon: BarChart3 },
          ],
        },
        {
          group: 'Operations',
          items: [
            { to: '/admin/alerts', label: 'Alerts', icon: Bell },
            ...(superAdmin ? [{ to: '/admin/audit', label: 'Audit logs', icon: FileClock }] : []),
            { to: '/admin/settings', label: 'Settings', icon: Settings },
          ],
        },
      ]}
    />
  );
}
