// Regression tests for the round-2 review/test findings (developer-added).
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api/client';
import type { ImportResult } from '../src/api/types';
import { MAX_DRAWN_BINS, RackDiagram } from '../src/components/RackDiagram';
import { LIMITS, friendlyServerMessage, serverFieldErrors, validate, type FormValues } from '../src/pages/ItemFormPage';
import { installApiDefaults } from './apiMock';
import { currentLocation, makeItem, renderApp } from './helpers';

vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>();
  const { createApiMock } = await import('./apiMock');
  return { ...actual, api: createApiMock() };
});

const m = vi.mocked(api);

beforeEach(() => {
  installApiDefaults(api);
});

const tent = makeItem({ id: 7, code: 'TNT-004', name: '4-man dome tent', locationCode: 'R03-B-2' });

describe('M1: history after edit / delete', () => {
  beforeEach(() => {
    m.getItem.mockResolvedValue(tent);
    m.updateItem.mockResolvedValue(tent);
    m.listItems.mockResolvedValue([tent]);
  });

  it('edit opened directly: save replaces the form and Back goes to search, not out of the app', async () => {
    const user = userEvent.setup();
    renderApp('/items/7/edit');
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes saved.');
    expect(currentLocation()).toBe('/items/7');
    await user.click(screen.getByRole('link', { name: /^Back$/ }));
    await waitFor(() => expect(currentLocation()).toBe('/'));
  });

  it('Cancel on the edit form returns to the existing item entry (Back then reaches the search)', async () => {
    const user = userEvent.setup();
    renderApp(['/?q=tent', '/items/7', '/items/7/edit']);
    await user.click(await screen.findByRole('link', { name: 'Cancel' }));
    await waitFor(() => expect(currentLocation()).toBe('/items/7'));
    await user.click(await screen.findByRole('link', { name: /^Back$/ }));
    await waitFor(() => expect(currentLocation()).toBe('/?q=tent'));
  });

  it('error-summary links focus the field without changing the URL', async () => {
    const user = userEvent.setup();
    renderApp('/items/new');
    await user.click(await screen.findByRole('button', { name: 'Add item' }));
    const summary = await screen.findByRole('alert');
    await user.click(within(summary).getAllByRole('link')[0] as HTMLElement);
    expect(screen.getByLabelText(/item code/i)).toHaveFocus();
    expect(currentLocation()).toBe('/items/new');
  });

  it('the Search tab is marked current on the edit page', async () => {
    renderApp('/items/7/edit');
    await screen.findByRole('heading', { level: 1, name: 'Edit TNT-004' });
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Search' })).toHaveAttribute('aria-current', 'page');
  });
});

describe('M2: rack diagram with many bins', () => {
  it('keeps every bin column at a minimum width and puts the pin in the highlighted bin', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, shelf: 'A', bin: i + 1 }));
    render(<RackDiagram rack="R01" items={items} highlightShelf="A" highlightBin={12} />);
    const d = screen.getByTestId('rack-diagram');
    const bins = d.querySelector('[data-shelf="A"] .rack__bins') as HTMLElement;
    expect(bins.style.gridTemplateColumns.split('var(--bin-col)')).toHaveLength(13); // 12 min-width columns
    const hit = d.querySelector('[data-highlighted="true"]') as HTMLElement;
    expect(hit).toHaveAttribute('data-bin', '12');
    expect(hit).toHaveTextContent('📍');
    expect(hit).toHaveTextContent('12');
  });

  it('collapses empty runs when a rack has very many bins (e.g. a typo like bin 500)', () => {
    render(<RackDiagram rack="R01" items={[{ id: 1, shelf: 'A', bin: 3 }]} highlightShelf="B" highlightBin={500} />);
    const d = screen.getByTestId('rack-diagram');
    const bins = [...d.querySelectorAll('[data-shelf="B"] [data-bin]')].map((b) => b.getAttribute('data-bin'));
    expect(bins).toEqual(['1', '3', '500']);
    expect(bins.length).toBeLessThanOrEqual(MAX_DRAWN_BINS);
    expect(d.querySelector('[data-shelf="B"] [data-bin="500"]')).toHaveAttribute('data-highlighted', 'true');
    expect(d.querySelectorAll('[data-shelf="B"] .rack__gap')).toHaveLength(2);
  });
});

describe('Item form: limits and friendly server errors', () => {
  const base: FormValues = {
    code: 'A',
    name: 'B',
    category: '',
    location: '',
    quantity: '1',
    unit: 'pcs',
    condition: 'good',
    notes: '',
  };

  it('mirrors the backend limits', () => {
    expect(validate({ ...base, code: 'x'.repeat(LIMITS.code) })).toEqual({});
    expect(validate({ ...base, code: 'x'.repeat(LIMITS.code + 1) }).code).toMatch(/at most 50 characters/);
    expect(validate({ ...base, name: 'x'.repeat(201) }).name).toMatch(/at most 200/);
    expect(validate({ ...base, category: 'x'.repeat(101) }).category).toMatch(/at most 100/);
    expect(validate({ ...base, location: 'x'.repeat(101) }).location).toMatch(/at most 100/);
    expect(validate({ ...base, unit: 'x'.repeat(31) }).unit).toMatch(/at most 30/);
    expect(validate({ ...base, notes: 'x'.repeat(2001) }).notes).toMatch(/at most 2,000/);
    expect(validate({ ...base, quantity: '1000000' })).toEqual({});
    expect(validate({ ...base, quantity: '1000001' }).quantity).toMatch(/0 to 1,000,000/);
  });

  it('translates raw validator text and keeps the backend’s own friendly messages', () => {
    expect(friendlyServerMessage('category', 'Too big: expected string to have <=100 characters')).toBe(
      'Category can be at most 100 characters.',
    );
    expect(friendlyServerMessage('condition', 'Invalid option: expected one of "good"|"damaged"')).toBe(
      'Please choose a condition from the list.',
    );
    expect(friendlyServerMessage('name', 'Name is required')).toBe('Name is required');
    expect(
      serverFieldErrors([{ path: 'locationCode', message: 'Too big: expected string to have <=100 characters' }]),
    ).toEqual({ location: 'Location can be at most 100 characters.' });
  });

  it('shows a server condition error on the Condition field', async () => {
    m.createItem.mockRejectedValue(
      new ApiError('Validation failed', 400, [{ path: 'condition', message: 'Invalid option: expected one of …' }]),
    );
    const user = userEvent.setup();
    renderApp('/items/new');
    await user.type(await screen.findByLabelText(/item code/i), 'X-1');
    await user.type(screen.getByLabelText(/^name/i), 'n');
    await user.click(screen.getByRole('button', { name: 'Add item' }));
    await screen.findByRole('alert');
    expect(screen.getByLabelText('Condition')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Condition')).toHaveAccessibleDescription(/choose a condition from the list/);
  });
});

describe('Search: URL is the source of truth', () => {
  it('m1: the Search tab and the logo clear an active search', async () => {
    m.listItems.mockResolvedValue([tent]);
    const user = userEvent.setup();
    renderApp('/?q=tent');
    expect(await screen.findByRole('searchbox')).toHaveValue('tent');
    await user.click(screen.getByRole('link', { name: 'Search' }));
    await waitFor(() => expect(screen.getByRole('searchbox')).toHaveValue(''));
    await waitFor(() =>
      expect(m.listItems).toHaveBeenLastCalledWith({ q: undefined, category: undefined }, expect.anything()),
    );
    expect(currentLocation()).toBe('/');

    await user.type(screen.getByRole('searchbox'), 'rope');
    await waitFor(() => expect(currentLocation()).toBe('/?q=rope'));
    await user.click(screen.getByRole('link', { name: /home/i }));
    await waitFor(() => expect(screen.getByRole('searchbox')).toHaveValue(''));
    expect(currentLocation()).toBe('/');
  });

  it('m3: a category in the URL that is not in the list is still shown as selected', async () => {
    m.listCategories.mockResolvedValue([{ name: 'Tents', count: 4 }]);
    renderApp('/?category=NoSuchCat');
    const select = await screen.findByLabelText('Category');
    await waitFor(() => expect(within(select).getByRole('option', { name: 'NoSuchCat (0)' })).toBeInTheDocument());
    expect(select).toHaveValue('NoSuchCat');
  });
});

describe('m4: focus moves to the page heading on route change', () => {
  it('focuses the new page h1 after following a link', async () => {
    m.listRacks.mockResolvedValue({ racks: [{ rack: 'R01', shelves: ['A'], itemCount: 1 }], unlocated: 0 });
    m.getRack.mockResolvedValue({ rack: 'R01', shelves: [{ shelf: 'A', items: [tent] }], unshelved: [] });
    const user = userEvent.setup();
    renderApp('/map');
    await user.click(await screen.findByRole('link', { name: /Rack R01/ }));
    const h1 = await screen.findByRole('heading', { level: 1, name: 'Rack R01' });
    await waitFor(() => expect(h1).toHaveFocus());
  });

  it('does not steal focus from the autofocused search box', async () => {
    const user = userEvent.setup();
    renderApp('/map');
    await screen.findByRole('heading', { level: 1, name: 'Store-room map' });
    await user.click(screen.getByRole('link', { name: 'Search' }));
    const box = await screen.findByRole('searchbox');
    await waitFor(() => expect(box).toHaveFocus());
  });
});

describe('m6: invalid ids / racks in the URL', () => {
  it('a non-numeric item id shows not-found without calling the API or offering Try again', async () => {
    renderApp('/items/abc');
    expect(await screen.findByRole('heading', { level: 1, name: "We couldn't find that item" })).toBeInTheDocument();
    expect(m.getItem).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('a 400 from the API is treated as not found', async () => {
    m.getItem.mockRejectedValue(new ApiError('Invalid id', 400));
    renderApp('/items/0/edit');
    expect(await screen.findByText("We couldn't find that item")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('a rack name that is not a rack shows a friendly message with a link to the map', async () => {
    renderApp('/racks/foo');
    expect(
      await screen.findByRole('heading', { level: 1, name: '“foo” isn’t a rack'.replace('’', "'") }),
    ).toBeInTheDocument();
    expect(m.getRack).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Back to the map' })).toHaveAttribute('href', '/map');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

describe('No-location badge', () => {
  it('has its own test id', async () => {
    m.getItem.mockResolvedValue(makeItem({ id: 9, locationCode: null }));
    renderApp('/items/9');
    expect(await screen.findByTestId('location-badge-none')).toHaveTextContent('No location yet');
  });
});

describe('Import (round 2)', () => {
  const xlsx = (name = 'stock.xlsx') =>
    new File(['x'], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

  const dryRun: ImportResult = {
    dryRun: true,
    created: 1,
    updated: 1,
    unchanged: 2,
    skipped: 0,
    errors: [],
    preview: [
      {
        row: 2,
        action: 'create',
        id: null,
        code: 'NEW-1',
        name: 'New',
        locationCode: 'R01-A-1',
        quantity: 1,
        unit: 'pcs',
        condition: 'good',
      },
      {
        row: 3,
        action: 'update',
        id: 4,
        code: 'OLD-1',
        name: 'Old',
        locationCode: 'R01-A-2',
        quantity: 2,
        unit: 'pcs',
        condition: 'good',
      },
      {
        row: 4,
        action: 'unchanged',
        id: 5,
        code: 'SAME-1',
        name: 'Same',
        locationCode: 'R01-A-3',
        quantity: 3,
        unit: 'pcs',
        condition: 'good',
      },
    ],
    ignoredColumns: ['ID (duplicate code column; "Code" is used)', 'Colour'],
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function choose(file: File) {
    const user = userEvent.setup();
    renderApp('/import');
    await user.upload(await screen.findByLabelText('Excel or CSV file'), file);
    return user;
  }

  it('shows the unchanged count, "No change" rows, the blank-cell note and ignored columns with reasons', async () => {
    m.importFile.mockResolvedValueOnce(dryRun);
    await choose(xlsx());
    const counts = await screen.findByTestId('import-counts');
    expect(within(counts).getByText('Already up to date').nextElementSibling).toHaveTextContent('2');
    const rows = within(screen.getByTestId('import-preview')).getAllByRole('row').slice(1);
    expect(rows[2]).toHaveTextContent(/4\s*No change\s*SAME-1/);
    expect(screen.getByText(/Blank cells keep the existing value/)).toBeInTheDocument();
    const ignored = screen.getByText(/will be ignored/);
    expect(ignored).toHaveTextContent('ID (duplicate code column; "Code" is used)');
    expect(ignored).toHaveTextContent('Colour');
  });

  it('explains when every row already matches', async () => {
    m.importFile.mockResolvedValueOnce({ ...dryRun, created: 0, updated: 0, unchanged: 3 });
    await choose(xlsx());
    expect(await screen.findByText(/already matches the store-room list/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm import' })).toBeDisabled();
  });

  it('m5: clears the file input after each pick so the same file can be picked again', async () => {
    m.importFile.mockResolvedValue(dryRun);
    const user = await choose(xlsx());
    await screen.findByTestId('import-counts');
    const input = screen.getByLabelText('Excel or CSV file') as HTMLInputElement;
    expect(input.value).toBe('');
    await user.upload(input, xlsx());
    await waitFor(() => expect(m.importFile).toHaveBeenCalledTimes(2));
  });

  it('m5: a file that can no longer be read gets a "choose it again" message, not "can\'t reach the server"', async () => {
    class BrokenReader {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsArrayBuffer() {
        setTimeout(() => this.onerror?.(), 0);
      }
    }
    vi.stubGlobal('FileReader', BrokenReader);
    m.importFile.mockRejectedValueOnce(new ApiError("Can't reach the store-room server.", 0));
    await choose(xlsx());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't read that file/);
    expect(alert).not.toHaveTextContent(/Can't reach/);
    expect(within(alert).queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(within(alert).getByRole('button', { name: 'Choose a different file' })).toBeInTheDocument();
  });

  it('429: another import is running — friendly message and a working retry', async () => {
    m.importFile
      .mockRejectedValueOnce(new ApiError('An import is already in progress', 429))
      .mockResolvedValueOnce(dryRun);
    const user = await choose(xlsx());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Another import is running — please try again in a moment.');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('import-counts')).toBeInTheDocument();
    expect(m.importFile.mock.calls.map((c) => c[1])).toEqual([true, true]);
  });

  it('429 during the real import also offers a retry of the real import', async () => {
    m.importFile
      .mockResolvedValueOnce(dryRun)
      .mockRejectedValueOnce(new ApiError('An import is already in progress', 429))
      .mockResolvedValueOnce({ ...dryRun, dryRun: false });
    const user = await choose(xlsx());
    await user.click(await screen.findByRole('button', { name: 'Confirm import' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Another import is running');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { name: /Import finished/ });
    expect(m.importFile.mock.calls.map((c) => c[1])).toEqual([true, false, false]);
  });

  it('a file rejected on the client also leaves the input empty', async () => {
    renderApp('/import');
    const input = (await screen.findByLabelText('Excel or CSV file')) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [xlsx('old.xls')] } });
    expect(await screen.findByText(/Please choose an Excel/)).toBeInTheDocument();
    expect(input.value).toBe('');
  });
});
