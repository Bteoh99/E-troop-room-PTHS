// Round-2 regression + "try to break it" tests (frontend tester).
// Targets the new history (Back / browser Back), route-change focus, Search-tab reset,
// URL category, import re-pick / 429 / unchanged, not-found params and rack-diagram edge cases.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api/client';
import type { ImportResult, Item, ItemInput } from '../src/api/types';
import { RackDiagram } from '../src/components/RackDiagram';
import { takeFlash } from '../src/lib/flash';
import { consumeRouteFocus } from '../src/lib/routeFocus';
import { installApiDefaults } from './apiMock';
import { browserBack, currentLocation, makeItem, renderApp } from './helpers';

vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>();
  const { createApiMock } = await import('./apiMock');
  return { ...actual, api: createApiMock() };
});

const m = vi.mocked(api);

const tent = makeItem({ id: 7, code: 'TNT-004', name: '4-man dome tent', locationCode: 'R03-B-2' });
const rope = makeItem({ id: 8, code: 'ROP-030', name: 'Nylon rope', category: 'Ropes', locationCode: 'R03-A-2' });

beforeEach(() => {
  installApiDefaults(api);
  // flash / route-focus are module singletons: make sure nothing leaks between tests.
  takeFlash();
  consumeRouteFocus();
  m.getItem.mockImplementation(async (id: string | number) => {
    if (String(id) === '7') return tent;
    if (String(id) === '8') return rope;
    throw new ApiError(`Item ${String(id)} not found`, /^\d+$/.test(String(id)) ? 404 : 400);
  });
  m.updateItem.mockImplementation(async (_id: string | number, input: Partial<ItemInput>) => ({ ...tent, ...input }) as Item);
  m.createItem.mockImplementation(async (input: ItemInput) => makeItem({ ...input, id: 55 } as Partial<Item>));
  m.listItems.mockImplementation(async (f: { q?: string; category?: string } = {}) => {
    const all = [tent, rope];
    return all.filter(
      (i) =>
        (!f.q || `${i.code} ${i.name}`.toLowerCase().includes(f.q.toLowerCase())) &&
        (!f.category || i.category === f.category),
    );
  });
  m.listCategories.mockResolvedValue([
    { name: 'Ropes', count: 1 },
    { name: 'Tents', count: 1 },
  ]);
  m.getRack.mockResolvedValue({ rack: 'R03', shelves: [{ shelf: 'B', items: [tent] }], unshelved: [] });
  m.listRacks.mockResolvedValue({ racks: [{ rack: 'R03', shelves: ['A', 'B'], itemCount: 2 }], unlocated: 0 });
});

const nav = () => screen.getByRole('navigation', { name: 'Main' });

// ---------------------------------------------------------------------------------------------
describe('history: Back after edit / delete / add', () => {
  it('search → item → edit → save: Back link AND browser Back both return to the search', async () => {
    const user = userEvent.setup();
    renderApp(['/?q=tent', '/items/7', '/items/7/edit']);
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes saved.');
    expect(currentLocation()).toBe('/items/7');
    browserBack();
    await waitFor(() => expect(currentLocation()).toBe('/?q=tent'));
    expect(screen.getByRole('searchbox')).toHaveValue('tent');
  });

  it('saving twice in a row (edit → save → edit → save) still leaves only one item entry', async () => {
    const user = userEvent.setup();
    renderApp(['/?q=tent', '/items/7']);
    for (let i = 0; i < 2; i++) {
      await user.click(await screen.findByRole('link', { name: 'Edit item' }));
      await user.click(await screen.findByRole('button', { name: 'Save changes' }));
      await screen.findByRole('heading', { level: 1, name: '4-man dome tent' });
      expect(currentLocation()).toBe('/items/7');
    }
    await user.click(screen.getByRole('link', { name: /^Back$/ }));
    await waitFor(() => expect(currentLocation()).toBe('/?q=tent'));
  });

  it('a failed save (409) followed by Cancel goes back to the item, not a new entry', async () => {
    m.updateItem.mockRejectedValueOnce(new ApiError('Duplicate item code', 409));
    const user = userEvent.setup();
    renderApp(['/?q=tent', '/items/7', '/items/7/edit']);
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    await screen.findByText('That item code is already taken.');
    await user.click(screen.getByRole('link', { name: 'Cancel' }));
    await screen.findByRole('heading', { level: 1, name: '4-man dome tent' });
    browserBack();
    await waitFor(() => expect(currentLocation()).toBe('/?q=tent'));
  });

  it('edit opened directly (first entry) → Cancel → Back does not reopen the cancelled form', async () => {
    const user = userEvent.setup();
    renderApp('/items/7/edit');
    await user.click(await screen.findByRole('link', { name: 'Cancel' }));
    await screen.findByRole('heading', { level: 1, name: '4-man dome tent' });
    expect(currentLocation()).toBe('/items/7');
    await user.click(screen.getByRole('link', { name: /^Back$/ }));
    await waitFor(() => expect(currentLocation()).not.toBe('/items/7'));
    expect(currentLocation()).toBe('/');
  });

  it('edit opened directly (first entry) → "Back to item" → Back does not reopen the form', async () => {
    const user = userEvent.setup();
    renderApp('/items/7/edit');
    await user.click(await screen.findByRole('link', { name: /Back to item/ }));
    await screen.findByRole('heading', { level: 1, name: '4-man dome tent' });
    await user.click(screen.getByRole('link', { name: /^Back$/ }));
    await waitFor(() => expect(currentLocation()).not.toBe('/items/7'));
    expect(currentLocation()).toBe('/');
  });

  it('delete: browser Back afterwards does not land on the deleted item', async () => {
    const user = userEvent.setup();
    renderApp(['/?q=tent', '/items/7']);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Yes, delete' }));
    await screen.findByText('Deleted “4-man dome tent” (TNT-004).');
    browserBack();
    await waitFor(() => expect(currentLocation()).toBe('/?q=tent'));
    expect(screen.queryByText("We couldn't find that item")).toBeNull();
  });

  it('add from a search: browser Back from the new item skips the (submitted) add form', async () => {
    const user = userEvent.setup();
    renderApp(['/?q=bivvy', '/items/new']);
    await screen.findByRole('heading', { level: 1, name: 'Add an item' });
    await user.type(screen.getByLabelText(/item code/i), 'b-1');
    await user.type(screen.getByLabelText(/^name/i), 'Bivvy');
    await user.click(screen.getByRole('button', { name: 'Add item' }));
    await waitFor(() => expect(currentLocation()).toBe('/items/55'));
    browserBack();
    await waitFor(() => expect(currentLocation()).toBe('/?q=bivvy'));
  });

  it('the flash from a save is shown once and does not come back on later navigation', async () => {
    const user = userEvent.setup();
    renderApp(['/?q=tent', '/items/7', '/items/7/edit']);
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Changes saved.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dismiss message' }));
    await user.click(within(nav()).getByRole('link', { name: 'Map' }));
    await screen.findByRole('heading', { level: 1, name: 'Store-room map' });
    browserBack();
    await screen.findByRole('heading', { level: 1, name: '4-man dome tent' });
    expect(screen.queryByText('Changes saved.')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
describe('Search tab / logo clear the search', () => {
  it('Search tab clears box, URL and results; browser Back restores the previous search', async () => {
    const user = userEvent.setup();
    renderApp('/?q=tent');
    expect(await screen.findAllByTestId('item-card')).toHaveLength(1);
    await user.click(within(nav()).getByRole('link', { name: 'Search' }));
    await waitFor(() => expect(screen.getByRole('searchbox')).toHaveValue(''));
    expect(currentLocation()).toBe('/');
    await waitFor(() => expect(screen.getAllByTestId('item-card')).toHaveLength(2));
    // and it stays cleared after the debounce
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(currentLocation()).toBe('/');

    browserBack();
    await waitFor(() => expect(screen.getByRole('searchbox')).toHaveValue('tent'));
    await waitFor(() => expect(screen.getAllByTestId('item-card')).toHaveLength(1));
  });

  it('the logo also clears the search and the category', async () => {
    const user = userEvent.setup();
    renderApp('/?q=rope&category=Ropes');
    await screen.findAllByTestId('item-card');
    await user.click(screen.getByRole('link', { name: /e-Troop Store Room, home/ }));
    await waitFor(() => expect(screen.getByRole('searchbox')).toHaveValue(''));
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('');
    expect(currentLocation()).toBe('/');
  });

  it('Search tab clicked while a just-typed query is still debouncing also clears it', async () => {
    renderApp('/');
    await screen.findAllByTestId('item-card');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'rope' } });
    // Click the tab before the 200 ms debounce has written ?q=rope.
    fireEvent.click(within(nav()).getByRole('link', { name: 'Search' }));
    await act(() => new Promise((r) => setTimeout(r, 400)));
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(currentLocation()).toBe('/');
  });

  it('typing a new query after clearing works and is written to the URL', async () => {
    const user = userEvent.setup();
    renderApp('/?q=tent');
    await screen.findAllByTestId('item-card');
    await user.click(within(nav()).getByRole('link', { name: 'Search' }));
    await waitFor(() => expect(screen.getByRole('searchbox')).toHaveValue(''));
    await user.type(screen.getByRole('searchbox'), 'rope');
    await waitFor(() => expect(currentLocation()).toBe('/?q=rope'));
    await waitFor(() => expect(screen.getAllByTestId('item-card')).toHaveLength(1));
  });
});

// ---------------------------------------------------------------------------------------------
describe('category from the URL', () => {
  it('an unknown category is kept, shown as selected and gives the category empty state', async () => {
    renderApp('/?category=Nope');
    const select = screen.getByRole('combobox', { name: 'Category' });
    expect(await screen.findByText('No items in this category')).toBeInTheDocument();
    expect(select).toHaveValue('Nope');
    expect(m.listItems).toHaveBeenCalledWith({ q: undefined, category: 'Nope' }, expect.any(AbortSignal));
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(currentLocation()).toBe('/'));
    await waitFor(() => expect(screen.getAllByTestId('item-card')).toHaveLength(2));
  });

  it('a category with spaces and & round-trips through the URL', async () => {
    m.listCategories.mockResolvedValue([{ name: 'First Aid & Lighting', count: 0 }]);
    renderApp('/?category=First+Aid+%26+Lighting');
    expect(await screen.findByRole('combobox', { name: 'Category' })).toHaveValue('First Aid & Lighting');
    await waitFor(() =>
      expect(m.listItems).toHaveBeenCalledWith({ q: undefined, category: 'First Aid & Lighting' }, expect.any(AbortSignal)),
    );
  });

  it('typing keeps the category in the URL', async () => {
    const user = userEvent.setup();
    renderApp('/?category=Ropes');
    await screen.findAllByTestId('item-card');
    await user.type(screen.getByRole('searchbox'), 'nylon');
    await waitFor(() => expect(currentLocation()).toMatch(/^\/\?(category=Ropes&q=nylon|q=nylon&category=Ropes)$/));
  });
});

// ---------------------------------------------------------------------------------------------
describe('focus on route change', () => {
  const h1 = (name: string | RegExp) => screen.getByRole('heading', { level: 1, name });

  it('does not move focus on the very first page load', async () => {
    renderApp('/map');
    await screen.findByTestId('store-map');
    expect(h1('Store-room map')).not.toHaveFocus();
  });

  it('result link → item detail: the item h1 gets focus once loaded', async () => {
    const user = userEvent.setup();
    renderApp('/?q=tent');
    await user.click(await screen.findByRole('link', { name: '4-man dome tent' }));
    await waitFor(() => expect(h1('4-man dome tent')).toHaveFocus());
  });

  it('tab bar → Map / Import / Add: each page h1 gets focus', async () => {
    const user = userEvent.setup();
    renderApp('/?q=tent');
    await screen.findAllByTestId('item-card');
    await user.click(within(nav()).getByRole('link', { name: 'Map' }));
    await waitFor(() => expect(h1('Store-room map')).toHaveFocus());
    await user.click(within(nav()).getByRole('link', { name: 'Import' }));
    await waitFor(() => expect(h1('Import from Excel')).toHaveFocus());
    await user.click(within(nav()).getByRole('link', { name: 'Add' }));
    await waitFor(() => expect(h1('Add an item')).toHaveFocus());
  });

  it('going to Search keeps focus in the autofocused search box and announces the page', async () => {
    const user = userEvent.setup();
    renderApp('/map');
    await screen.findByTestId('store-map');
    await user.click(within(nav()).getByRole('link', { name: 'Search' }));
    await waitFor(() => expect(screen.getByRole('searchbox')).toHaveFocus());
    expect(screen.getByText('Find an item', { selector: '[aria-live] , [aria-live] *' })).toBeInTheDocument();
  });

  it('typing in the search box (URL ?q= changes) never steals focus from the box', async () => {
    const user = userEvent.setup();
    renderApp('/map');
    await screen.findByTestId('store-map');
    await user.click(within(nav()).getByRole('link', { name: 'Search' }));
    const box = screen.getByRole('searchbox');
    await user.type(box, 'rope');
    await waitFor(() => expect(currentLocation()).toBe('/?q=rope'));
    await screen.findByRole('link', { name: 'Nylon rope' });
    expect(box).toHaveFocus();
  });

  it('changing the category keeps focus on the select', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await screen.findAllByTestId('item-card');
    const select = screen.getByRole('combobox', { name: 'Category' });
    await screen.findByRole('option', { name: 'Ropes (1)' });
    await user.selectOptions(select, 'Ropes');
    await waitFor(() => expect(currentLocation()).toBe('/?category=Ropes'));
    expect(select).toHaveFocus();
  });

  it('a page that fails to load parks focus on <main>; after Try again the h1 gets focus', async () => {
    m.getItem.mockRejectedValueOnce(new ApiError('Internal server error', 500));
    const user = userEvent.setup();
    renderApp('/?q=tent');
    await user.click(await screen.findByRole('link', { name: '4-man dome tent' }));
    const alert = await screen.findByRole('alert');
    expect(screen.getByRole('main')).toHaveFocus();
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(h1('4-man dome tent')).toHaveFocus());
  });

  it('a leftover "route changed" flag does not steal focus later from a field the user is typing in', async () => {
    // Route to a page that errors (no h1 consumes the flag), then go to the edit form via a link and type.
    m.getRack.mockRejectedValueOnce(new ApiError('Internal server error', 500));
    const user = userEvent.setup();
    renderApp('/items/7');
    await screen.findByRole('heading', { level: 1, name: '4-man dome tent' });
    await user.click(await screen.findByRole('link', { name: 'Edit item' }));
    const name = await screen.findByLabelText(/^name/i);
    await user.click(name);
    await user.type(name, 'X');
    expect(name).toHaveFocus();
  });

  it('failed submit focuses the error summary, not the h1', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await screen.findAllByTestId('item-card');
    await user.click(within(nav()).getByRole('link', { name: 'Add' }));
    await waitFor(() => expect(h1('Add an item')).toHaveFocus());
    await user.click(screen.getByRole('button', { name: 'Add item' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveFocus());
  });

  it('after saving an edit (history Back), the item h1 gets focus', async () => {
    const user = userEvent.setup();
    renderApp(['/?q=tent', '/items/7', '/items/7/edit']);
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(h1('4-man dome tent')).toHaveFocus());
  });

  it('following a link to a not-found item focuses its "couldn\'t find" h1', async () => {
    const user = userEvent.setup();
    renderApp('/?q=tent');
    await screen.findAllByTestId('item-card');
    m.getItem.mockRejectedValueOnce(new ApiError('Item 7 not found', 404));
    await user.click(screen.getByRole('link', { name: '4-man dome tent' }));
    await waitFor(() => expect(h1("We couldn't find that item")).toHaveFocus());
  });
});

// ---------------------------------------------------------------------------------------------
describe('not-found URL parameters', () => {
  it.each(['abc', '1.5', '-1', '7abc', '%20'])('/items/%s shows not-found without an API call or Try again', async (id) => {
    renderApp(`/items/${id}`);
    expect(await screen.findByRole('heading', { level: 1, name: "We couldn't find that item" })).toBeInTheDocument();
    expect(m.getItem).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('/items/0 (backend answers 400) is treated as not found', async () => {
    m.getItem.mockRejectedValueOnce(new ApiError('Invalid item id', 400));
    renderApp('/items/0');
    expect(await screen.findByRole('heading', { level: 1, name: "We couldn't find that item" })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('/items/abc/edit shows not-found with no Try again', async () => {
    renderApp('/items/abc/edit');
    expect(await screen.findByRole('heading', { level: 1, name: "We couldn't find that item" })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  });

  it.each(['foo', 'R1000', 'R03-B', 'rack', '%F0%9F%99%82'])('/racks/%s says it is not a rack, without an API call', async (r) => {
    renderApp(`/racks/${r}`);
    expect(await screen.findByRole('heading', { level: 1, name: /isn't a rack/ })).toBeInTheDocument();
    expect(m.getRack).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Back to the map' })).toHaveAttribute('href', '/map');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(document.title).toMatch(/^Rack not found/);
  });

  it('/racks/9 with no items says the rack is empty (404)', async () => {
    m.getRack.mockRejectedValueOnce(new ApiError('Rack R09 has no items', 404));
    renderApp('/racks/9');
    expect(await screen.findByRole('heading', { level: 1, name: 'Rack R09 has no items' })).toBeInTheDocument();
  });

  it('a 500 on a valid item id still offers Try again (not mistaken for not-found)', async () => {
    m.getItem.mockRejectedValueOnce(new ApiError('Internal server error', 500));
    renderApp('/items/7');
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------------
describe('import: re-pick, 429, unchanged', () => {
  const base: ImportResult = {
    dryRun: true,
    created: 1,
    updated: 1,
    unchanged: 3,
    skipped: 0,
    errors: [],
    preview: [
      { row: 2, action: 'create', code: 'A-1', name: 'A', quantity: 1, unit: 'pcs', condition: 'good' },
      { row: 3, action: 'update', code: 'B-1', name: 'B', quantity: 1, unit: 'pcs', condition: 'good' },
      { row: 4, action: 'unchanged', code: 'C-1', name: 'C', quantity: 1, unit: 'pcs', condition: 'good' },
      { row: 5, action: 'merge', code: 'D-1', name: 'D', quantity: 1, unit: 'pcs', condition: 'good' },
    ],
  };
  const file = () => new File(['code,name\nA-1,A\n'], 'stock.csv', { type: 'text/csv' });
  const input = () => screen.getByLabelText('Excel or CSV file') as HTMLInputElement;
  const stat = (label: string) =>
    within(screen.getByTestId('import-counts')).getByText(label, { exact: true }).nextElementSibling?.textContent;

  it('picking the very same file again (e.g. after editing it) runs a fresh check', async () => {
    m.importFile.mockResolvedValue(base);
    const user = userEvent.setup();
    renderApp('/import');
    const f = file();
    await user.upload(input(), f);
    await screen.findByTestId('import-counts');
    expect(input().value).toBe('');
    await user.upload(input(), f);
    await waitFor(() => expect(m.importFile).toHaveBeenCalledTimes(2));
    expect(m.importFile.mock.calls.map((c) => c[1])).toEqual([true, true]);
  });

  it('picking the same file again after a fixable 400 error re-checks it', async () => {
    m.importFile
      .mockRejectedValueOnce(new ApiError('Missing columns', 400, { missingColumns: ['code'], headersFound: ['X'] }))
      .mockResolvedValueOnce(base);
    const user = userEvent.setup();
    renderApp('/import');
    const f = file();
    await user.upload(input(), f);
    await screen.findByText("We couldn't find the code column in your file.");
    await user.upload(input(), f);
    expect(await screen.findByTestId('import-counts')).toBeInTheDocument();
  });

  it('429 on the check: friendly "another import is running" + Try again works', async () => {
    m.importFile.mockRejectedValueOnce(new ApiError('Too many requests', 429)).mockResolvedValueOnce(base);
    const user = userEvent.setup();
    renderApp('/import');
    await user.upload(input(), file());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Another import is running — please try again in a moment.');
    expect(alert).not.toHaveTextContent('Too many requests');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await screen.findByTestId('import-counts');
    expect(m.importFile.mock.calls.map((c) => c[1])).toEqual([true, true]);
  });

  it('shows the unchanged count, "No change" rows and unknown actions as-is', async () => {
    m.importFile.mockResolvedValueOnce(base).mockResolvedValueOnce({ ...base, dryRun: false });
    const user = userEvent.setup();
    renderApp('/import');
    await user.upload(input(), file());
    await screen.findByTestId('import-counts');
    expect(stat('Already up to date')).toBe('3');
    const rows = within(screen.getByTestId('import-preview')).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.children[1]?.textContent)).toEqual(['Add new', 'Update', 'No change', 'merge']);
    await user.click(screen.getByRole('button', { name: 'Confirm import' }));
    await screen.findByRole('heading', { name: /Import finished/ });
    expect(stat('Unchanged')).toBe('3');
  });

  it('a file where everything already matches: Confirm disabled with the right explanation', async () => {
    m.importFile.mockResolvedValueOnce({ ...base, created: 0, updated: 0, unchanged: 5 });
    const user = userEvent.setup();
    renderApp('/import');
    await user.upload(input(), file());
    expect(await screen.findByRole('button', { name: 'Confirm import' })).toBeDisabled();
    expect(screen.getByText(/Every item in it already matches the store-room list/)).toBeInTheDocument();
  });

  it('an older backend without "unchanged" does not show that stat', async () => {
    const { unchanged: _u, ...legacy } = base;
    void _u;
    m.importFile.mockResolvedValueOnce(legacy);
    const user = userEvent.setup();
    renderApp('/import');
    await user.upload(input(), file());
    await screen.findByTestId('import-counts');
    expect(within(screen.getByTestId('import-counts')).queryByText('Already up to date')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
describe('rack diagram edge cases', () => {
  it('bin 0 (accepted by the parser, e.g. "R03-B-0") is highlighted', () => {
    render(<RackDiagram rack="R03" items={[{ id: 1, shelf: 'B', bin: 0 }]} highlightShelf="B" highlightBin={0} />);
    const hit = screen.getByTestId('rack-diagram').querySelector('[data-highlighted="true"]');
    expect(hit).not.toBeNull();
    expect(hit).toHaveAttribute('data-bin', '0');
  });

  it('a rack with 40 occupied bins draws them all (nothing collapsed away)', () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, shelf: 'A', bin: i + 1 }));
    render(<RackDiagram rack="R07" items={items} highlightShelf="A" highlightBin={37} />);
    const d = screen.getByTestId('rack-diagram');
    expect(d.querySelectorAll('[data-shelf="A"] [data-bin]')).toHaveLength(40);
    expect(d.querySelector('[data-highlighted="true"]')).toHaveAttribute('data-bin', '37');
  });

  it('a huge bin number (9999) collapses the gap and still highlights the bin', () => {
    render(
      <RackDiagram
        rack="R03"
        items={[
          { id: 1, shelf: 'A', bin: 1 },
          { id: 2, shelf: 'B', bin: 9999 },
        ]}
        highlightShelf="B"
        highlightBin={9999}
      />,
    );
    const d = screen.getByTestId('rack-diagram');
    expect(d.querySelectorAll('[data-shelf="B"] [data-bin]').length).toBeLessThan(30);
    expect(d.querySelector('[data-highlighted="true"]')).toHaveAttribute('data-bin', '9999');
    expect(d.querySelector('[title="Bins 2–9998"]')).not.toBeNull();
  });
});
