import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useInfiniteQuery, keepPreviousData } from '@tanstack/react-query';
import type { EmailRowDto, EmailView, SenderDto } from '@reachinbox/contracts';
import { api, ApiClientError } from '../../lib/api';
import { formatLocal, formatUtc } from '../../lib/time';
import { Button, DEFERRAL_LABEL, EmptyState, ErrorBox, Skeleton, StatusBadge } from '../../components/ui';

const TABS: Array<{ id: EmailView; label: string; hint: string }> = [
  { id: 'scheduled', label: 'Scheduled', hint: 'Pending, deferred and in-progress emails' },
  { id: 'sent', label: 'Sent', hint: 'Accepted by SMTP, failed, or uncertain' },
];

interface Props {
  senders: SenderDto[];
  onOpen: (id: string) => void;
}

/** Scheduled/Sent tabs with Elasticsearch-backed search when text is entered. */
export function EmailsPanel({ senders, onOpen }: Props) {
  const [view, setView] = useState<EmailView>('scheduled');
  const [senderFilter, setSenderFilter] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const listQuery = useInfiniteQuery({
    queryKey: ['emails', view, senderFilter, q],
    enabled: q === '',
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.listEmails(view, pageParam, senderFilter || undefined),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 5000,
    placeholderData: keepPreviousData,
  });

  const searchQuery = useInfiniteQuery({
    queryKey: ['search', view, q],
    enabled: q !== '',
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.search(q, view, pageParam),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 5000,
    placeholderData: keepPreviousData,
  });

  const active = q === '' ? listQuery : searchQuery;
  const rows: EmailRowDto[] = useMemo(() => active.data?.pages.flatMap((p) => p.items) ?? [], [active.data]);
  const senderLabel = (id: string) => senders.find((s) => s.id === id)?.label ?? '';

  function onTabKey(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const next = TABS[(index + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]!;
    setView(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  }

  return (
    <section aria-labelledby="emails-heading" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="emails-heading" className="text-lg font-semibold">
          Emails
        </h2>
        <div className="flex flex-wrap gap-2">
          <label className="grid gap-1 text-xs font-medium text-slate-600">
            Sender
            <select
              value={senderFilter}
              onChange={(e) => setSenderFilter(e.target.value)}
              className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm font-normal"
            >
              <option value="">All senders</option>
              {senders.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs font-medium text-slate-600">
            Search scheduled and sent
            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Recipient, subject or body"
              className="w-64 rounded-md border border-slate-300 px-2.5 py-1.5 text-sm font-normal"
            />
          </label>
        </div>
      </div>

      <div role="tablist" aria-label="Email views" className="flex gap-1 border-b border-slate-200">
        {TABS.map((tab, i) => (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            role="tab"
            type="button"
            aria-selected={view === tab.id}
            aria-controls="emails-table"
            tabIndex={view === tab.id ? 0 : -1}
            title={tab.hint}
            onClick={() => setView(tab.id)}
            onKeyDown={(e) => onTabKey(e, i)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              view === tab.id ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div id="emails-table" role="tabpanel" aria-labelledby={`tab-${view}`} className="min-w-0">
        {active.isError ? (
          <ErrorBox
            message={
              active.error instanceof ApiClientError
                ? active.error.message
                : 'The list could not be loaded.'
            }
            correlationId={active.error instanceof ApiClientError ? active.error.correlationId : undefined}
            onRetry={() => void active.refetch()}
          />
        ) : active.isPending ? (
          <div className="grid gap-2" aria-busy="true" aria-label="Loading emails">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState title={q ? `No ${view} emails match “${q}”.` : `No ${view} emails yet.`}>
            {view === 'scheduled' ? 'Compose a campaign to schedule emails.' : 'Sent emails appear here once the scheduler delivers them.'}
          </EmptyState>
        ) : (
          <div className="relative overflow-x-auto rounded-md border border-slate-200 bg-white">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <caption className="sr-only">{view === 'scheduled' ? 'Scheduled emails' : 'Sent emails'}</caption>
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th scope="col" className="px-3 py-2">Recipient</th>
                  <th scope="col" className="px-3 py-2">Subject</th>
                  <th scope="col" className="px-3 py-2">Sender</th>
                  <th scope="col" className="px-3 py-2">Original time (UTC)</th>
                  <th scope="col" className="px-3 py-2">{view === 'scheduled' ? 'Next attempt' : 'Sent'}</th>
                  <th scope="col" className="px-3 py-2">Status</th>
                  <th scope="col" className="px-3 py-2"><span className="sr-only">Details</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2 font-medium">{row.recipient}</td>
                    <td className="max-w-xs truncate px-3 py-2">{row.subject}</td>
                    <td className="px-3 py-2">{row.senderLabel || senderLabel(row.senderId)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-600">{formatUtc(row.scheduledAt)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-600">
                      {view === 'scheduled'
                        ? row.status === 'DEFERRED' && row.nextAttemptAt
                          ? `${formatUtc(row.nextAttemptAt)} · ${DEFERRAL_LABEL[row.deferralReason ?? ''] ?? 'deferred'}`
                          : formatLocal(row.nextAttemptAt)
                        : formatUtc(row.sentAt)}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={row.status} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button variant="ghost" onClick={() => onOpen(row.id)} aria-label={`Details for ${row.recipient}`}>
                        View
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {active.hasNextPage ? (
          <div className="mt-3 flex justify-center">
            <Button variant="secondary" onClick={() => void active.fetchNextPage()} disabled={active.isFetchingNextPage}>
              {active.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
