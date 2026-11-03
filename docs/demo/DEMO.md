# Five-minute demo script

Target length: 4 min 40 s. Timestamps are cues for the recording. Use the low-limit profile so the cap is reached in seconds rather than an hour.

## Before recording

```bash
cp .env.demo.example .env.demo   # then merge the rate values into .env (or edit .env directly)
# In .env set MAX_EMAILS_PER_HOUR_PER_SENDER=2 and MIN_SEND_DELAY_MS=2000
pnpm infra:up && pnpm db:migrate && pnpm seed:ethereal   # Ethereal needs network access
pnpm dev                                                  # API, worker, dispatcher, web
```

Keep the Scheduled tab, Sent tab, the Slack channel and `http://localhost:5173/admin/queues` (operator account) open in separate windows.

## 0:00 – 0:35 · Sign-in and senders

1. Open `http://localhost:5173`, click **Sign in with Google**, choose the test account.
2. Point at the header: avatar, name, email. Point at the **Queue board** link (operator only).
3. Point at the Senders panel: two Ethereal senders, each showing `0 / 2 this hour` and the minimum gap.

## 0:35 – 1:15 · Slack and a small import

1. In **Slack alerts**, click **Connect Slack**, approve the `incoming-webhook` install and pick the channel. Return to the dashboard; the green banner confirms the connection.
2. Click **Compose new email**.
3. Drag in `docs/demo/sample-leads.csv`. Point out: the header was detected, the blank row is ignored, the duplicate is counted, and the malformed address **blocks** scheduling with a clear message. Delete that line.
4. Choose a sender, leave the subject and body short, set the start time to about two minutes from now, delay 30 seconds, campaign hourly limit `10`. Note the timezone label and the UTC instant shown under the start field.
5. Click **Schedule N emails**. The banner shows the accepted count and the duplicate skipped.

## 1:15 – 2:00 · Scheduled view, restart, queue board

1. Open the **Scheduled** tab. Rows show original UTC times and "Next attempt".
2. Open `/admin/queues` in the operator window. Show the `email-delivery` queue: delayed jobs, one per email, IDs derived from the email ID.
3. In a terminal, restart only the API and the worker (`Ctrl-C`, then rerun `pnpm dev:api` and `pnpm dev:worker`). Do **not** use `down -v`. Refresh the Scheduled tab and the queue board: the delayed jobs and their due times are unchanged.

## 2:00 – 3:00 · Sent view, the cap, Slack

1. When the start time arrives, the **Sent** tab fills. Open one row's **View** and show the status, the SMTP attempt, the Message ID and the **Ethereal preview** link (opens a new tab).
2. Because the sender cap is 2 per hour, the third email is not sent. Switch to **Scheduled**: it shows **Deferred** with "sender hourly cap reached" and its next UTC-hour attempt time.
3. The Slack channel shows the alert: sender name, cap, UTC window and next retry time. No email bodies or addresses are in it.
4. In the Cap events panel, the event shows **posted to Slack**.

## 3:00 – 3:45 · Search, a second sender, Slack disconnect

1. Type `digest` in **Search scheduled and sent**. Results come from Elasticsearch, across both tabs.
2. Compose a second campaign and choose **Sender 2**. Show that its own counter starts at zero.
3. Click **Disconnect Slack**, then trigger another cap event: its Slack status shows "skipped (Slack disconnected)" and scheduling continues. Reconnect; the next event is posted without a restart.

## 3:45 – 4:40 · Evidence and guarantees

1. Show `docs/verification.md`: the commands run, the pass counts, and the separate list of live steps that still need credentials.
2. Explain in one sentence each:
   - **Durable outbox:** the campaign and its jobs are committed together; the dispatcher publishes with stable IDs, so a crash never duplicates a job.
   - **Shared caps:** the permit is decided in a PostgreSQL transaction under row locks, so two workers cannot exceed a cap.
   - **Uncertain SMTP outcomes:** an attempt that dies mid-flight is marked *Uncertain (not resent)*. It is never sent a second time, and the trade-off is written down in the README.
3. Close on the README requirement table.

## Recovery notes for the presenter

- If Ethereal is unreachable, run `pnpm dev:smtp-sink` and `pnpm seed:local-sink` instead. Say clearly that the sink accepts but does not deliver.
- If Slack is unreachable, the cap still records "skipped" and sending continues; show that path instead.
- If the browser shows a sign-in error, check `GOOGLE_CLIENT_ID`, the redirect URI and that the account is a test user.
