import { expect, test } from '@playwright/test';

// Minimal smoke test; the frontend tester owns the full e2e suite.
test('search shows a location badge for a seeded item', async ({ page }) => {
  await page.goto('/');
  const search = page.getByRole('searchbox', { name: /search/i });
  await expect(search).toBeFocused();
  await search.fill('tent');
  const firstCard = page.getByTestId('item-card').first();
  await expect(firstCard).toBeVisible();
  await expect(firstCard.getByTestId('location-badge')).toHaveText(/R\d{2}/);
});
