import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { api, errorMessage } from '@/lib/api';
import { isSilva, useMe, useSignOut, type Me } from '@/lib/auth';
import { Button, Field, Input, Notice, Spinner } from '@/components/ui';
import { Logo } from '@/components/layout/AppShell';

function AuthCard({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Logo subtitle="Silva Solutions Ltd" />
        </div>
        <div className="rounded-xl border border-line bg-surface p-6 shadow-sm">
          <h1 className="text-lg font-semibold">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </div>
      </div>
    </div>
  );
}

const homeFor = (me: Me) => (isSilva(me) ? '/admin' : '/portal');

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const { data: me } = useMe();

  useEffect(() => {
    if (me && !me.mfaRequired) nav(homeFor(me), { replace: true });
  }, [me, nav]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ mfaRequired: boolean }>('/api/auth/login', { email, password });
      await qc.invalidateQueries({ queryKey: ['me'] });
      const next = params.get('next');
      if (res.mfaRequired) nav('/mfa' + (next ? `?next=${encodeURIComponent(next)}` : ''));
      else {
        const fresh = await qc.fetchQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/api/auth/me') });
        nav(next && next.startsWith('/') ? next : homeFor(fresh));
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Sign in" subtitle="Manage your screens, campaigns and network adverts.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <Notice tone="bad">{error}</Notice>}
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" className="w-full" loading={busy}>
          Sign in
        </Button>
      </form>
      <p className="mt-5 text-xs text-muted">Accounts are created by Silva Solutions. Contact us if you need access.</p>
    </AuthCard>
  );
}

export function MfaVerifyPage() {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const signOut = useSignOut();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/mfa/verify', { code });
      const me = await qc.fetchQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/api/auth/me') });
      const next = params.get('next');
      nav(next && next.startsWith('/') ? next : homeFor(me), { replace: true });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Two-factor verification" subtitle="Enter the 6-digit code from your authenticator app.">
      <form onSubmit={submit} className="space-y-4">
        {error && <Notice tone="bad">{error}</Notice>}
        <Field label="Code" htmlFor="code">
          <Input
            id="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            pattern="\d{6}"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            autoFocus
            className="tabular text-center text-lg tracking-[0.4em]"
          />
        </Field>
        <Button type="submit" className="w-full" loading={busy} disabled={code.length !== 6}>
          Verify
        </Button>
        <button type="button" onClick={signOut} className="w-full text-center text-xs text-muted hover:text-ink">
          Use a different account
        </button>
      </form>
    </AuthCard>
  );
}

export function MfaEnrol({ onDone }: { onDone: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start() {
    setError(null);
    try {
      const s = await api.post<{ secret: string; otpauthUri: string }>('/api/auth/mfa/setup');
      setSetup({ ...s, qr: await QRCode.toDataURL(s.otpauthUri, { margin: 1, width: 200 }) });
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function enable(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/mfa/enable', { code });
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (!setup) {
    return (
      <div className="space-y-4">
        {error && <Notice tone="bad">{error}</Notice>}
        <p className="text-sm text-muted">You'll need an authenticator app such as Microsoft Authenticator, Google Authenticator or 1Password.</p>
        <Button onClick={start}>Set up two-factor authentication</Button>
      </div>
    );
  }
  return (
    <form onSubmit={enable} className="space-y-4">
      {error && <Notice tone="bad">{error}</Notice>}
      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
        <li>Scan this code with your authenticator app.</li>
        <li>Enter the 6-digit code it shows.</li>
      </ol>
      <img src={setup.qr} alt="QR code for your authenticator app" className="mx-auto rounded border border-line bg-white p-1" width={200} height={200} />
      <details className="text-xs text-muted">
        <summary className="cursor-pointer">Can't scan? Enter the key manually</summary>
        <code className="mt-2 block rounded bg-subtle p-2 font-mono break-all text-ink">{setup.secret}</code>
      </details>
      <Field label="Code" htmlFor="enrol-code">
        <Input
          id="enrol-code"
          inputMode="numeric"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          className="tabular text-center tracking-[0.3em]"
        />
      </Field>
      <Button type="submit" loading={busy} disabled={code.length !== 6} className="w-full">
        Turn on two-factor authentication
      </Button>
    </form>
  );
}

export function MfaSetupPage() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { data: me, isLoading } = useMe();
  if (isLoading) return <Spinner />;
  if (!me) return null;
  return (
    <AuthCard title="Protect your admin account" subtitle="Silva administrators must use two-factor authentication.">
      <MfaEnrol
        onDone={async () => {
          await qc.invalidateQueries({ queryKey: ['me'] });
          nav('/admin', { replace: true });
        }}
      />
    </AuthCard>
  );
}
