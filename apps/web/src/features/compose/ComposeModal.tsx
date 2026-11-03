import { useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { analyzeRecipients, LIMITS, type CampaignCreatedDto, type SenderDto } from '@reachinbox/contracts';
import { api, ApiClientError } from '../../lib/api';
import { parseRecipientText } from '../../lib/csv';
import { localInputToUtcIso, toLocalInputValue, viewerTimeZone } from '../../lib/time';
import { Button, Modal } from '../../components/ui';

const MAX_RECIPIENTS = LIMITS.recipientsHardMax;

interface Props {
  senders: SenderDto[];
  onClose: () => void;
  onCreated: (dto: CampaignCreatedDto) => void;
}

function defaultStart(): string {
  return toLocalInputValue(new Date(Date.now() + 10 * 60 * 1000));
}

/**
 * Compose form. Client-side checks give immediate feedback; the API revalidates everything.
 * The Idempotency-Key is generated once per distinct payload, so a network retry of the same
 * submission reuses it, while an edited form gets a new key. Form contents survive failures.
 */
export function ComposeModal({ senders, onClose, onCreated }: Props) {
  const [senderId, setSenderId] = useState(senders[0]?.id ?? '');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [recipientsText, setRecipientsText] = useState('');
  const [importNote, setImportNote] = useState<string | null>(null);
  const [startLocal, setStartLocal] = useState(defaultStart);
  const [gapSeconds, setGapSeconds] = useState(60);
  const [hourlyCap, setHourlyCap] = useState(20);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<{ message: string; correlationId?: string } | null>(null);
  const attempt = useRef<{ key: string; payload: string } | null>(null);
  const submittingRef = useRef(false);

  const parsed = useMemo(() => parseRecipientText(recipientsText), [recipientsText]);
  const report = useMemo(() => analyzeRecipients(parsed.values), [parsed.values]);
  const startIso = localInputToUtcIso(startLocal);
  const sender = senders.find((s) => s.id === senderId);

  const problems: string[] = [];
  if (!senderId) problems.push('Choose a sender.');
  if (subject.trim() === '') problems.push('Subject is required.');
  if (body.trim() === '') problems.push('Message body is required.');
  if (!startIso) problems.push('Choose a start date and time.');
  // The datetime input has minute resolution, so allow a few minutes of truncation/clock skew.
  else if (new Date(startIso).getTime() < Date.now() - 5 * 60_000) problems.push('The start time is in the past.');
  if (report.valid === 0) problems.push('Add at least one valid recipient.');
  if (report.invalid > 0) problems.push(`${report.invalid} line(s) are not valid email addresses. Fix or remove them.`);
  if (report.valid > MAX_RECIPIENTS) problems.push(`A campaign can contain at most ${MAX_RECIPIENTS} recipients.`);
  if (!Number.isInteger(gapSeconds) || gapSeconds < 0 || gapSeconds > LIMITS.gapSecondsMax) {
    problems.push('Delay between emails must be a whole number of seconds from 0 to 86400.');
  }
  if (!Number.isInteger(hourlyCap) || hourlyCap < 1 || hourlyCap > LIMITS.hourlyCapMax) {
    problems.push(`Campaign hourly limit must be a whole number from 1 to ${LIMITS.hourlyCapMax}.`);
  }

  const canSubmit = problems.length === 0 && !submitting;

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setImportNote('That file is larger than 5 MB. Split it into smaller imports.');
      return;
    }
    const text = await file.text();
    setRecipientsText(text);
    setImportNote(`Loaded ${file.name}.`);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || submittingRef.current || !startIso) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    const payloadBody = {
      senderId,
      subject: subject.trim(),
      body,
      startAt: startIso,
      gapSeconds,
      hourlyCap,
      // Send the raw valid lines: the server normalises and deduplicates, so its counts are authoritative.
      recipients: parsed.values.filter((v) => v.trim() !== ''),
    };
    const payloadJson = JSON.stringify(payloadBody);
    if (!attempt.current || attempt.current.payload !== payloadJson) {
      attempt.current = { key: crypto.randomUUID(), payload: payloadJson };
    }
    try {
      const dto = await api.createCampaign(payloadBody, attempt.current.key);
      onCreated(dto);
    } catch (error) {
      if (error instanceof ApiClientError) {
        setSubmitError({ message: error.message, correlationId: error.correlationId });
      } else {
        setSubmitError({ message: 'Could not reach the server. Your form is unchanged; try again.' });
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Compose new email campaign" onClose={onClose} wide>
      <form onSubmit={onSubmit} noValidate className="grid gap-5 md:grid-cols-2">
        <div className="grid content-start gap-4">
          <label className="grid gap-1 text-sm font-medium">
            Sender
            <select
              value={senderId}
              onChange={(e) => setSenderId(e.target.value)}
              className="rounded-md border border-slate-300 px-2.5 py-2 text-sm font-normal"
            >
              {senders.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label} ({s.fromAddress})
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-medium">
            Subject
            <input
              value={subject}
              maxLength={LIMITS.subjectMax}
              onChange={(e) => setSubject(e.target.value)}
              className="rounded-md border border-slate-300 px-2.5 py-2 text-sm font-normal"
            />
          </label>
          <label className="grid gap-1 text-sm font-medium">
            Message (plain text)
            <textarea
              value={body}
              rows={6}
              maxLength={LIMITS.bodyMax}
              onChange={(e) => setBody(e.target.value)}
              className="rounded-md border border-slate-300 px-2.5 py-2 text-sm font-normal"
            />
          </label>
          <div className="grid gap-2 rounded-md bg-slate-50 p-3 text-sm">
            <label className="grid gap-1 font-medium">
              Start time
              <input
                type="datetime-local"
                value={startLocal}
                onChange={(e) => setStartLocal(e.target.value)}
                className="rounded-md border border-slate-300 bg-white px-2.5 py-2 font-normal"
              />
            </label>
            <p className="text-xs text-slate-600">
              Entered in your time zone ({viewerTimeZone()}). Sent as {startIso ?? 'an invalid instant'}.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1 text-sm font-medium">
              Delay between emails (seconds)
              <input
                type="number"
                min={0}
                max={LIMITS.gapSecondsMax}
                value={gapSeconds}
                onChange={(e) => setGapSeconds(Number(e.target.value))}
                className="rounded-md border border-slate-300 px-2.5 py-2 text-sm font-normal"
              />
            </label>
            <label className="grid gap-1 text-sm font-medium">
              Campaign hourly limit
              <input
                type="number"
                min={1}
                max={LIMITS.hourlyCapMax}
                value={hourlyCap}
                onChange={(e) => setHourlyCap(Number(e.target.value))}
                className="rounded-md border border-slate-300 px-2.5 py-2 text-sm font-normal"
              />
            </label>
          </div>
          <p className="text-xs text-slate-600">
            The campaign limit applies to this campaign only. The sender&apos;s protective cap
            {sender ? ` (${sender.hourlyCap}/hour)` : ''} applies across all campaigns using that sender. Whichever is reached first
            defers the remaining emails to the next UTC hour.
          </p>
        </div>

        <div className="grid content-start gap-3">
          <label className="grid gap-1 text-sm font-medium">
            Recipients (one per line, or CSV with an optional header)
            <textarea
              value={recipientsText}
              rows={8}
              onChange={(e) => {
                setRecipientsText(e.target.value);
                setImportNote(null);
              }}
              placeholder={'email\nada@example.com\nbob@example.com'}
              className="rounded-md border border-slate-300 px-2.5 py-2 font-mono text-sm font-normal"
            />
          </label>
          <label className="grid gap-1 text-sm font-medium">
            …or import a CSV / text file
            <input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={onFile} className="text-sm font-normal" />
          </label>
          {importNote ? <p className="text-xs text-slate-600">{importNote}</p> : null}
          {parsed.parseError ? <p className="text-xs text-red-700">Could not parse: {parsed.parseError}</p> : null}

          <dl className="grid grid-cols-4 gap-2 rounded-md border border-slate-200 p-3 text-center text-sm" aria-live="polite">
            <div>
              <dt className="text-xs text-slate-500">Valid</dt>
              <dd className="font-semibold text-green-700">{report.valid}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Invalid</dt>
              <dd className="font-semibold text-red-700">{report.invalid}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Duplicates</dt>
              <dd className="font-semibold text-amber-700">{report.duplicates}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Blank rows</dt>
              <dd className="font-semibold text-slate-600">{parsed.blankRows}</dd>
            </div>
          </dl>
          {parsed.headerDetected ? <p className="text-xs text-slate-500">A header row was detected and skipped.</p> : null}
          {report.unique.length > 0 ? (
            <div>
              <p className="text-xs text-slate-500">Preview (first 5 valid addresses)</p>
              <ul className="mt-1 list-disc pl-5 text-sm text-slate-700">
                {report.unique.slice(0, 5).map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {problems.length > 0 && (
            <ul className="list-disc rounded-md bg-amber-50 p-3 pl-7 text-sm text-amber-900" aria-label="Items to fix">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {submitError ? (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {submitError.message}
              {submitError.correlationId ? <span className="block text-xs">Reference: {submitError.correlationId}</span> : null}
            </div>
          ) : null}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit} aria-disabled={!canSubmit}>
              {submitting ? 'Scheduling…' : `Schedule ${report.valid} email${report.valid === 1 ? '' : 's'}`}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
