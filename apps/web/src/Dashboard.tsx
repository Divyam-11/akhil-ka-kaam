import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import type { CampaignCreatedDto, MeResponse } from '@reachinbox/contracts';
import { api } from './lib/api';
import { Button, ErrorBox, Skeleton } from './components/ui';
import { ComposeModal } from './features/compose/ComposeModal';
import { EmailsPanel } from './features/emails/EmailsPanel';
import { EmailDetail } from './features/detail/EmailDetail';
import { SlackPanel } from './features/slack/SlackPanel';
import { SenderPanel } from './features/senders/SenderPanel';

interface Props {
  me: MeResponse;
  banner: string | null;
  onDismissBanner: () => void;
  onLogout: () => Promise<void>;
}

function initials(name: string | null, email: string): string {
  const source = (name ?? email).trim();
  const parts = source.split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : source.slice(0, 2)).toUpperCase();
}

export function Dashboard({ me, banner, onDismissBanner, onLogout }: Props) {
  const qc = useQueryClient();
  const [composeOpen, setComposeOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [created, setCreated] = useState<CampaignCreatedDto | null>(null);
  const senders = useQuery({ queryKey: ['senders'], queryFn: api.senders, refetchInterval: 10_000 });
  const senderList = senders.data?.items ?? [];

  const onCreated = useCallback(
    (dto: CampaignCreatedDto) => {
      setComposeOpen(false);
      setCreated(dto);
      void qc.invalidateQueries({ queryKey: ['emails'] });
      void qc.invalidateQueries({ queryKey: ['search'] });
      void qc.invalidateQueries({ queryKey: ['senders'] });
    },
    [qc],
  );

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            {me.user.pictureUrl ? (
              <img src={me.user.pictureUrl} alt="" width={36} height={36} className="h-9 w-9 rounded-full" referrerPolicy="no-referrer" />
            ) : (
              <span aria-hidden="true" className="grid h-9 w-9 place-items-center rounded-full bg-slate-200 text-xs font-semibold">
                {initials(me.user.name, me.user.email)}
              </span>
            )}
            <div>
              <p className="text-sm font-semibold">{me.user.name ?? me.user.email}</p>
              <p className="text-xs text-slate-500">{me.user.email}</p>
            </div>
          </div>
          <nav aria-label="Account" className="flex items-center gap-2">
            {me.isOperator ? (
              <a href="/admin/queues" className="rounded-md px-3 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50">
                Queue board
              </a>
            ) : null}
            <Button variant="secondary" onClick={() => void onLogout()}>
              Log out
            </Button>
          </nav>
        </div>
      </header>

      <main className="mx-auto grid min-w-0 max-w-6xl grid-cols-[minmax(0,1fr)] gap-6 px-4 py-6">
        {banner ? (
          <div role="status" className="flex items-center justify-between gap-3 rounded-md bg-blue-50 p-3 text-sm text-blue-900">
            <span>{banner}</span>
            <Button variant="ghost" onClick={onDismissBanner} aria-label="Dismiss message">
              ✕
            </Button>
          </div>
        ) : null}

        {created ? (
          <div role="status" className="rounded-md bg-green-50 p-3 text-sm text-green-900">
            Accepted {created.acceptedCount} email{created.acceptedCount === 1 ? '' : 's'}
            {created.duplicateCount ? ` (${created.duplicateCount} duplicate${created.duplicateCount === 1 ? '' : 's'} skipped)` : ''}
            {created.replayed ? ' — this request was already received, so nothing was added twice' : ''}. Queue publication is
            asynchronous and is confirmed by the outbox; emails appear in Scheduled.
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">Dashboard</h1>
          <Button onClick={() => setComposeOpen(true)} disabled={senderList.length === 0}>
            Compose new email
          </Button>
        </div>
        {senders.isError ? <ErrorBox message="Senders could not be loaded." onRetry={() => void senders.refetch()} /> : null}
        {senders.isPending ? <Skeleton className="h-10 w-full" /> : null}
        {senders.isSuccess && senderList.length === 0 ? (
          <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">
            No sender accounts are provisioned for this workspace yet. Run <code>pnpm seed:ethereal</code>, then sign in again.
          </p>
        ) : null}

        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <EmailsPanel senders={senderList} onOpen={setDetailId} />
          <aside className="grid min-w-0 content-start gap-4" aria-label="Integrations and senders">
            <SlackPanel />
            <SenderPanel />
          </aside>
        </div>
      </main>

      {composeOpen ? (
        <ComposeModal senders={senderList} onClose={() => setComposeOpen(false)} onCreated={onCreated} />
      ) : null}
      {detailId ? <EmailDetail emailId={detailId} onClose={() => setDetailId(null)} /> : null}
    </div>
  );
}
