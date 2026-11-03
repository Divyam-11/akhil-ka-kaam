import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiClientError, setCsrfToken } from './lib/api';
import { ErrorBox, Skeleton } from './components/ui';
import { Dashboard } from './Dashboard';

const AUTH_MESSAGES: Record<string, string> = {
  denied: 'Google sign-in was cancelled.',
  expired: 'That sign-in link expired. Please try again.',
  unverified_email: 'Google reports this email address is not verified.',
  invalid_identity: 'Google did not return a usable identity.',
  failed: 'Sign-in failed. Please try again.',
};

export default function App() {
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.me();
      } catch (error) {
        if (error instanceof ApiClientError && error.status === 401) return null;
        throw error;
      }
    },
  });

  useEffect(() => {
    setCsrfToken(me.data?.csrfToken ?? null);
  }, [me.data]);

  const [banner, setBanner] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const auth = params.get('auth');
    const slack = params.get('slack');
    if (auth) setBanner(AUTH_MESSAGES[auth] ?? 'Sign-in did not complete.');
    if (slack === 'connected') setBanner('Slack connected. Cap alerts will be posted to the selected channel.');
    if (slack === 'denied') setBanner('Slack installation was cancelled.');
    if (slack === 'error') setBanner(`Slack could not be connected (${params.get('reason') ?? 'unknown'}).`);
    if (slack === 'session_mismatch' || slack === 'expired') setBanner('That Slack link expired or belongs to a different session. Try Connect Slack again.');
    if (slack === 'not_configured') setBanner('Slack is not configured on this server.');
    if (auth || slack) {
      window.history.replaceState({}, '', window.location.pathname);
      void qc.invalidateQueries({ queryKey: ['slack'] });
    }
  }, [qc]);

  if (me.isPending) {
    return (
      <main className="mx-auto grid max-w-6xl gap-4 p-6" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-64 w-full" />
      </main>
    );
  }
  if (me.isError) {
    return (
      <main className="mx-auto max-w-lg p-6">
        <ErrorBox message="The scheduler could not be reached. Check that the API is running." onRetry={() => void me.refetch()} />
      </main>
    );
  }
  if (!me.data) {
    return (
      <main className="mx-auto grid min-h-screen max-w-md content-center gap-6 p-6 text-center">
        <div>
          <h1 className="text-2xl font-semibold">ReachInbox Scheduler</h1>
          <p className="mt-2 text-sm text-slate-600">Schedule and track outbound email campaigns.</p>
        </div>
        {banner ? <p role="status" className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">{banner}</p> : null}
        <a
          href="/auth/google"
          className="inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2.5 font-medium text-white hover:bg-blue-700"
        >
          Sign in with Google
        </a>
        <p className="text-xs text-slate-500">Only your own workspace is visible after sign-in.</p>
      </main>
    );
  }
  return <Dashboard me={me.data} banner={banner} onDismissBanner={() => setBanner(null)} onLogout={async () => {
    await api.logout().catch(() => undefined);
    setCsrfToken(null);
    qc.clear();
    await qc.invalidateQueries({ queryKey: ['me'] });
  }} />;
}
