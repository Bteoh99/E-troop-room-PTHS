import { expect, test, type Page } from '@playwright/test';

// Phase 1.5 fix-round e2e regressions (frontend tester): OCR language file fails to load → clear
// error → next photo retries and works; 429 Retry-After wording from real headers; 503 repair dialog.

const LOCKED = { cookies: [], origins: [] };
const PIN = process.env.E2E_PIN ?? '246810';

async function labelPng(page: Page, text: string): Promise<Buffer> {
  const url = await page.evaluate((t) => {
    const c = document.createElement('canvas');
    c.width = 1200;
    c.height = 400;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#111';
    ctx.font = 'bold 110px Arial, Helvetica, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(t, 600, 200);
    return c.toDataURL('image/png');
  }, text);
  return Buffer.from(url.split(',')[1]!, 'base64');
}

test('OCR language file fails to load → clear error; the next photo retries and finds the item', async ({ page }) => {
  test.setTimeout(180_000);
  let failed = 0;
  await page.route('**/ocr/eng.traineddata*', (route) => {
    if (failed === 0) {
      failed++;
      return route.abort('connectionreset');
    }
    return route.continue();
  });
  const png = await labelPng(page, 'TNT-004');
  await page.goto('/scan');
  const pick = () => page.getByLabel(/Take a photo/).setInputFiles({ name: 'l.png', mimeType: 'image/png', buffer: png });
  await pick();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText("The text reader couldn't load", { timeout: 90_000 });
  await expect(alert).toContainText('eng.traineddata.gz');
  await expect(alert.getByRole('button', { name: 'Try another photo' })).toBeVisible();
  await pick();
  await expect(page.getByTestId('item-card').first()).toContainText('TNT-004', { timeout: 150_000 });
  await expect(alert).toHaveCount(0);
  expect(failed).toBe(1);
});

test('scan throttled (429, Retry-After: 30) says "wait 30 seconds" and keeps the text', async ({ page }) => {
  await page.route('**/api/scan/match', (route) =>
    route.fulfill({
      status: 429,
      headers: { 'Retry-After': '30' },
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Too many scans' } }),
    }),
  );
  await page.goto('/scan');
  // Use the text box path: a blank photo gives an empty text box, then search with typed text.
  const canvasPng = await labelPng(page, '');
  await page.getByLabel(/Take a photo/).setInputFiles({ name: 'b.png', mimeType: 'image/png', buffer: canvasPng });
  const box = page.getByLabel(/Fix any mistakes/);
  await expect(box).toBeVisible({ timeout: 150_000 });
  await box.fill('coleman sundome');
  await page.getByRole('button', { name: 'Search with this text' }).click();
  await expect(page.getByRole('alert')).toContainText('Too many scans in a minute — wait 30 seconds, then try again.');
  await expect(box).toHaveValue('coleman sundome');
});

test.describe('locked', () => {
  test.use({ storageState: LOCKED });

  test('PIN 429 with Retry-After: 120 says "wait 2 minutes"', async ({ page }) => {
    await page.route('**/api/auth/login', (route) =>
      route.fulfill({
        status: 429,
        headers: { 'Retry-After': '120' },
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Too many wrong PIN attempts.' } }),
      }),
    );
    await page.goto('/');
    await page.getByTestId('leader-button').click();
    const dialog = page.getByRole('dialog', { name: /Leader PIN/ });
    await dialog.getByLabel('PIN').fill(PIN);
    await dialog.getByRole('button', { name: 'Unlock' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Too many wrong tries — wait 2 minutes, then try again.');
    await expect(dialog.getByLabel('PIN')).toBeFocused();
  });

  test('PIN 503 (damaged settings) opens the repair dialog', async ({ page }) => {
    await page.route('**/api/auth/login', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Leader settings are damaged.' } }),
      }),
    );
    await page.goto('/');
    await page.getByTestId('leader-button').click();
    await page.getByRole('dialog').getByLabel('PIN').fill(PIN);
    await page.getByRole('dialog').getByRole('button', { name: 'Unlock' }).click();
    const damaged = page.getByRole('dialog', { name: /settings damaged/ });
    await expect(damaged).toContainText('set-pin');
    await damaged.getByRole('button', { name: 'OK' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('leader-button')).toHaveAccessibleName(/Leader mode off/);
  });
});
