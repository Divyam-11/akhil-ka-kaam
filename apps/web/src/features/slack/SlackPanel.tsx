import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiClientError } from '../../lib/api';
import { Button, ErrorBox, Skeleton } from '../../components/ui';

/** Slack connection status and controls. Disconnecting never affects email sending. */
export function SlackPanel() {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const status = useQuery({ queryKey: ['slack'], queryFn: api.slack });
  const disconnect = useMutation({
    mutationFn: api.disconnectSlack,
    onSuccess: () => {
      setConfirming(false);
      void qc.invalidateQueries({ queryKey: ['slack'] });
    },
  });

  return (
    <section aria-labelledby="slack-heading" className="rounded-md border border-slate-200 bg-white p-4">
      <h2 id="slack-heading" className="text-sm font-semibold">
        Slack alerts
      </h2>
      {status.isPending ? (
        <Skeleton className="mt-3 h-10 w-full" />
      ) : status.isError ? (
        <ErrorBox message="Slack status could not be loaded." onRetry={() => void status.refetch()} />
      ) : (
        <div className="mt-2 grid gap-3 text-sm">
          {status.data.status === 'CONNECTED' ? (
            <>
              <p>
                Connected to <strong>{status.data.teamName}</strong> · {status.data.channelName}
              </p>
              <p className="text-xs text-slate-500">
                A message is posted when a sender or campaign reaches its hourly cap. Emails are not included.
              </p>
              {confirming ? (
                <div className="flex flex-wrap items-center gap-2 rounded-md bg-amber-50 p-3">
                  <span>Disconnect Slack? Future cap alerts will be skipped until you reconnect.</span>
                  <Button variant="danger" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
                    Disconnect
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirming(false)}>
                    Keep connected
                  </Button>
                </div>
              ) : (
                <Button variant="danger" className="justify-self-start" onClick={() => setConfirming(true)}>
                  Disconnect Slack
                </Button>
              )}
            </>
          ) : status.data.configured ? (
            <>
              <p className="text-slate-600">
                {status.data.status === 'DISCONNECTED' ? 'Slack is disconnected. ' : 'No Slack channel is connected. '}
                Connect a channel to receive cap alerts.
              </p>
              <a
                href="/auth/slack"
                className="inline-flex w-max items-center rounded-md bg-blue-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Connect Slack
              </a>
            </>
          ) : (
            <p className="text-slate-600">Slack is not configured on this server (SLACK_CLIENT_ID / SLACK_CLIENT_SECRET are missing).</p>
          )}
          {disconnect.isError ? (
            <ErrorBox
              message={disconnect.error instanceof ApiClientError ? disconnect.error.message : 'Disconnect failed.'}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}
