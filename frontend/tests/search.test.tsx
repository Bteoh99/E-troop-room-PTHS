import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api/client';
import type { Item } from '../src/api/types';
import { SEARCH_DEBOUNCE_MS } from '../src/pages/SearchPage';
import { installApiDefaults } from './apiMock';
import { currentLocation, makeItem, renderApp } from './helpers';

vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>();
  const { createApiMock } = await import('./apiMock');
  return { ...actual, api: createApiMock() };
});

const m = vi.mocked(api);

const tent = makeItem({ id: 1, code: 'TNT-004', name: '4-man dome tent', locationCode: 'R03-B-2', quantity: 6 });
const rope = makeItem({
  id: 2,
  code: 'ROP-030',
  name: 'Nylon rope 30 m',
  category: 'Ropes',
  locationCode: 'R03-A-2',
  quantity: 6,
  unit: 'coils',
  condition: 'needs_repair',
});
const noLoc = makeItem({ id: 3, code: 'MSC-001', name: 'Spare tarp', category: null, locationCode: null });
const oddLoc = makeItem({ id: 4, code: 'MSC-002', name: 'Old banner', locationCode: 'shed corner' });

/** Queries the API received (first argument of listItems). */
const queries = () => m.listItems.mock.calls.map((c) => (c[0] as { q?: string }).q);

beforeEach(() => {
  installApiDefaults(api);
  m.listItems.mockImplementation(async (filters: { q?: string } = {}) => {
    const q = filters.q?.toLowerCase();
    const all = [tent, rope, noLoc, oddLoc];
    return q ? all.filter((i) => `${i.code} ${i.name} ${i.locationCode ?? ''}`.toLowerCase().includes(q)) : all;
  });
  m.listCategories.mockResolvedValue([
    { name: 'Ropes', count: 1 },
    { name: 'Tents', count: 1 },
  ]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Search page', () => {
  it('autofocuses the labelled search box and lists all items on load', async () => {
    renderApp('/');
    const box = screen.getByRole('searchbox', { name: /search by item name, code or location/i });
    expect(box).toHaveFocus();
    expect(await screen.findAllByTestId('item-card')).toHaveLength(4);
    expect(screen.getByText('All items (4)')).toBeInTheDocument();
    expect(m.listItems).toHaveBeenCalledWith({ q: undefined, category: undefined }, expect.any(AbortSignal));
  });

  it('renders each result card with code, name link, quantity, condition text and the big location badge', async () => {
    renderApp('/?q=rope');
    const card = (await screen.findByRole('link', { name: 'Nylon rope 30 m' })).closest('[data-testid="item-card"]');
    expect(card).not.toBeNull();
    const c = within(card as HTMLElement);
    expect(c.getByText('ROP-030')).toBeInTheDocument();
    expect(c.getByRole('link', { name: 'Nylon rope 30 m' })).toHaveAttribute('href', '/items/2');
    expect(c.getByTestId('location-badge')).toHaveTextContent('📍');
    expect(c.getByTestId('location-badge')).toHaveTextContent('R03-A-2');
    expect(c.getByText('Rack 03 · Shelf A · Bin 2')).toBeInTheDocument();
    expect(c.getByText(/needs repair/i)).toBeInTheDocument();
    expect(card).toHaveTextContent(/Qty\s*6\s*coils/);
    expect(card).toHaveTextContent('Ropes');
  });

  it('shows "No location yet" for items without a location and flags non-coordinate locations', async () => {
    renderApp('/');
    const spare = (await screen.findByRole('link', { name: 'Spare tarp' })).closest('article') as HTMLElement;
    expect(within(spare).getByText(/no location yet/i)).toBeInTheDocument();
    expect(within(spare).queryByTestId('location-badge')).toBeNull();
    const banner = screen.getByRole('link', { name: 'Old banner' }).closest('article') as HTMLElement;
    expect(within(banner).getByTestId('location-badge')).toHaveTextContent('shed corner');
    expect(within(banner).getByText(/not a rack coordinate/i)).toBeInTheDocument();
  });

  it('debounces typing: only the final query is sent, and only after SEARCH_DEBOUNCE_MS', async () => {
    vi.useFakeTimers();
    renderApp('/');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 10);
    });
    m.listItems.mockClear();

    // Simulate fast typing: one keystroke every 50 ms (< debounce).
    const box = screen.getByRole('searchbox');
    for (const value of ['t', 'te', 'ten', 'tent']) {
      fireEvent.change(box, { target: { value } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
    }
    expect(queries()).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 50 - 20);
    });
    expect(queries()).toEqual([]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
    });
    expect(queries()).toEqual(['tent']);
    vi.useRealTimers();
    expect(await screen.findAllByTestId('item-card')).toHaveLength(1);
    expect(screen.getByText('1 match')).toBeInTheDocument();
  });

  it('trims the query and keeps it in the URL (?q=) so Back returns to the same search', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await user.type(screen.getByRole('searchbox'), '  rope  ');
    await waitFor(() => expect(currentLocation()).toBe('/?q=rope'));
    expect(queries()).toContain('rope');
    expect(queries()).not.toContain('  rope  ');
  });

  it('starts from ?q= in the URL (prefilled box, filtered results)', async () => {
    renderApp('/?q=tent');
    expect(screen.getByRole('searchbox')).toHaveValue('tent');
    expect(await screen.findAllByTestId('item-card')).toHaveLength(1);
    expect(queries()[0]).toBe('tent');
  });

  it('shows a helpful empty state when nothing matches', async () => {
    renderApp('/?q=zzz');
    expect(await screen.findByText('No items match “zzz”')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /add a new item/i })).toHaveAttribute('href', '/items/new');
    expect(screen.queryAllByTestId('item-card')).toHaveLength(0);
    expect(screen.getByText('0 items found')).toBeInTheDocument();
  });

  it('shows the empty-store state (add / import links) when there are no items at all', async () => {
    m.listItems.mockResolvedValue([]);
    renderApp('/');
    expect(await screen.findByText('The store room is empty')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add an item' })).toHaveAttribute('href', '/items/new');
    expect(screen.getByRole('link', { name: 'Import from Excel' })).toHaveAttribute('href', '/import');
  });

  it('shows an error state with the server message and recovers on "Try again"', async () => {
    m.listItems.mockRejectedValueOnce(new ApiError("Can't reach the store-room server.", 0));
    const user = userEvent.setup();
    renderApp('/');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load items");
    expect(alert).toHaveTextContent("Can't reach the store-room server.");
    await user.click(within(alert).getByRole('button', { name: /try again/i }));
    expect(await screen.findAllByTestId('item-card')).toHaveLength(4);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('filters by category via the labelled select and stores it in the URL', async () => {
    renderApp('/');
    const select = screen.getByRole('combobox', { name: 'Category' });
    await screen.findByRole('option', { name: 'Ropes (1)' });
    fireEvent.change(select, { target: { value: 'Ropes' } });
    await waitFor(() =>
      expect(m.listItems).toHaveBeenLastCalledWith({ q: undefined, category: 'Ropes' }, expect.any(AbortSignal)),
    );
    expect(currentLocation()).toBe('/?category=Ropes');
  });

  it('announces the result count in a polite live region', async () => {
    renderApp('/?q=tent');
    await screen.findAllByTestId('item-card');
    expect(screen.getByText('1 item found')).toHaveAttribute('aria-live', 'polite');
  });

  it('ignores a slow stale response that arrives after a newer one', async () => {
    let resolveSlow: (v: Item[]) => void = () => {};
    m.listItems.mockImplementation((filters: { q?: string } = {}) => {
      if (filters.q === 'te') return new Promise<Item[]>((r) => (resolveSlow = r));
      return Promise.resolve(filters.q === 'tent' ? [tent] : []);
    });
    renderApp('/?q=te');
    const box = screen.getByRole('searchbox');
    fireEvent.change(box, { target: { value: 'tent' } });
    expect(await screen.findByRole('link', { name: '4-man dome tent' })).toBeInTheDocument();
    await act(async () => resolveSlow([rope]));
    expect(screen.queryByRole('link', { name: 'Nylon rope 30 m' })).toBeNull();
    expect(screen.getAllByTestId('item-card')).toHaveLength(1);
  });

  it('clicking a result opens the item detail', async () => {
    m.getItem.mockResolvedValue(tent);
    m.getRack.mockResolvedValue({ rack: 'R03', shelves: [{ shelf: 'B', items: [tent] }], unshelved: [] });
    const user = userEvent.setup();
    renderApp('/?q=tent');
    await user.click(await screen.findByRole('link', { name: '4-man dome tent' }));
    expect(await screen.findByRole('heading', { level: 1, name: '4-man dome tent' })).toBeInTheDocument();
    expect(currentLocation()).toBe('/items/1');
  });
});
