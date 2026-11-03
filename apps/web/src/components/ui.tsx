import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { EmailStatus } from '@reachinbox/contracts';

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost' }) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50';
  const styles = {
    primary: 'bg-blue-600 text-white hover:bg-blue-700',
    secondary: 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50',
    danger: 'border border-red-300 bg-white text-red-700 hover:bg-red-50',
    ghost: 'text-slate-700 hover:bg-slate-100',
  }[variant];
  return <button type="button" {...props} className={`${base} ${styles} ${className}`} />;
}

const STATUS_LABEL: Record<EmailStatus, string> = {
  SCHEDULED: 'Scheduled',
  DEFERRED: 'Deferred',
  SENDING: 'Sending',
  SENT: 'Sent',
  FAILED: 'Failed',
  DELIVERY_UNCERTAIN: 'Uncertain (not resent)',
};

const STATUS_STYLE: Record<EmailStatus, string> = {
  SCHEDULED: 'bg-slate-100 text-slate-700 ring-slate-300',
  DEFERRED: 'bg-amber-50 text-amber-800 ring-amber-300',
  SENDING: 'bg-blue-50 text-blue-800 ring-blue-300',
  SENT: 'bg-green-50 text-green-800 ring-green-300',
  FAILED: 'bg-red-50 text-red-800 ring-red-300',
  DELIVERY_UNCERTAIN: 'bg-purple-50 text-purple-800 ring-purple-300',
};

export function StatusBadge({ status }: { status: EmailStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_STYLE[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export const DEFERRAL_LABEL: Record<string, string> = {
  SENDER_HOURLY_CAP: 'sender hourly cap reached',
  CAMPAIGN_HOURLY_CAP: 'campaign hourly limit reached',
  SENDER_PACING: 'waiting for sender gap',
  CAMPAIGN_PACING: 'waiting for campaign gap',
  SENDER_IN_FLIGHT: 'sender busy with another email',
  NOT_YET_DUE: 'not due yet',
};

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded bg-slate-200 ${className}`} />;
}

export function ErrorBox({ message, onRetry, correlationId }: { message: string; onRetry?: () => void; correlationId?: string }) {
  return (
    <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
      <p>{message}</p>
      {correlationId ? <p className="mt-1 text-xs text-red-600">Reference: {correlationId}</p> : null}
      {onRetry ? (
        <Button variant="secondary" className="mt-2" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-slate-300 p-8 text-center">
      <p className="font-medium text-slate-700">{title}</p>
      {children ? <div className="mt-2 text-sm text-slate-500">{children}</div> : null}
    </div>
  );
}

/**
 * Dialog with labelled role, Escape to close, initial focus, Tab wrapping inside the dialog and
 * focus restoration on close.
 */
export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusables = () =>
      Array.from(panel?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? []).filter(
        (el) => !el.hasAttribute('disabled'),
      );
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:items-center">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`my-8 w-full rounded-lg bg-white shadow-xl ${wide ? 'max-w-3xl' : 'max-w-xl'}`}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 id={titleId} className="text-base font-semibold">
            {title}
          </h2>
          <Button variant="ghost" aria-label="Close dialog" onClick={onClose}>
            ✕
          </Button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
