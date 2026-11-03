import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const session = JSON.parse(readFileSync(join(process.cwd(), 'test-results', 'e2e-session.json'), 'utf8')) as { cookie: string };
const [cookieName, cookieValue] = session.cookie.split('=');

/** Local date-time string for a datetime-local input, offset from now. */
function localInput(offsetMs: number): string {
  const d = new Date(Date.now() + offsetMs);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function signedInDashboard(page: Page) {
  await page.context().addCookies([{ name: cookieName!, value: cookieValue!, url: 'http://localhost:5173' }]);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

test.describe('dashboard workflow against the real API', () => {
  test('shows the signed-in profile, senders, and the Slack control', async ({ page }) => {
    await signedInDashboard(page);
    await expect(page.getByText('owner@e2e.test').first()).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Integrations and senders' }).getByText('Sink sender 1')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Slack alerts' })).toBeVisible();
    // The e2e stack intentionally runs without Slack credentials, so the panel reports that state.
    await expect(page.getByText('Slack is not configured on this server')).toBeVisible();
  });

  test('imports recipients, validates, schedules, and shows sent results with detail', async ({ page }) => {
    await signedInDashboard(page);
    await page.getByRole('button', { name: 'Compose new email' }).click();
    const dialog = page.getByRole('dialog', { name: 'Compose new email campaign' });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('Subject').fill('E2E digest');
    await dialog.getByLabel('Message (plain text)').fill('Hello from the browser smoke test.');
    const recipients = dialog.getByLabel(/Recipients \(one per line/);
    await recipients.fill('email\ne2e-a@example.com\n\ne2e-b@example.com\nnot-an-email');
    await expect(dialog.getByText('A header row was detected and skipped.')).toBeVisible();
    await expect(dialog.getByText('1 line(s) are not valid email addresses')).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Schedule/ })).toBeDisabled();

    await recipients.fill('e2e-a@example.com\ne2e-b@example.com\ne2e-a@example.com');
    await expect(dialog.getByRole('button', { name: 'Schedule 2 emails' })).toBeEnabled();
    await dialog.getByLabel('Start time').fill(localInput(-30_000));
    await dialog.getByLabel('Delay between emails (seconds)').fill('0');
    await dialog.getByRole('button', { name: 'Schedule 2 emails' }).click();

    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(/Accepted 2 emails \(1 duplicate skipped\)/)).toBeVisible();

    // The outbox publishes, the worker sends through the SMTP sink, and the Sent tab reflects it.
    await page.getByRole('tab', { name: 'Sent' }).click();
    const rowA = page.getByRole('row', { name: /e2e-a@example\.com/ });
    await expect(rowA.getByText('Sent', { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('row', { name: /e2e-b@example\.com/ }).getByText('Sent', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Details for e2e-a@example.com' }).click();
    const detail = page.getByRole('dialog', { name: 'Email details' });
    await expect(detail.getByText('Accepted by SMTP')).toBeVisible();
    await expect(detail.getByText('Message ID')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Email details' })).toHaveCount(0);
  });

  test('keeps future emails in Scheduled and finds them through search', async ({ page }) => {
    await signedInDashboard(page);
    await page.getByRole('button', { name: 'Compose new email' }).click();
    const dialog = page.getByRole('dialog', { name: 'Compose new email campaign' });
    await dialog.getByLabel('Subject').fill('Zephyr later announcement');
    await dialog.getByLabel('Message (plain text)').fill('Scheduled for later in the day.');
    await dialog.getByLabel(/Recipients \(one per line/).fill('later@example.com');
    await dialog.getByLabel('Start time').fill(localInput(2 * 3600_000));
    await dialog.getByRole('button', { name: 'Schedule 1 email' }).click();
    await expect(dialog).toHaveCount(0);

    await page.getByRole('tab', { name: 'Scheduled' }).click();
    await expect(page.getByRole('row', { name: /later@example\.com/ }).getByText('Scheduled', { exact: true })).toBeVisible();

    await page.getByRole('searchbox', { name: /Search scheduled and sent/ }).fill('Zephyr');
    await expect(page.getByRole('row', { name: /later@example\.com/ })).toBeVisible({ timeout: 30_000 });
  });

  test('is usable at phone width without horizontal page scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signedInDashboard(page);
    await page.screenshot({ path: join(process.cwd(), 'test-results', 'dashboard-390.png'), fullPage: true });
    const report = await page.evaluate(() => {
      const g = globalThis as unknown as {
        innerWidth: number;
        document: {
          documentElement: { scrollWidth: number; clientWidth: number };
          querySelectorAll: (sel: string) => Array<{ tagName: string; className: string; id: string; parentElement: unknown; getBoundingClientRect: () => { right: number; width: number } }>;
        };
      };
      const root = g.document.documentElement;
      // Wide tables are allowed inside their own horizontal scroller; only page-level overflow fails.
      const inScroller = (el: { parentElement: unknown }) => {
        let node = el.parentElement as { parentElement: unknown; tagName: string } | null;
        while (node && node.tagName !== 'BODY') {
          const style = (globalThis as unknown as { getComputedStyle: (n: unknown) => { overflowX: string } }).getComputedStyle(node);
          if (style.overflowX === 'auto' || style.overflowX === 'scroll' || style.overflowX === 'hidden') return true;
          node = node.parentElement as typeof node;
        }
        return false;
      };
      const wide = Array.from(g.document.querySelectorAll('body *'))
        .filter((el) => !inScroller(el as unknown as { parentElement: unknown }))
        .map((el) => ({ el, right: el.getBoundingClientRect().right, width: el.getBoundingClientRect().width }))
        .filter((x) => x.right > g.innerWidth + 1)
        .slice(0, 6)
        .map((x) => `${x.el.tagName.toLowerCase()}.${String(x.el.className).slice(0, 80)} right=${Math.round(x.right)} width=${Math.round(x.width)}`);
      return { overflow: root.scrollWidth - root.clientWidth, wide };
    });
    expect(report.wide, 'elements extending past the viewport').toEqual([]);
    expect(report.overflow).toBeLessThanOrEqual(1);
  });
});
