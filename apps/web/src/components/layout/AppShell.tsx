import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { LogOut, Menu, Moon, Sun, X } from 'lucide-react';
import { useMe, useSignOut } from '@/lib/auth';
import { cn } from '@/lib/cn';

export interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
  badge?: ReactNode;
}

export function useTheme() {
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem('ssn.theme');
    return saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  });
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('ssn.theme', dark ? 'dark' : 'light');
  }, [dark]);
  return { dark, toggle: () => setDark((d) => !d) };
}

export function Logo({ subtitle }: { subtitle?: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <svg viewBox="0 0 32 32" className="size-7 shrink-0" aria-hidden>
        <rect width="32" height="32" rx="7" className="fill-accent" />
        <rect x="7" y="9" width="18" height="11" rx="1.5" fill="none" className="stroke-accent-ink" strokeWidth="2" />
        <path d="M13 24h6" className="stroke-accent-ink" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <div className="leading-tight">
        <div className="text-[13px] font-semibold">Silva Signage Network</div>
        {subtitle && <div className="text-[11px] text-muted">{subtitle}</div>}
      </div>
    </div>
  );
}

export function AppShell({ nav, subtitle, header }: { nav: Array<{ group?: string; items: NavItem[] }>; subtitle: string; header?: ReactNode }) {
  const { data: me } = useMe();
  const signOut = useSignOut();
  const { dark, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);

  const sidebar = (
    <nav className="flex h-full flex-col" aria-label="Main">
      <div className="px-4 pt-4 pb-5">
        <Logo subtitle={subtitle} />
      </div>
      {header && <div className="px-3 pb-3">{header}</div>}
      <div className="flex-1 space-y-5 overflow-y-auto px-3">
        {nav.map((g, i) => (
          <div key={i}>
            {g.group && <div className="px-2 pb-1.5 text-[11px] font-medium tracking-wide text-muted uppercase">{g.group}</div>}
            <ul className="space-y-0.5">
              {g.items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      cn(
                        'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] font-medium',
                        isActive ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-subtle hover:text-ink',
                      )
                    }
                  >
                    <item.icon className="size-4 shrink-0" />
                    <span className="flex-1">{item.label}</span>
                    {item.badge}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-line p-3">
        <div className="mb-2 truncate px-2 text-xs text-muted" title={me?.user.email}>
          {me?.user.fullName}
          <br />
          <span className="text-[11px]">{me?.user.email}</span>
        </div>
        <div className="flex gap-1">
          <button onClick={toggle} className="flex-1 rounded-md px-2 py-1.5 text-xs text-muted hover:bg-subtle hover:text-ink" aria-label="Toggle dark mode">
            {dark ? <Sun className="mx-auto size-4" /> : <Moon className="mx-auto size-4" />}
          </button>
          <button
            onClick={signOut}
            className="flex flex-[3] items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted hover:bg-subtle hover:text-ink"
          >
            <LogOut className="size-3.5" /> Sign out
          </button>
        </div>
      </div>
    </nav>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[232px_1fr]">
      <aside className="sticky top-0 hidden h-dvh border-r border-line bg-surface lg:block">{sidebar}</aside>
      <div className="flex items-center justify-between border-b border-line bg-surface px-4 py-3 lg:hidden">
        <Logo />
        <button onClick={() => setOpen(true)} aria-label="Open menu" className="rounded p-1.5 hover:bg-subtle">
          <Menu className="size-5" />
        </button>
      </div>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 bg-surface shadow-xl">
            <button onClick={() => setOpen(false)} aria-label="Close menu" className="absolute top-3 right-3 rounded p-1.5 hover:bg-subtle">
              <X className="size-5" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}
      <main className="min-w-0 px-4 py-6 sm:px-8 sm:py-8">
        <div className="mx-auto max-w-6xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
