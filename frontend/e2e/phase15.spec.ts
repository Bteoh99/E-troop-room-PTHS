import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { leaderHeaders } from './leader';

// Phase 1.5 end-to-end checks (SPEC section F). Parts that need backend Phase 1.5 endpoints
// skip themselves with a clear reason while the backend doesn't have them yet.

async function backendHas(request: APIRequestContext, method: 'GET' | 'POST', url: string, data?: unknown) {
  const res = method === 'GET' ? await request.get(url) : await request.post(url, { data });
  return res.status() !== 404;
}

/** Renders "COLEMAN SUNDOME 4P" as a clear printed label (PNG) using the browser's canvas. */
async function labelPng(page: Page, text: string): Promise<Buffer> {
  const dataUrl = await page.evaluate((t) => {
    const c = document.createElement('canvas');
    c.width = 1200;
    c.height = 400;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#111';
    ctx.font = 'bold 96px Arial, Helvetica, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(t, 60, 200);
    return c.toDataURL('image/png');
  }, text);
  return Buffer.from(dataUrl.split(',')[1]!, 'base64');
}

test.describe('scan', () => {
  // The first OCR run loads ~7 MB of wasm + language data; give it time on CI.
  test.setTimeout(120_000);

  test('reads a printed label fully offline (no CDN), then shows the recognised text', async ({ page }) => {
    const external: string[] = [];
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
        external.push(url.href);
        return route.abort();
      }
      return route.continue();
    });
    await page.goto('/scan');
    await expect(page.getByRole('heading', { level: 1, name: 'Scan a label' })).toBeVisible();
    const png = await labelPng(page, 'COLEMAN SUNDOME 4P');
    await page.getByLabel(/Take a photo/).setInputFiles({ name: 'label.png', mimeType: 'image/png', buffer: png });
    await expect(page.getByTestId('scan-progress')).toBeVisible();
    const box = page.getByLabel(/Fix any mistakes/);
    await expect(box).toBeVisible({ timeout: 90_000 });
    await expect(box).toHaveValue(/COLEMAN/i);
    await expect(box).toHaveValue(/SUNDOME/i);
    expect(external, 'no request may leave our own server').toEqual([]);
  });

  test('scan finds the item by brand/model text against the real backend', async ({ page, request }, info) => {
    test.skip(
      !(await backendHas(request, 'POST', '/api/scan/match', { text: 'x' })),
      'backend has no POST /api/scan/match yet (Phase 1.5 backend in progress)',
    );
    const code = `E2E-SCAN-${info.project.name}-${Date.now()}`.toUpperCase();
    const created = await request.post('/api/items', {
      headers: leaderHeaders(),
      data: { code, name: 'Dome tent (scan test)', brand: 'Coleman', model: 'Sundome 4P', locationCode: 'R05-C-3' },
    });
    expect(created.status()).toBe(201);
    const item = (await created.json()) as { id: number };
    try {
      await page.goto('/scan');
      const png = await labelPng(page, 'COLEMAN SUNDOME 4P');
      await page.getByLabel(/Take a photo/).setInputFiles({ name: 'label.png', mimeType: 'image/png', buffer: png });
      const results = page.getByTestId('scan-results');
      await expect(results).toBeVisible({ timeout: 90_000 });
      const card = results.getByTestId('item-card').filter({ hasText: code });
      await expect(card).toBeVisible();
      await expect(card.getByTestId('location-badge')).toContainText('R05-C-3');
      await expect(card).toContainText('Matched on:');
    } finally {
      await request.delete(`/api/items/${item.id}`, { headers: leaderHeaders() });
    }
  });
});

test.describe('leader mode', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('locked: Add asks for the PIN first; the right PIN continues to the form', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.getByTestId('leader-button')).toHaveAccessibleName(/Leader mode off/);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Add' }).click();
    const dialog = page.getByRole('dialog', { name: /Leader PIN/ });
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    test.skip(!(await backendHas(request, 'GET', '/api/auth/status')), 'backend has no /api/auth yet');
    await dialog.getByLabel('PIN').fill('0000');
    await dialog.getByRole('button', { name: 'Unlock' }).click();
    await expect(dialog.getByText(/That PIN isn't right/)).toBeVisible();
    await dialog.getByLabel('PIN').fill(process.env.E2E_PIN ?? '246810');
    await dialog.getByRole('button', { name: 'Unlock' }).click();
    await expect(page).toHaveURL(/\/items\/new$/);
    await expect(page.getByTestId('leader-button')).toHaveAccessibleName(/Leader mode on/);
    // Lock again.
    await page.getByTestId('leader-button').click();
    await expect(page.getByTestId('leader-button')).toHaveAccessibleName(/Leader mode off/);
  });
});

test('needs a location: type a location, Enter saves it and moves to the next item', async ({
  page,
  request,
}, info) => {
  const stamp = `${info.project.name}-${Date.now()}`.toUpperCase();
  const ids: number[] = [];
  for (const n of ['A', 'B']) {
    const res = await request.post('/api/items', {
      headers: leaderHeaders(),
      data: { code: `E2E-LOC-${n}-${stamp}`, name: `Unlocated ${n} ${stamp}` },
    });
    expect(res.status()).toBe(201);
    ids.push(((await res.json()) as { id: number }).id);
  }
  try {
    await page.goto('/locate');
    await expect(page.getByRole('heading', { level: 1, name: 'Needs a location' })).toBeVisible();
    await page.getByLabel('Rack prefix (optional)').fill('r4');
    const first = page.getByLabel(`Location for Unlocated A ${stamp} (E2E-LOC-A-${stamp})`);
    await first.fill('d-6');
    await expect(page.getByTestId('locate-row').filter({ hasText: `E2E-LOC-A-${stamp}` })).toContainText('R04-D-6');
    await first.press('Enter');
    await expect(first).toHaveCount(0);
    const saved = (await (await request.get(`/api/items/${ids[0]}`)).json()) as { locationCode: string };
    expect(saved.locationCode).toBe('R04-D-6');
  } finally {
    for (const id of ids) await request.delete(`/api/items/${id}`, { headers: leaderHeaders() });
  }
});
