import { expect, test } from '@playwright/test';

// Developer-added regression checks for the round-2 review (M1, M2, m1).

test('M2: on a rack with many bins the highlighted bin stays readable and in view', async ({ page, request }, info) => {
  const code = `E2E-BIN-${info.project.name}-${Date.now()}`;
  const res = await request.post('/api/items', {
    data: { code, name: 'Wide rack test item', locationCode: 'R07-A-14' },
  });
  expect(res.status()).toBe(201);
  const item = (await res.json()) as { id: number };
  try {
    await page.goto(`/items/${item.id}`);
    const hit = page.getByTestId('rack-diagram').locator('[data-highlighted="true"]');
    await expect(hit).toHaveAttribute('data-bin', '14');
    await expect(hit).toContainText('📍');
    const box = await hit.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(30);
    // Scrolled into view inside the diagram, and inside the viewport.
    const vw = page.viewportSize()!.width;
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(vw);
    // The page itself never scrolls sideways.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  } finally {
    await request.delete(`/api/items/${item.id}`);
  }
});

test('m1: the Search tab clears an active search', async ({ page }) => {
  await page.goto('/?q=tent');
  await expect(page.getByTestId('item-card').first()).toBeVisible();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Search' }).click();
  await expect(page.getByRole('searchbox')).toHaveValue('');
  await expect(page).toHaveURL(/\/$/);
});

test('M1: after deleting, Back does not land on a "not found" page', async ({ page, request }, info) => {
  const code = `E2E-DEL-${info.project.name}-${Date.now()}`;
  const res = await request.post('/api/items', { data: { code, name: 'Delete history test', locationCode: 'R02-A-1' } });
  const item = (await res.json()) as { id: number };
  await page.goto('/map');
  await page.goto(`/items/${item.id}`);
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Yes, delete' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/map$/);
});
