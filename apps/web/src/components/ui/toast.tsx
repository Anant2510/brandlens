'use client';

import * as React from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: string;
  title: string;
  description?: string;
  tone: ToastTone;
  durationMs: number;
}

interface ToastContextValue {
  toast: (input: { title: string; description?: string; tone?: ToastTone; durationMs?: number }) => string;
  dismiss: (id: string) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const context = React.useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const timers = React.useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = React.useCallback((id: string) => {
    setToasts((current) => current.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = React.useCallback<ToastContextValue['toast']>(
    ({ title, description, tone = 'info', durationMs = tone === 'error' ? 8000 : 4500 }) => {
      const id = Math.random().toString(36).slice(2);
      setToasts((current) => [...current.slice(-3), { id, title, description, tone, durationMs }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), durationMs),
      );
      return id;
    },
    [dismiss],
  );

  React.useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((timer) => clearTimeout(timer));
      map.clear();
    };
  }, []);

  const value = React.useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2"
        role="region"
        aria-label="Notifications"
      >
        {toasts.map((item) => (
          <ToastCard key={item.id} toast={item} onDismiss={() => dismiss(item.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const TONE_STYLE: Record<ToastTone, { icon: typeof Info; className: string }> = {
  info: { icon: Info, className: 'text-accent' },
  success: { icon: CheckCircle2, className: 'text-[var(--ok)]' },
  warning: { icon: AlertTriangle, className: 'text-[var(--warn)]' },
  error: { icon: XCircle, className: 'text-[var(--danger)]' },
};

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const { icon: Icon, className } = TONE_STYLE[toast.tone];
  return (
    <div
      role={toast.tone === 'error' ? 'alert' : 'status'}
      aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
      className="pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border bg-surface p-3 shadow-lg animate-slide-up"
    >
      <Icon className={cn('size-4 shrink-0 mt-0.5', className)} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-fg">{toast.title}</p>
        {toast.description ? <p className="mt-0.5 text-xs text-fg-muted break-words">{toast.description}</p> : null}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="shrink-0 rounded p-0.5 text-fg-subtle hover:bg-surface-2 hover:text-fg transition-colors"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
