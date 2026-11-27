import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { leaderHeaders } from './leader';

// Round-2 regression + "try to break it" e2e (frontend tester). Runs in desktop and mobile-360.
// Each test creates its own data with codes unique to the project + run (both projects share one DB).

const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const tag = (info: TestInfo) => `${info.project.name === 'mobile-360' ? 'M' : 'D'}${RUN}`;
// Separate racks per project so the "many bins" rack stays predictable.
const wideRack = (info: TestInfo) => (info.project.name === 'mobile-360' ? 'R09' : 'R08');

async function create(request: APIRequestContext, body: Record<string, unknown>): Promise<{ id: number }> {
  const res = await request.post('/api/items', { data: body, headers: leaderHeaders() });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { id: number };
}

async function pageOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

const navLink = (page: Page, name: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name });

test.describe('rack diagram with many bins', () => {
  test('30 bins: highlighted bin is visible, readable and the page never scrolls sideways', async ({ page, request }, info) => {
    const t = tag(info);
    const rack = wideRack(info);
    const created: { id: number }[] = [];
    for (let bin = 1; bin <= 30; bin++) {
      created.push(await create(request, { code: `E2E-W${bin}-${t}`, name: `Wide bin ${bin}`, locationCode: `${rack}-B-${bin}` }));
    }
    const target = await create(request, { code: `E2E-WT-${t}`, name: 'Wide target', locationCode: `${rack}-C-27` });

    await page.goto(`/items/${target.id}`);
    const diagram = page.getByTestId('rack-diagram');
    const hit = diagram.locator('[data-highlighted="true"]');
    await expect(hit).toHaveCount(1);
    await expect(hit).toHaveAttribute('data-bin', '27');
    await expect(diagram.locator('[data-shelf="B"] [data-bin]')).toHaveCount(30);
    const vw = page.viewportSize()!.width;
    const box = (await hit.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vw);
    expect(box.width).toBeGreaterThanOrEqual(24);
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);

    await page.goto(`/racks/${rack}`);
    await expect(page.getByRole('heading', { level: 1, name: `Rack ${rack}` })).toBeVisible();
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
    // The bin numbers in the rack view stay legible (not squashed to nothing).
    const b30 = (await page.getByTestId('rack-diagram').locator('[data-shelf="B"] [data-bin="30"]').boundingBox())!;
    expect(b30.width).toBeGreaterThanOrEqual(24);

    for (const c of [...created, target]) await request.delete(`/api/items/${c.id}`, { headers: leaderHeaders() });
  });

  test('bin 0 (accepted as R0x-A-0) is still highlighted on the detail page', async ({ page, request }, info) => {
    const item = await create(request, { code: `E2E-B0-${tag(info)}`, name: 'Bin zero', locationCode: 'r6-a-0' });
    await page.goto(`/items/${item.id}`);
    await expect(page.getByTestId('location-badge').first()).toContainText('R06-A-0');
    await expect(page.getByTestId('rack-diagram').locator('[data-highlighted="true"]')).toHaveCount(1);
    await request.delete(`/api/items/${item.id}`, { headers: leaderHeaders() });
  });
});

test.describe('history', () => {
  test('search → item → edit → save → browser Back returns to the search', async ({ page, request }, info) => {
    const code = `E2E-H1-${tag(info)}`;
    await create(request, { code, name: 'History tarp', locationCode: 'R06-C-1' });
    await page.goto(`/?q=${code}`);
    await page.getByTestId('item-card').getByRole('link').click();
    await page.getByRole('link', { name: 'Edit item' }).click();
    await page.getByLabel('Quantity').fill('3');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Changes saved.')).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`\\?q=${code}$`));
    await expect(page.getByRole('searchbox')).toHaveValue(code);
    // Forward goes to the item again, not to a stale form.
    await page.goForward();
    await expect(page).toHaveURL(/\/items\/\d+$/);
  });

  test('delete → browser Back does not show a "not found" page', async ({ page, request }, info) => {
    const code = `E2E-H2-${tag(info)}`;
    await create(request, { code, name: 'History delete', locationCode: 'R04' });
    await page.goto(`/?q=${code}`);
    await page.getByTestId('item-card').getByRole('link').click();
    await page.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Yes, delete' }).click();
    await expect(page.getByText(`Deleted “History delete” (${code}).`)).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`\\?q=${code}$`));
    await expect(page.getByText("We couldn't find that item")).toHaveCount(0);
  });

  test('edit opened by URL → Cancel → Back does not reopen the cancelled form', async ({ page, request }, info) => {
    const item = await create(request, { code: `E2E-H3-${tag(info)}`, name: 'History cancel', locationCode: 'R02' });
    await page.goto(`/items/${item.id}/edit`);
    await page.getByRole('link', { name: 'Cancel' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'History cancel' })).toBeVisible();
    await page.getByRole('link', { name: /^Back$/ }).click();
    await expect(page).not.toHaveURL(/\/edit$/);
    await expect(page).toHaveURL(/\/$/);
  });

  test('edit opened by URL → save → Back stays in the app (goes to search)', async ({ page, request }, info) => {
    const item = await create(request, { code: `E2E-H4-${tag(info)}`, name: 'History direct', locationCode: 'R02' });
    await page.goto(`/items/${item.id}/edit`);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Changes saved.')).toBeVisible();
    await page.getByRole('link', { name: /^Back$/ }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Find an item' })).toBeVisible();
  });
});

test.describe('search tab, category URL, focus', () => {
  test('Search tab clears the query; browser Back restores it', async ({ page }) => {
    await page.goto('/?q=rope');
    await expect(page.getByTestId('item-card').first()).toBeVisible();
    const filtered = await page.getByTestId('item-card').count();
    await navLink(page, 'Search').click();
    await expect(page.getByRole('searchbox')).toHaveValue('');
    await expect(page).toHaveURL(/\/$/);
    await expect.poll(() => page.getByTestId('item-card').count()).toBeGreaterThan(filtered);
    await page.goBack();
    await expect(page.getByRole('searchbox')).toHaveValue('rope');
    await expect.poll(() => page.getByTestId('item-card').count()).toBe(filtered);
  });

  test('unknown category in the URL is shown and explained', async ({ page }) => {
    await page.goto('/?category=No%20Such%20Category');
    await expect(page.getByRole('combobox', { name: 'Category' })).toHaveValue('No Such Category');
    await expect(page.getByText('No items in this category')).toBeVisible();
  });

  test('focus moves to the new page h1 after a link, and stays in the search box when searching', async ({ page }) => {
    await page.goto('/');
    const box = page.getByRole('searchbox');
    await box.fill('TNT-004');
    await expect(page).toHaveURL(/\?q=TNT-004$/);
    await expect(box).toBeFocused();
    await page.getByTestId('item-card').first().getByRole('link').click();
    await expect(page.getByRole('heading', { level: 1, name: '4-man dome tent' })).toBeFocused();
    await navLink(page, 'Map').click();
    await expect(page.getByRole('heading', { level: 1, name: 'Store-room map' })).toBeFocused();
    // Once the map has loaded the h1 still has focus, and Tab from it reaches the first rack tile.
    await expect(page.getByTestId('store-map')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Store-room map' })).toBeFocused();
    await page.keyboard.press('Tab');
    const active = await page.evaluate(() => document.activeElement?.closest('[data-rack]')?.getAttribute('data-rack'));
    expect(active).toBe('R01');
  });
});

test.describe('not-found URLs', () => {
  for (const url of ['/items/abc', '/items/0', '/items/abc/edit']) {
    test(`${url} shows "couldn't find" without Try again`, async ({ page }) => {
      await page.goto(url);
      await expect(page.getByRole('heading', { level: 1, name: "We couldn't find that item" })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    });
  }
  test('/racks/foo is "not a rack" with a link to the map', async ({ page }) => {
    await page.goto('/racks/foo');
    await expect(page.getByRole('heading', { level: 1, name: /isn't a rack/ })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to the map' })).toBeVisible();
  });
});

test.describe('import re-pick and unchanged', () => {
  test('re-picking the same file re-checks it; re-importing shows "already up to date"', async ({ page }, info) => {
    const t = tag(info);
    const file = path.join(os.tmpdir(), `etroop-e2e-r2-${t}.csv`);
    fs.writeFileSync(file, `Code,Name,Location,Qty\nE2E-RP1-${t},Repick one,R05-D-1,2\nE2E-RP2-${t},Repick two,R05-D-2,3\n`);
    const checks: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/api/import')) checks.push(new URL(r.url()).search);
    });

    await page.goto('/import');
    const input = page.getByLabel('Excel or CSV file');
    await input.setInputFiles(file);
    await expect(page.getByTestId('import-preview')).toContainText(`E2E-RP1-${t}`);
    await input.setInputFiles(file); // same file again
    await expect.poll(() => checks.length).toBe(2);
    await expect(page.getByTestId('import-preview')).toBeVisible();

    await page.getByRole('button', { name: 'Confirm import' }).click();
    await expect(page.getByRole('heading', { name: /Import finished/ })).toBeVisible();
    await page.getByRole('button', { name: 'Import another file' }).click();
    await page.getByLabel('Excel or CSV file').setInputFiles(file);
    const counts = page.getByTestId('import-counts');
    const stat = (label: string) => counts.locator('div', { has: page.getByText(label, { exact: true }) }).locator('dd');
    await expect(stat('Already up to date')).toHaveText('2');
    await expect(stat('Will be added')).toHaveText('0');
    await expect(page.getByRole('button', { name: 'Confirm import' })).toBeDisabled();
    await expect(page.getByText(/Every item in it already matches/)).toBeVisible();
    expect(checks).toEqual(['?dryRun=true', '?dryRun=true', '?dryRun=false', '?dryRun=true']);
    fs.rmSync(file, { force: true });
  });
});
