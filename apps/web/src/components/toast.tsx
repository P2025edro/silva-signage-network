import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/cn';

type Toast = { id: number; tone: 'ok' | 'bad'; message: string };
const Ctx = createContext<(tone: Toast['tone'], message: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast['tone'], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'bad' ? 7000 : 4000);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto flex items-start gap-2 rounded-lg border bg-surface px-4 py-3 text-sm shadow-lg',
              t.tone === 'ok' ? 'border-ok/30' : 'border-bad/30',
            )}
          >
            {t.tone === 'ok' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" /> : <AlertCircle className="mt-0.5 size-4 shrink-0 text-bad" />}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const push = useContext(Ctx);
  return { ok: (m: string) => push('ok', m), error: (m: string) => push('bad', m) };
}
