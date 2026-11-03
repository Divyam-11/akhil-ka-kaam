import { useQuery } from '@tanstack/react-query';
import { api, ApiClientError } from '../../lib/api';
import { formatUtc } from '../../lib/time';
import { DEFERRAL_LABEL, ErrorBox, Modal, Skeleton, StatusBadge } from '../../components/ui';

/** Status detail for one email. The preview link is only ever returned to the owning workspace. */
export function EmailDetail({ emailId, onClose }: { emailId: string; onClose: () => void }) {
  const query = useQuery({
    queryKey: ['email', emailId],
    queryFn: () => api.email(emailId),
    refetchInterval: (q) => (q.state.data && ['SENT', 'FAILED', 'DELIVERY_UNCERTAIN'].includes(q.state.data.status) ? false : 4000),
  });
  const e = query.data;
  return (
    <Modal title="Email details" onClose={onClose}>
      {query.isPending ? (
        <div className="grid gap-2" aria-busy="true">
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : query.isError ? (
        <ErrorBox
          message={query.error instanceof ApiClientError ? query.error.message : 'Details could not be loaded.'}
          correlationId={query.error instanceof ApiClientError ? query.error.correlationId : undefined}
          onRetry={() => void query.refetch()}
        />
      ) : e ? (
        <div className="grid gap-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={e.status} />
            {e.status === 'DEFERRED' && e.deferralReason ? (
              <span className="text-amber-800">{DEFERRAL_LABEL[e.deferralReason] ?? e.deferralReason}</span>
            ) : null}
          </div>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2">
            <dt className="text-slate-500">Recipient</dt>
            <dd className="break-all font-medium">{e.recipient}</dd>
            <dt className="text-slate-500">Subject</dt>
            <dd>{e.subject}</dd>
            <dt className="text-slate-500">Sender</dt>
            <dd>{e.senderLabel}</dd>
            <dt className="text-slate-500">Sequence</dt>
            <dd>#{e.sequence + 1}</dd>
            <dt className="text-slate-500">Original scheduled time</dt>
            <dd>{formatUtc(e.scheduledAt)}</dd>
            {e.status === 'DEFERRED' || e.status === 'SCHEDULED' ? (
              <>
                <dt className="text-slate-500">Next attempt</dt>
                <dd>{formatUtc(e.nextAttemptAt)}</dd>
              </>
            ) : null}
            {e.sentAt ? (
              <>
                <dt className="text-slate-500">Accepted by SMTP</dt>
                <dd>{formatUtc(e.sentAt)}</dd>
              </>
            ) : null}
            {e.attempt ? (
              <>
                <dt className="text-slate-500">SMTP attempt</dt>
                <dd>
                  {e.attempt.status}
                  {e.attempt.errorClass ? ` (${e.attempt.errorClass})` : ''}
                </dd>
              </>
            ) : null}
            {e.messageId ? (
              <>
                <dt className="text-slate-500">Message ID</dt>
                <dd className="break-all font-mono text-xs">{e.messageId}</dd>
              </>
            ) : null}
          </dl>
          {e.lastError ? <p className="rounded-md bg-red-50 p-3 text-red-800">{e.lastError}</p> : null}
          {e.status === 'DELIVERY_UNCERTAIN' ? (
            <p className="rounded-md bg-purple-50 p-3 text-purple-900">
              The SMTP outcome for this email is unknown. ReachInbox never resends automatically, so this email will not be sent
              again. Check the mailbox provider before acting manually.
            </p>
          ) : null}
          {e.previewUrl ? (
            <a
              href={e.previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-blue-700 underline underline-offset-2"
            >
              Open Ethereal preview (opens in a new tab)
            </a>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
