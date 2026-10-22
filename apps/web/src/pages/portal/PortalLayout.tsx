import { BarChart3, Building2, CreditCard, Image, LayoutDashboard, Megaphone, Settings, Users } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { Select } from '@/components/ui';
import { CompanyProvider, useCompany, useMe } from '@/lib/auth';

function CompanySwitcher() {
  const { data: me } = useMe();
  const { companyId, setCompanyId, companyName } = useCompany();
  if (!me || me.memberships.length < 2) return <div className="rounded-md bg-subtle px-2.5 py-2 text-[13px] font-medium">{companyName}</div>;
  return (
    <Select aria-label="Business" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
      {me.memberships.map((m) => (
        <option key={m.companyId} value={m.companyId}>
          {m.companyName}
        </option>
      ))}
    </Select>
  );
}

export function PortalLayout() {
  return (
    <CompanyProvider>
      <AppShell
        subtitle="Business portal"
        header={<CompanySwitcher />}
        nav={[
          {
            items: [
              { to: '/portal', label: 'Overview', icon: LayoutDashboard, end: true },
              { to: '/portal/campaigns', label: 'Campaigns', icon: Megaphone },
              { to: '/portal/media', label: 'Media library', icon: Image },
              { to: '/portal/establishments', label: 'Establishments & screens', icon: Building2 },
              { to: '/portal/reports', label: 'Reports', icon: BarChart3 },
            ],
          },
          {
            group: 'Account',
            items: [
              { to: '/portal/billing', label: 'Subscription', icon: CreditCard },
              { to: '/portal/team', label: 'Team', icon: Users },
              { to: '/portal/settings', label: 'Settings', icon: Settings },
            ],
          },
        ]}
      />
    </CompanyProvider>
  );
}
