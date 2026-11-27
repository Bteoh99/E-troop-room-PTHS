import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { leaderHeaders } from './leader';

// End-to-end against the real backend (temp DB + seed) and the Vite dev server.
// Every test runs in both projects (desktop 1280 px, mobile-360) against the SAME database,
// so anything a test creates uses a code unique to the project + run.

const here = path.dirname(fileURLToPath(import.meta.url));
// exceljs is a backend dependency; borrow it (read-only) to generate a real .xlsx.
const requireFromBackend = createRequire(path.resolve(here, '../../backend/package.json'));

const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const tag = (info: TestInfo) => `${info.project.name === 'mobile-360' ? 'M' : 'D'}${RUN}`;

interface ItemJson {
  id: number;
  code: string;
  name: string;
  locationCode: string | null;
  quantity: number;
}

async function createViaApi(request: APIRequestContext, body: Record<string, unknown>): Promise<ItemJson> {
  const res = await request.post('/api/items', { data: body, headers: leaderHeaders() });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as ItemJson;
}

async function findByCode(request: APIRequestContext, code: string): Promise<ItemJson | undefined> {
  const res = await request.get(`/api/items?q=${encodeURIComponent(code)}`);
  const { items } = (await res.json()) as { items: ItemJson[] };
  return items.find((i) => i.code === code);
}

async function expectNoHorizontalScroll(page: Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, 'page must not scroll sideways').toBeLessThanOrEqual(innerWidth);
}

test.describe('search → detail → map', () => {
  test('find a seeded item, see its rack/shelf/bin highlighted, and drill into the rack', async ({ page }) => {
    await page.goto('/');
    const search = page.getByRole('searchbox', { name: /search/i });
    await expect(search).toBeFocused();
    await search.fill('dome');
    await expect(page).toHaveURL(/\?q=dome$/);
    const card = page.getByTestId('item-card').filter({ hasText: 'TNT-004' });
    await expect(card).toHaveCount(1);
    await expect(card.getByTestId('location-badge')).toHaveText(/📍.*R01-B-2/);
    await expect(card).toContainText('Rack 01 · Shelf B · Bin 2');

    await card.getByRole('link', { name: '4-man dome tent' }).click();
    await expect(page).toHaveURL(/\/items\/\d+$/);
    await expect(page.getByRole('heading', { level: 1, name: '4-man dome tent' })).toBeVisible();
    await expect(page.getByTestId('location-badge').first()).toContainText('R01-B-2');

    const diagram = page.getByTestId('rack-diagram');
    const hit = diagram.locator('[data-highlighted="true"]');
    await expect(hit).toHaveCount(1);
    await expect(hit).toHaveAttribute('data-bin', '2');
    await expect(diagram.locator('[data-shelf="B"]')).toContainText('here');
    await expect(diagram.locator('[data-shelf]').first()).toHaveAttribute('data-shelf', 'A');

    const map = page.getByTestId('store-map');
    await expect(map.locator('[data-highlighted="true"]')).toHaveCount(1);
    await expect(map.locator('[data-highlighted="true"]')).toHaveAttribute('data-rack', 'R01');
    await expectNoHorizontalScroll(page);

    // Back returns to the same search.
    await page.getByRole('link', { name: /^Back$/ }).click();
    await expect(page).toHaveURL(/\?q=dome$/);
    await expect(search).toHaveValue('dome');
    await expect(page.getByTestId('item-card').filter({ hasText: 'TNT-004' })).toBeVisible();

    // Detail → rack view.
    await card.getByRole('link', { name: '4-man dome tent' }).click();
    await page.getByRole('link', { name: 'See everything on rack R01' }).click();
    await expect(page).toHaveURL(/\/racks\/R01$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Rack R01' })).toBeVisible();
    await expect(page.getByRole('region', { name: /Shelf B/ })).toContainText('4-man dome tent');
  });

  test('searching by a loose coordinate finds items in that rack/shelf', async ({ page }) => {
    await page.goto('/?q=r3-b');
    await expect(page.getByTestId('item-card').first()).toBeVisible();
    const badges = await page.getByTestId('location-badge').allTextContents();
    expect(badges.length).toBeGreaterThan(0);
    for (const b of badges) expect(b).toContain('R03-B');
  });

  test('no-match search shows the empty state', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('searchbox').fill('zzzz-no-such-thing');
    await expect(page.getByText('No items match “zzzz-no-such-thing”')).toBeVisible();
    await expect(page.getByTestId('item-card')).toHaveCount(0);
  });

  test('map page: tiles with counts, tap a rack to see its shelves', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Map' }).click();
    await expect(page).toHaveURL(/\/map$/);
    const map = page.getByTestId('store-map');
    for (const r of ['R01', 'R02', 'R03', 'R04', 'R05', 'R06']) {
      await expect(map.locator(`[data-rack="${r}"]`)).toBeVisible();
    }
    await expectNoHorizontalScroll(page);
    await map.getByRole('link', { name: /^Rack R03, \d+ items?/ }).click();
    await expect(page).toHaveURL(/\/racks\/R03$/);
    await expect(page.getByRole('region', { name: /Shelf A/ })).toContainText('Manila rope 10 m');
    // Loose rack param is accepted.
    await page.goto('/racks/r3');
    await expect(page.getByRole('heading', { level: 1, name: 'Rack R03' })).toBeVisible();
  });

  test('unknown item id shows not-found', async ({ page }) => {
    await page.goto('/items/999999');
    await expect(page.getByText("We couldn't find that item")).toBeVisible();
  });
});

test.describe('add / edit / delete', () => {
  test('add an item: validation, live location preview, save, then find it', async ({ page }, info) => {
    const code = `E2E-ADD-${tag(info)}`;
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Add' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Add an item' })).toBeVisible();

    await page.getByRole('button', { name: 'Add item' }).click();
    const summary = page.getByRole('alert');
    await expect(summary).toContainText('Please enter an item code');
    await expect(summary).toContainText('Please enter a name');
    await expect(summary).toBeFocused();

    await page.getByLabel(/item code/i).fill(code.toLowerCase());
    await page.getByLabel(/^name/i).fill('E2E bivvy bag');
    await page.getByLabel('Location').fill('r6 c 3');
    const preview = page.getByTestId('location-preview');
    await expect(preview).toContainText('Will be saved as');
    await expect(preview.getByTestId('location-badge')).toContainText('R06-C-3');
    await expect(preview).toContainText('Rack 06 · Shelf C · Bin 3');
    await page.getByLabel('Category').fill('Tents');
    await page.getByLabel('Quantity').fill('2');
    await page.getByLabel('Condition').selectOption('needs_repair');
    await expectNoHorizontalScroll(page);
    await page.getByRole('button', { name: 'Add item' }).click();

    await expect(page).toHaveURL(/\/items\/\d+$/);
    await expect(page.getByText('Added “E2E bivvy bag”.')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'E2E bivvy bag' })).toBeVisible();
    await expect(page.getByText(code, { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId('rack-diagram').locator('[data-highlighted="true"]')).toHaveAttribute('data-bin', '3');

    await page.goto('/');
    await page.getByRole('searchbox').fill(code);
    const card = page.getByTestId('item-card').filter({ hasText: code });
    await expect(card).toHaveCount(1);
    await expect(card.getByTestId('location-badge')).toContainText('R06-C-3');
    await expect(card).toContainText('Needs repair');
  });

  test('duplicate code is rejected with a message on the code field', async ({ page }) => {
    await page.goto('/items/new');
    await page.getByLabel(/item code/i).fill('tnt-004');
    await page.getByLabel(/^name/i).fill('Another dome tent');
    await page.getByRole('button', { name: 'Add item' }).click();
    await expect(page.getByRole('alert')).toContainText('That item code is already taken.');
    await expect(page.getByLabel(/item code/i)).toHaveAttribute('aria-invalid', 'true');
    await expect(page).toHaveURL(/\/items\/new$/);
  });

  test('edit an item: change location and quantity, see it on the detail page and map', async ({ page, request }, info) => {
    const code = `E2E-EDIT-${tag(info)}`;
    const item = await createViaApi(request, { code, name: 'E2E lantern', locationCode: 'R05-A-1', quantity: 1 });
    await page.goto(`/items/${item.id}`);
    await page.getByRole('link', { name: 'Edit item' }).click();
    await expect(page).toHaveURL(new RegExp(`/items/${item.id}/edit$`));
    await expect(page.getByLabel('Location')).toHaveValue('R05-A-1');

    await page.getByLabel('Location').fill('2/d/4');
    await expect(page.getByTestId('location-preview')).toContainText('R02-D-4');
    await page.getByLabel('Quantity').fill('9');
    await page.getByLabel('Notes').fill('Moved during stocktake');
    await page.getByRole('button', { name: 'Save changes' }).click();

    await expect(page).toHaveURL(new RegExp(`/items/${item.id}$`));
    await expect(page.getByText('Changes saved.')).toBeVisible();
    await expect(page.getByText('9 pcs')).toBeVisible();
    await expect(page.getByText('Moved during stocktake')).toBeVisible();
    await expect(page.getByTestId('location-badge').first()).toContainText('R02-D-4');
    const map = page.getByTestId('store-map');
    await expect(map.locator('[data-highlighted="true"]')).toHaveAttribute('data-rack', 'R02');

    const saved = await findByCode(request, code);
    expect(saved).toMatchObject({ locationCode: 'R02-D-4', quantity: 9 });
  });

  test('after saving an edit, Back on the detail page returns to the search (not the edit form)', async ({ page, request }, info) => {
    const code = `E2E-BACK-${tag(info)}`;
    await createViaApi(request, { code, name: 'E2E back-nav tarp', locationCode: 'R06-C-1' });
    await page.goto(`/?q=${code}`);
    await page.getByTestId('item-card').getByRole('link', { name: 'E2E back-nav tarp' }).click();
    await page.getByRole('link', { name: 'Edit item' }).click();
    await page.getByLabel('Quantity').fill('5');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Changes saved.')).toBeVisible();
    await page.getByRole('link', { name: /^Back$/ }).click();
    await expect(page).toHaveURL(new RegExp(`\\?q=${code}$`));
  });

  test('delete asks for confirmation; cancel keeps it, confirm removes it', async ({ page, request }, info) => {
    const code = `E2E-DEL-${tag(info)}`;
    const item = await createViaApi(request, { code, name: 'E2E broken mallet', locationCode: 'R04' });
    await page.goto(`/items/${item.id}`);
    await page.getByRole('button', { name: 'Delete' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete this item?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(await findByCode(request, code)).toBeDefined();

    await page.getByRole('button', { name: 'Delete' }).click();
    await dialog.getByRole('button', { name: 'Yes, delete' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText(`Deleted “E2E broken mallet” (${code}).`)).toBeVisible();
    expect(await findByCode(request, code)).toBeUndefined();
  });
});

test.describe('import', () => {
  async function makeXlsx(info: TestInfo, rows: unknown[][]): Promise<string> {
    const ExcelJS = requireFromBackend('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Inventori');
    ws.addRow(['Senarai stor 2026']); // title row above the header
    ws.addRow(['Kod', 'Nama', 'Lokasi', 'Kategori', 'Qty', 'Keadaan', 'Colour']);
    for (const r of rows) ws.addRow(r);
    const file = path.join(os.tmpdir(), `etroop-e2e-${tag(info)}-${info.title.length}.xlsx`);
    await wb.xlsx.writeFile(file);
    return file;
  }

  test('upload a small .xlsx → dry-run preview → confirm → items are searchable', async ({ page, request }, info) => {
    const t = tag(info);
    const existing = await createViaApi(request, { code: `E2E-UPD-${t}`, name: 'E2E old rope', quantity: 1 });
    const file = await makeXlsx(info, [
      [`e2e-new-${t}`, 'E2E imported tent', 'r2 b 3', 'Tents', 3, 'baik', 'green'],
      [`E2E-UPD-${t}`, 'E2E updated rope', 'R03-C-1', 'Ropes', 7, 'rosak', ''],
      [`E2E-BAD-${t}`, '', 'R01', '', 1, '', ''],
      [`E2E-WARN-${t}`, 'E2E odd condition', 'R04-A', '', 1, 'meh', ''],
    ]);

    await page.goto('/import');
    await page.getByLabel('Excel or CSV file').setInputFiles(file);
    const counts = page.getByTestId('import-counts');
    await expect(counts).toBeVisible();
    const stat = (label: string) => counts.locator('div', { has: page.getByText(label, { exact: true }) }).locator('dd');
    await expect(stat('Will be added')).toHaveText('2');
    await expect(stat('Will be updated')).toHaveText('1');
    await expect(stat('Will be skipped')).toHaveText('1');
    await expect(stat('Problems')).toHaveText('1');
    await expect(stat('Warnings')).toHaveText('1');
    await expect(page.getByTestId('import-problems')).toContainText(/name/i);
    await expect(page.getByTestId('import-warnings')).toContainText('meh');
    await expect(page.getByText(/will be ignored/)).toContainText('Colour');
    const preview = page.getByTestId('import-preview');
    await expect(preview).toContainText(`E2E-NEW-${t}`);
    await expect(preview).toContainText('R02-B-3');
    await expect(preview.getByRole('row').filter({ hasText: `E2E-UPD-${t}` })).toContainText('Update');
    await expectNoHorizontalScroll(page);
    // Dry run wrote nothing.
    expect(await findByCode(request, `E2E-NEW-${t}`)).toBeUndefined();

    await page.getByRole('button', { name: 'Confirm import' }).click();
    await expect(page.getByRole('heading', { name: /Import finished/ })).toBeVisible();
    await expect(stat('Added')).toHaveText('2');
    await expect(stat('Updated')).toHaveText('1');

    expect(await findByCode(request, `E2E-NEW-${t}`)).toMatchObject({ locationCode: 'R02-B-3', quantity: 3 });
    expect(await findByCode(request, `E2E-UPD-${t}`)).toMatchObject({
      id: existing.id,
      name: 'E2E updated rope',
      locationCode: 'R03-C-1',
    });

    await page.getByRole('link', { name: 'Search items' }).click();
    await page.getByRole('searchbox').fill('E2E imported tent');
    await expect(page.getByTestId('item-card').filter({ hasText: `E2E-NEW-${t}` }).getByTestId('location-badge')).toContainText(
      'R02-B-3',
    );
    fs.rmSync(file, { force: true });
  });

  test('a file without code/name columns gets a friendly explanation', async ({ page }, info) => {
    const file = path.join(os.tmpdir(), `etroop-e2e-${tag(info)}-bad.csv`);
    fs.writeFileSync(file, 'Barang,Berapa\nKhemah,2\n');
    await page.goto('/import');
    await page.getByLabel('Excel or CSV file').setInputFiles(file);
    const alert = page.getByRole('alert');
    await expect(alert).toContainText("Couldn't check that file");
    await expect(alert).toContainText(/We couldn't find the .*column/);
    await expect(alert).toContainText('Barang');
    await expect(alert.getByRole('link', { name: 'Download the template' })).toBeVisible();
    fs.rmSync(file, { force: true });
  });

  test('wrong file type is refused before upload', async ({ page }, info) => {
    const file = path.join(os.tmpdir(), `etroop-e2e-${tag(info)}.xls`);
    fs.writeFileSync(file, 'not really excel');
    await page.goto('/import');
    await page.getByLabel('Excel or CSV file').setInputFiles(file);
    await expect(page.getByRole('alert')).toContainText('Please choose an Excel (.xlsx) or CSV (.csv) file.');
    fs.rmSync(file, { force: true });
  });

  test('the template downloads as item-template.xlsx', async ({ page }) => {
    await page.goto('/import');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name: /Download the template/ }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('item-template.xlsx');
    const p = await download.path();
    const head = fs.readFileSync(p).subarray(0, 2).toString('latin1');
    expect(head).toBe('PK'); // a real xlsx (zip) file
  });
});

test('main screens render without page errors or console errors', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
  });
  for (const url of ['/', '/?q=rope', '/map', '/racks/R02', '/items/new', '/import', '/nope']) {
    await page.goto(url);
    await page.waitForLoadState('networkidle');
  }
  await page.goto('/?q=TNT-004');
  await page.getByTestId('item-card').first().getByRole('link').click();
  await expect(page.getByTestId('store-map')).toBeVisible();
  await page.getByRole('link', { name: 'Edit item' }).click();
  await expect(page.getByLabel('Location')).toBeVisible();
  expect(problems).toEqual([]);
});

test.describe('mobile 360 px layout', () => {
  test('bottom tab bar, no sideways scrolling on any screen', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile-360', 'mobile-only checks');
    const nav = page.getByRole('navigation', { name: 'Main' });
    for (const url of ['/', '/?q=tent', '/map', '/racks/R01', '/items/new', '/import']) {
      await page.goto(url);
      await expect(page.locator('main')).toBeVisible();
      await page.waitForLoadState('networkidle');
      await expectNoHorizontalScroll(page);
      const box = await nav.boundingBox();
      expect(box, `nav visible on ${url}`).not.toBeNull();
      const vh = page.viewportSize()?.height ?? 740;
      expect(box!.y + box!.height, `tab bar sits at the bottom on ${url}`).toBeGreaterThan(vh - 5);
      for (const name of ['Search', 'Map', 'Add', 'Import']) {
        const link = nav.getByRole('link', { name });
        const b = await link.boundingBox();
        expect(b!.height, `${name} tab ≥ 44 px tall`).toBeGreaterThanOrEqual(44);
      }
    }
    // An item detail page too.
    await page.goto('/?q=TNT-004');
    await page.getByTestId('item-card').first().getByRole('link').click();
    await expect(page.getByTestId('rack-diagram')).toBeVisible();
    await expectNoHorizontalScroll(page);
    // The last button on a long page is reachable above the tab bar.
    const del = page.getByRole('button', { name: 'Delete' });
    await del.scrollIntoViewIfNeeded();
    const navBox = await nav.boundingBox();
    const delBox = await del.boundingBox();
    expect(delBox!.y + delBox!.height).toBeLessThanOrEqual(navBox!.y + 1);
  });
});
