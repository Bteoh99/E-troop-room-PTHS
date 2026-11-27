import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';

// Phase 1.5 e2e (frontend tester): real scan with generated photos (OCR + barcode, fully offline),
// leader mode against the real PIN backend, "Needs a location", deep links, and — when E2E_PROD=1 —
// production-mode checks against the backend serving the built dist.

const PIN = process.env.E2E_PIN ?? '246810';
const PROD = process.env.E2E_PROD === '1';
const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const tag = (info: TestInfo) => `${info.project.name === 'mobile-360' ? 'M' : 'D'}${RUN}`;
const LOCKED = { cookies: [], origins: [] };

/**
 * The leader token global-setup saved. playwright.config.ts also puts it in `use.extraHTTPHeaders`,
 * which Playwright applies to *browser* requests too — that would silently override the app's own
 * Authorization header. Tests that check the app's token handling turn that off and use this for API calls.
 */
function leaderHeader(): Record<string, string> {
  const dir = process.env.E2E_STATE_DIR;
  const file = dir ? path.join(dir, 'leader-token.txt') : '';
  const token = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  return token ? { Authorization: `Bearer ${token}` } : {};
}
const NO_GLOBAL_AUTH = { extraHTTPHeaders: {} as Record<string, string> };

interface ItemJson {
  id: number;
  code: string;
  locationCode: string | null;
}

async function create(request: APIRequestContext, body: Record<string, unknown>): Promise<ItemJson> {
  const res = await request.post('/api/items', { data: body, headers: leaderHeader() });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as ItemJson;
}

async function getItem(request: APIRequestContext, id: number): Promise<ItemJson> {
  return (await (await request.get(`/api/items/${id}`)).json()) as ItemJson;
}

/** Blocks (and records) every request that does not go to localhost — the app must work offline. */
async function blockExternal(page: Page): Promise<string[]> {
  const external: string[] = [];
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !url.protocol.startsWith('blob') && !url.protocol.startsWith('data')) {
      external.push(url.href);
      return route.abort();
    }
    return route.continue();
  });
  return external;
}

/** Collects console errors / page errors (CSP violations show up here). */
function watchConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
  });
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Image generation (in the browser's canvas, on about:blank — no network)

type Drawing =
  | { kind: 'label'; lines: string[]; noise?: number; rotate?: number; blur?: number }
  | { kind: 'nothing' }
  | { kind: 'ean13'; digits: string };

async function makePng(page: Page, drawing: Drawing): Promise<Buffer> {
  const dataUrl = await page.evaluate((d: Drawing) => {
    const c = document.createElement('canvas');
    c.width = 1200;
    c.height = 600;
    const ctx = c.getContext('2d')!;
    // A seeded PRNG so images are the same every run.
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    ctx.fillStyle = '#f4f1ea';
    ctx.fillRect(0, 0, c.width, c.height);

    if (d.kind === 'label') {
      ctx.save();
      ctx.translate(c.width / 2, c.height / 2);
      ctx.rotate(((d.rotate ?? 0) * Math.PI) / 180);
      if (d.blur) ctx.filter = `blur(${d.blur}px)`;
      ctx.fillStyle = '#151515';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const size = d.lines.length > 2 ? 72 : 110;
      ctx.font = `bold ${size}px Arial, Helvetica, "DejaVu Sans", sans-serif`;
      d.lines.forEach((line, i) => ctx.fillText(line, 0, (i - (d.lines.length - 1) / 2) * size * 1.3));
      ctx.restore();
      for (let i = 0; i < (d.noise ?? 0); i++) {
        const g = Math.floor(rnd() * 160);
        ctx.fillStyle = `rgb(${g},${g},${g})`;
        ctx.fillRect(rnd() * c.width, rnd() * c.height, 1 + rnd() * 2, 1 + rnd() * 2);
      }
    } else if (d.kind === 'nothing') {
      // A blurry "photo" of a shelf: soft blobs and gradients, no text, no bars.
      const grad = ctx.createLinearGradient(0, 0, c.width, c.height);
      grad.addColorStop(0, '#6b5a43');
      grad.addColorStop(1, '#c9b79a');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.filter = 'blur(18px)';
      for (let i = 0; i < 40; i++) {
        const g = 60 + Math.floor(rnd() * 150);
        ctx.fillStyle = `rgb(${g},${Math.floor(g * 0.9)},${Math.floor(g * 0.75)})`;
        ctx.beginPath();
        ctx.arc(rnd() * c.width, rnd() * c.height, 30 + rnd() * 120, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // EAN-13 encoder (L/G/R patterns + first-digit parity).
      const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
      const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
      const R = L.map((p) => [...p].map((b) => (b === '1' ? '0' : '1')).join(''));
      const PAR = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
      const n = [...d.digits].map(Number);
      const parity = PAR[n[0]!]!;
      let bits = '101';
      for (let i = 1; i <= 6; i++) bits += (parity[i - 1] === 'L' ? L : G)[n[i]!]!;
      bits += '01010';
      for (let i = 7; i <= 12; i++) bits += R[n[i]!]!;
      bits += '101';
      const mod = 6;
      const x0 = (c.width - bits.length * mod) / 2;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x0 - 12 * mod, 60, bits.length * mod + 24 * mod, 420);
      ctx.fillStyle = '#000000';
      [...bits].forEach((b, i) => {
        if (b === '1') ctx.fillRect(x0 + i * mod, 100, mod, 300);
      });
      ctx.font = '40px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(d.digits, c.width / 2, 450);
    }
    return c.toDataURL('image/png');
  }, drawing);
  return Buffer.from(dataUrl.split(',')[1]!, 'base64');
}

/** EAN-13 check digit for 12 digits. */
function ean13(twelve: string): string {
  const sum = [...twelve].reduce((s, ch, i) => s + Number(ch) * (i % 2 === 0 ? 1 : 3), 0);
  return twelve + String((10 - (sum % 10)) % 10);
}

async function scanPhoto(page: Page, png: Buffer, name: string) {
  await page.getByLabel(/Take a photo/).setInputFiles({ name, mimeType: 'image/png', buffer: png });
}

// =============================================================================================
test.describe('scan with real photos (offline OCR + barcode)', () => {
  test.setTimeout(180_000);

  test('brand/model label → OCR → the right item, with the text shown for editing', async ({ page, request }, info) => {
    const t = tag(info);
    const item = await create(request, {
      code: `E2E-SC1-${t}`,
      name: `Scan dome tent ${t}`,
      brand: 'Coleman',
      model: 'Sundome',
      locationCode: 'R06-D-2',
    });
    const external = await blockExternal(page);
    const problems = watchConsole(page);
    const png = await makePng(page, { kind: 'label', lines: ['COLEMAN', 'SUNDOME 4P', 'Made in China'] });

    await page.goto('/scan');
    await scanPhoto(page, png, 'label.png');
    await expect(page.getByTestId('scan-progress')).toBeVisible();
    await expect(page.getByLabel(/Fix any mistakes/)).toBeVisible({ timeout: 150_000 });
    await expect(page.getByLabel(/Fix any mistakes/)).toHaveValue(/COLEMAN/i);
    const card = page.getByTestId('item-card').filter({ hasText: item.code });
    await expect(card).toBeVisible();
    await expect(card).toContainText(/Matched on: .*brand/);
    await expect(card.getByTestId('location-badge')).toContainText('R06-D-2');
    expect(external).toEqual([]);
    expect(problems).toEqual([]);
    await request.delete(`/api/items/${item.id}`, { headers: leaderHeader() });
  });

  test('noisy, tilted code label "TNT-OO4" (letter O) finds TNT-004 first', async ({ page }) => {
    const external = await blockExternal(page);
    const png = await makePng(page, { kind: 'label', lines: ['TNT-OO4'], noise: 300, rotate: -2 });
    await page.goto('/scan');
    await scanPhoto(page, png, 'code.png');
    const first = page.getByTestId('item-card').first();
    await expect(first).toBeVisible({ timeout: 150_000 });
    await expect(first).toContainText('TNT-004');
    await expect(first).toContainText(/Matched on: .*item code/);
    await expect(first.getByTestId('location-badge')).toContainText('R01-B-2');
    expect(external).toEqual([]);
  });

  test('a photo with nothing readable gives the friendly no-match screen', async ({ page }) => {
    const external = await blockExternal(page);
    const png = await makePng(page, { kind: 'nothing' });
    await page.goto('/scan');
    await scanPhoto(page, png, 'shelf.png');
    await expect(page.getByText('No matching item found')).toBeVisible({ timeout: 150_000 });
    await expect(page.getByRole('button', { name: 'Try another photo' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Type to search' })).toHaveAttribute('href', '/');
    await expect(page.getByTestId('item-card')).toHaveCount(0);
    expect(external).toEqual([]);
  });

  test('an EAN-13 barcode photo finds the item by barcode and never loads the OCR engine', async ({ page, request }, info) => {
    const digits = ean13(info.project.name === 'mobile-360' ? '501234567890' : '400638133393');
    const item = await create(request, {
      code: `E2E-BC-${tag(info)}`,
      name: `Barcoded lantern ${tag(info)}`,
      barcode: digits,
      locationCode: 'R05-C-4',
    });
    const external = await blockExternal(page);
    const ocrRequests: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/ocr/')) ocrRequests.push(r.url());
    });
    const png = await makePng(page, { kind: 'ean13', digits });
    await page.goto('/scan');
    await scanPhoto(page, png, 'barcode.png');
    await expect(page.getByTestId('scan-barcode')).toContainText(digits, { timeout: 60_000 });
    const card = page.getByTestId('item-card');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(item.code);
    await expect(card).toContainText('Matched on: barcode');
    await expect(card.getByTestId('location-badge')).toContainText('R05-C-4');
    expect(ocrRequests).toEqual([]);
    expect(external).toEqual([]);
    await request.delete(`/api/items/${item.id}`, { headers: leaderHeader() });
  });

  test('editing the recognised text and searching again finds the item', async ({ page }) => {
    await blockExternal(page);
    const png = await makePng(page, { kind: 'nothing' });
    await page.goto('/scan');
    await scanPhoto(page, png, 'shelf.png');
    const box = page.getByLabel(/Fix any mistakes/);
    await expect(box).toBeVisible({ timeout: 150_000 });
    await box.fill('tnt 0O4 dome');
    await page.getByRole('button', { name: 'Search with this text' }).click();
    await expect(page.getByTestId('item-card').first()).toContainText('TNT-004');
  });
});

// =============================================================================================
test.describe('leader mode against the real PIN', () => {
  test.use({ storageState: LOCKED, ...NO_GLOBAL_AUTH });

  test('locked Edit → PIN → edit form; Lock leaves leader mode; storage is cleared', async ({ page }) => {
    await page.goto('/?q=TNT-004');
    await page.getByTestId('item-card').first().getByRole('link').click();
    await page.getByRole('link', { name: /Edit item/ }).click();
    const dialog = page.getByRole('dialog', { name: /Leader PIN/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('PIN')).toBeFocused();
    await expect(dialog.getByLabel('PIN')).toHaveAttribute('inputmode', 'numeric');
    await dialog.getByLabel('PIN').fill(PIN);
    await dialog.getByRole('button', { name: 'Unlock' }).click();
    await expect(page).toHaveURL(/\/items\/\d+\/edit$/);
    expect(await page.evaluate(() => localStorage.getItem('etroop.leaderToken'))).toContain('token');
    await page.getByTestId('leader-button').click();
    await expect(page.getByTestId('leader-button')).toHaveAccessibleName(/Leader mode off/);
    expect(await page.evaluate(() => localStorage.getItem('etroop.leaderToken'))).toBeNull();
  });

  test('wrong PIN keeps the dialog open with a message and the PIN box ready to type again', async ({ page }, info) => {
    // A real wrong PIN counts toward the 5-per-5-minutes limit, so only one project sends one.
    if (info.project.name === 'mobile-360') {
      await page.route('**/api/auth/login', (route) =>
        route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Wrong PIN.' } }) }),
      );
    }
    await page.goto('/');
    await page.getByTestId('leader-button').click();
    const dialog = page.getByRole('dialog', { name: /Leader PIN/ });
    await dialog.getByLabel('PIN').fill('9999');
    await dialog.getByRole('button', { name: 'Unlock' }).click();
    await expect(dialog.getByRole('alert')).toContainText("That PIN isn't right");
    await expect(dialog.getByLabel('PIN')).toHaveValue('');
    await expect(dialog.getByLabel('PIN')).toBeFocused();
  });

  test('429 from the server shows "wait 5 minutes"', async ({ page }) => {
    await page.route('**/api/auth/login', (route) =>
      route.fulfill({
        status: 429,
        headers: { 'Retry-After': '300' },
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Too many wrong PIN attempts.', details: { retryAfterSeconds: 300 } } }),
      }),
    );
    await page.goto('/');
    await page.getByTestId('leader-button').click();
    const dialog = page.getByRole('dialog', { name: /Leader PIN/ });
    await dialog.getByLabel('PIN').fill(PIN);
    await dialog.getByRole('button', { name: 'Unlock' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Too many wrong tries — wait 5 minutes');
  });

  test('403 setup-needed from the server explains set-pin', async ({ page }) => {
    await page.route('**/api/auth/login', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Leader PIN not set. Run set-pin on the laptop.' } }),
      }),
    );
    await page.goto('/');
    await page.getByTestId('leader-button').click();
    await page.getByRole('dialog').getByLabel('PIN').fill(PIN);
    await page.getByRole('dialog').getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByRole('dialog', { name: /not set up/ })).toContainText('set-pin');
  });

  test('a stored token the server no longer accepts is dropped on start', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('etroop.leaderToken', JSON.stringify({ token: 'forged.token' })));
    await page.goto('/');
    await expect(page.getByTestId('leader-button')).toHaveAccessibleName(/Leader mode off/);
  });

  test('401 mid-session: the save re-prompts for the PIN and then goes through (once)', async ({ page, request }, info) => {
    const item = await create(request, { code: `E2E-401-${tag(info)}`, name: 'Mid-session item' });
    const puts: number[] = [];
    page.on('response', (r) => {
      if (r.request().method() === 'PUT' && r.url().includes(`/api/items/${item.id}`)) puts.push(r.status());
    });
    // Unlock for real, then corrupt the token behind the app's back (like a PIN change on the laptop).
    await page.goto(`/items/${item.id}/edit`);
    await page.getByTestId('leader-button').click();
    await page.getByRole('dialog').getByLabel('PIN').fill(PIN);
    await page.getByRole('dialog').getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByTestId('leader-button')).toHaveAccessibleName(/Leader mode on/);
    await page.evaluate(() => localStorage.setItem('etroop.leaderToken', JSON.stringify({ token: 'stale.token' })));
    await page.getByLabel('Location').fill('R02-B-3');
    await page.getByRole('button', { name: 'Save changes' }).click();
    const dialog = page.getByRole('dialog', { name: /Leader PIN/ });
    await expect(dialog).toContainText(/session has ended/);
    await dialog.getByLabel('PIN').fill(PIN);
    await dialog.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByText('Changes saved.')).toBeVisible();
    expect(puts).toEqual([401, 200]);
    expect((await getItem(request, item.id)).locationCode).toBe('R02-B-3');
    await request.delete(`/api/items/${item.id}`, { headers: leaderHeader() });
  });

  test('locked import: choosing a file asks for the PIN, then the dry run runs', async ({ page }) => {
    await page.goto('/import');
    await page.getByLabel('Excel or CSV file').setInputFiles({
      name: 'one.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('Code,Name\nE2E-LCK-IMP,Locked import\n'),
    });
    const dialog = page.getByRole('dialog', { name: /Leader PIN/ });
    await dialog.getByLabel('PIN').fill(PIN);
    await dialog.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByTestId('import-preview')).toContainText('E2E-LCK-IMP');
  });
});

// =============================================================================================
test.describe('needs a location', () => {
  async function seedUnlocated(request: APIRequestContext, info: TestInfo, n: number) {
    const t = tag(info);
    const items: ItemJson[] = [];
    for (let i = 1; i <= n; i++) items.push(await create(request, { code: `E2E-NL-${t}-${i}`, name: `Unplaced ${t} ${i}` }));
    return { t, items };
  }
  const box = (page: Page, t: string, i: number) => page.getByLabel(`Location for Unplaced ${t} ${i} (E2E-NL-${t}-${i})`);

  test('Enter saves and moves focus to the next box; rack prefix; invalid text refused', async ({ page, request }, info) => {
    const { t, items } = await seedUnlocated(request, info, 3);
    await page.goto('/locate');
    await box(page, t, 1).fill('R07-A-1');
    await box(page, t, 1).press('Enter');
    await expect(box(page, t, 2)).toBeFocused();
    await expect(box(page, t, 1)).toHaveCount(0);

    await page.getByLabel('Rack prefix (optional)').fill('r7');
    await box(page, t, 2).fill('behind the door');
    await box(page, t, 2).press('Enter');
    await expect(page.getByTestId('locate-row').filter({ hasText: `E2E-NL-${t}-2` })).toContainText(/isn't a rack coordinate/);
    await expect(box(page, t, 2)).toBeFocused();
    await box(page, t, 2).fill('c-2');
    await expect(page.getByTestId('locate-row').filter({ hasText: `E2E-NL-${t}-2` })).toContainText('R07-C-2');
    await box(page, t, 2).press('Enter');
    await expect(box(page, t, 3)).toBeFocused();

    expect((await getItem(request, items[0]!.id)).locationCode).toBe('R07-A-1');
    expect((await getItem(request, items[1]!.id)).locationCode).toBe('R07-C-2');
    expect((await getItem(request, items[2]!.id)).locationCode).toBeNull();
    for (const it of items) await request.delete(`/api/items/${it.id}`, { headers: leaderHeader() });
  });

  test.describe('locked', () => {
    test.use({ storageState: LOCKED, ...NO_GLOBAL_AUTH });
    test('Enter asks for the PIN once, then saves and moves focus to the next box', async ({ page, request }, info) => {
      const { t, items } = await seedUnlocated(request, info, 2);
      await page.goto('/locate');
      await box(page, t, 1).fill('R07-B-1');
      await box(page, t, 1).press('Enter');
      const dialog = page.getByRole('dialog', { name: /Leader PIN/ });
      await dialog.getByLabel('PIN').fill(PIN);
      await dialog.getByLabel('PIN').press('Enter');
      await expect(box(page, t, 1)).toHaveCount(0);
      await expect(box(page, t, 2)).toBeFocused();
      expect((await getItem(request, items[0]!.id)).locationCode).toBe('R07-B-1');
      for (const it of items) await request.delete(`/api/items/${it.id}`, { headers: leaderHeader() });
    });
  });

  test('empty state when nothing needs a location', async ({ page }) => {
    await page.route('**/api/items?unlocated=true', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
    );
    await page.goto('/locate');
    await expect(page.getByText('Every item has a location')).toBeVisible();
  });

  test('the Search badge and the Map note link to /locate', async ({ page, request }, info) => {
    const { items } = await seedUnlocated(request, info, 1);
    await page.goto('/');
    await page.getByTestId('unlocated-badge').click();
    await expect(page).toHaveURL(/\/locate$/);
    await page.goto('/map');
    await page.getByRole('link', { name: /location/i }).first().click();
    await expect(page).toHaveURL(/\/locate$/);
    for (const it of items) await request.delete(`/api/items/${it.id}`, { headers: leaderHeader() });
  });
});

// =============================================================================================
test.describe('deep links (full page loads)', () => {
  for (const [url, heading] of [
    ['/scan', 'Scan a label'],
    ['/locate', 'Needs a location'],
    ['/items/new', 'Add an item'],
    ['/import', 'Import from Excel'],
    ['/racks/r1', 'Rack R01'],
  ] as const) {
    test(`${url} loads directly and after a reload`, async ({ page }) => {
      const problems = watchConsole(page);
      await page.goto(url);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await page.reload();
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      expect(problems).toEqual([]);
    });
  }
});

// =============================================================================================
test.describe('production build served by the backend (E2E_PROD=1)', () => {
  test.skip(!PROD, 'set E2E_PROD=1 and point E2E_BASE_URL at the backend serving the built dist');

  test('security headers, caching and content types', async ({ request }) => {
    const index = await request.get('/');
    expect(index.status()).toBe(200);
    const csp = index.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(index.headers()['x-frame-options']).toBe('DENY');
    expect(index.headers()['cache-control']).toContain('no-cache');
    const html = await index.text();
    expect(html).not.toMatch(/<script>(?!\s*<\/script>)/); // no inline scripts
    const asset = /\/assets\/[^"]+\.js/.exec(html)?.[0];
    expect(asset).toBeTruthy();
    const js = await request.get(asset!);
    expect(js.headers()['cache-control']).toContain('immutable');
    expect((await request.get('/assets/does-not-exist.js')).status()).toBe(404);
    const deep = await request.get('/locate');
    expect(deep.status()).toBe(200);
    expect(await deep.text()).toContain('<div id="root">');
    for (const f of ['worker.min.js', 'tesseract-core-simd-lstm.wasm.js', 'eng.traineddata.gz']) {
      const res = await request.get(`/ocr/${f}`);
      expect(res.status(), f).toBe(200);
    }
    expect((await request.get('/api/health')).headers()['cache-control']).toContain('no-store');
  });

  test('scan with OCR works under the production CSP (no violations, no external requests)', async ({ page }) => {
    test.setTimeout(180_000);
    const external = await blockExternal(page);
    const problems = watchConsole(page);
    const png = await makePng(page, { kind: 'label', lines: ['TNT-004'] });
    await page.goto('/scan');
    await scanPhoto(page, png, 'code.png');
    await expect(page.getByTestId('item-card').first()).toContainText('TNT-004', { timeout: 150_000 });
    expect(external).toEqual([]);
    expect(problems.filter((p) => /Content Security Policy|Refused to/i.test(p))).toEqual([]);
    expect(problems).toEqual([]);
  });
});
