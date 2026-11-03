import { useQuery } from '@tanstack/react-query';
import type { RateLimitEventDto } from '@reachinbox/contracts';
import { api } from '../../lib/api';
import { formatUtc } from '../../lib/time';
import { EmptyState, ErrorBox, Skeleton } from '../../components/ui';

const SLACK_LABEL: Record<string, string> = {
  PENDING: 'queued',
  SENT: 'posted to Slack',
  FAILED: 'Slack rejected or failed',
  SKIPPED_NOT_CONNECTED: 'skipped (Slack not connected)',
  SKIPPED_DISCONNECTED: 'skipped (Slack disconnected)',
};

/** Sender caps, current-hour usage, and recent threshold events with their Slack outcome. */
export function SenderPanel() {
  const senders = useQuery({ queryKey: ['senders'], queryFn: api.senders, refetchInterval: 5000 });
  const events = useQuery({ queryKey: ['rate-events'], queryFn: api.rateEvents, refetchInterval: 5000 });

  return (
    <div className="grid gap-4">
      <section aria-labelledby="senders-heading" className="rounded-md border border-slate-200 bg-white p-4">
        <h2 id="senders-heading" className="text-sm font-semibold">
          Senders
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Protective caps are shared by every campaign that uses the sender. Each hour is a fixed UTC window.
        </p>
        {senders.isPending ? (
          <Skeleton className="mt-3 h-16 w-full" />
        ) : senders.isError ? (
          <ErrorBox message="Senders could not be loaded." onRetry={() => void senders.refetch()} />
        ) : senders.data.items.length === 0 ? (
          <EmptyState title="No senders are available.">Run pnpm seed:ethereal to provision sender accounts.</EmptyState>
        ) : (
          <ul className="mt-3 grid gap-2">
            {senders.data.items.map((s) => {
              const pct = Math.min(100, Math.round((s.sentThisHour / s.hourlyCap) * 100));
              return (
                <li key={s.id} className="grid gap-1 text-sm">
                  <div className="flex justify-between gap-2">
                    <span className="font-medium">{s.label}</span>
                    <span className="text-slate-600">
                      {s.sentThisHour} / {s.hourlyCap} this hour · gap {Math.round(s.minGapMs / 1000)}s
                    </span>
                  </div>
                  <div
                    className="h-2 overflow-hidden rounded bg-slate-200"
                    role="progressbar"
                    aria-label={`${s.label} hourly usage`}
                    aria-valuemin={0}
                    aria-valuemax={s.hourlyCap}
                    aria-valuenow={s.sentThisHour}
                  >
                    <div className={`h-full ${pct >= 100 ? 'bg-amber-500' : 'bg-blue-500'}`} style={{ width: `${pct}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="events-heading" className="rounded-md border border-slate-200 bg-white p-4">
        <h2 id="events-heading" className="text-sm font-semibold">
          Cap events
        </h2>
        {events.isPending ? (
          <Skeleton className="mt-3 h-10 w-full" />
        ) : events.isError ? (
          <ErrorBox message="Cap events could not be loaded." onRetry={() => void events.refetch()} />
        ) : events.data.items.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">No cap has been reached yet.</p>
        ) : (
          <ul className="mt-2 grid gap-2 text-sm">
            {events.data.items.map((e: RateLimitEventDto) => (
              <li key={e.id} className="rounded-md bg-slate-50 p-2">
                <span className="font-medium">
                  {e.scope === 'SENDER' ? e.senderLabel : `Campaign via ${e.senderLabel}`}
                </span>{' '}
                reached {e.cap}/hour at {formatUtc(e.reachedAt)}.{' '}
                <span className="text-slate-600">Slack: {SLACK_LABEL[e.slackStatus] ?? e.slackStatus}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
