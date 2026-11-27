// Phase 1.5 (SPEC section F): leader mode, scan, "Needs a location", brand/model/barcode.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api/client';
import type { ImportResult, ScanMatchResponse } from '../src/api/types';
import { ItemCard } from '../src/components/ItemCard';
import { TOKEN_STORAGE_KEY, clearToken, getToken, setToken } from '../src/lib/auth';
import { toInput, validate, type FormValues } from '../src/pages/ItemFormPage';
import { withRackPrefix } from '../src/pages/LocatePage';
import { matchedOnText } from '../src/pages/ScanPage';
import { installApiDefaults } from './apiMock';
import { currentLocation, makeItem, renderApp } from './helpers';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>();
  const { createApiMock } = await import('./apiMock');
  return { ...actual, api: createApiMock() };
});

// The real engine needs canvas/wasm; unit tests drive the Scan screen with a fake one.
const engine = vi.hoisted(() => ({
  prepareImage: vi.fn(),
  findBarcode: vi.fn(),
  readText: vi.fn(),
}));
vi.mock('../src/scan/engine', () => engine);

const m = vi.mocked(api);

beforeEach(() => {
  installApiDefaults(api);
  engine.prepareImage.mockReset().mockResolvedValue({ canvas: document.createElement('canvas'), width: 1, height: 1 });
  engine.findBarcode.mockReset().mockResolvedValue(null);
  engine.readText.mockReset().mockResolvedValue('');
});

const tent = makeItem({
  id: 7,
  code: 'TNT-004',
  name: '4-man dome tent',
  locationCode: 'R03-B-2',
  brand: 'Coleman',
  model: 'Sundome 4P',
  barcode: '9555012345678',
});

const pinDialog = () => screen.findByRole('dialog', { name: /Leader PIN/ });

// ---------------------------------------------------------------------------------------------
describe('token storage', () => {
  it('stores, reads and clears the token; an expired token counts as none', () => {
    setToken('abc', '2099-01-01T00:00:00Z');
    expect(getToken()).toBe('abc');
    expect(JSON.parse(window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? '{}')).toMatchObject({ token: 'abc' });
    setToken('old', '2000-01-01T00:00:00Z');
    expect(getToken()).toBeNull();
    clearToken();
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it('keeps working when localStorage throws (private mode)', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => setToken('mem')).not.toThrow();
    expect(getToken()).toBe('mem');
    expect(() => clearToken()).not.toThrow();
    spy.mockRestore();
    get.mockRestore();
  });
});

// ---------------------------------------------------------------------------------------------
describe('Leader mode', () => {
  it('locked: the Add tab asks for the PIN first, then continues to the form', async () => {
    const user = userEvent.setup();
    renderApp('/', undefined, { leader: false });
    await user.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Add' }));
    const dialog = await pinDialog();
    expect(currentLocation()).toBe('/');
    const input = within(dialog).getByLabelText('PIN');
    expect(input).toHaveAttribute('inputmode', 'numeric');
    expect(input).toHaveAttribute('autocomplete', 'off');
    expect(input).toHaveFocus();
    await user.type(input, '246810');
    await user.click(within(dialog).getByRole('button', { name: 'Unlock' }));
    expect(m.login).toHaveBeenCalledWith('246810');
    await waitFor(() => expect(currentLocation()).toBe('/items/new'));
    expect(getToken()).toBe('test-leader-token');
    expect(screen.getByTestId('leader-button')).toHaveAccessibleName(/Leader mode on/);
  });

  it('wrong PIN, then too many tries, show friendly messages', async () => {
    m.login
      .mockRejectedValueOnce(new ApiError('Wrong PIN', 401))
      .mockRejectedValueOnce(new ApiError('Too many attempts', 429));
    const user = userEvent.setup();
    renderApp('/', undefined, { leader: false });
    await user.click(screen.getByTestId('leader-button'));
    const dialog = await pinDialog();
    await user.type(within(dialog).getByLabelText('PIN'), '1111');
    await user.click(within(dialog).getByRole('button', { name: 'Unlock' }));
    expect(await within(dialog).findByText(/That PIN isn't right/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('PIN'), '2222');
    await user.click(within(dialog).getByRole('button', { name: 'Unlock' }));
    expect(await within(dialog).findByText(/Too many wrong tries — wait 5 minutes/)).toBeInTheDocument();
    expect(getToken()).toBeNull();
  });

  it('rejects a PIN that is too short without calling the server (PINs are 6–8 digits)', async () => {
    const user = userEvent.setup();
    renderApp('/', undefined, { leader: false });
    await user.click(screen.getByTestId('leader-button'));
    const dialog = await pinDialog();
    await user.type(within(dialog).getByLabelText('PIN'), '12a');
    expect(within(dialog).getByLabelText('PIN')).toHaveValue('12');
    await user.click(within(dialog).getByRole('button', { name: 'Unlock' }));
    expect(within(dialog).getByText('The PIN is 6 to 8 digits.')).toBeInTheDocument();
    expect(m.login).not.toHaveBeenCalled();
  });

  it('setup-needed (403) explains that the PIN must be set on the laptop', async () => {
    m.login.mockRejectedValueOnce(new ApiError('Leader PIN not set. Run set-pin on the laptop.', 403));
    const user = userEvent.setup();
    renderApp('/', undefined, { leader: false });
    await user.click(screen.getByTestId('leader-button'));
    const dialog = await pinDialog();
    await user.type(within(dialog).getByLabelText('PIN'), '1234');
    await user.click(within(dialog).getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('dialog', { name: /Leader PIN not set up/ })).toHaveTextContent(/set-pin/);
  });

  it('the Lock button leaves leader mode', async () => {
    const user = userEvent.setup();
    renderApp('/');
    const btn = screen.getByTestId('leader-button');
    expect(btn).toHaveAccessibleName(/Leader mode on/);
    await user.click(btn);
    expect(btn).toHaveAccessibleName(/Leader mode off/);
    expect(getToken()).toBeNull();
  });

  it('a stored token the server no longer accepts is dropped on start', async () => {
    m.authStatus.mockResolvedValue({ pinSet: true, leader: false });
    renderApp('/');
    await waitFor(() => expect(screen.getByTestId('leader-button')).toHaveAccessibleName(/Leader mode off/));
  });

  it('locked: Delete asks for the PIN; cancelling does not open the delete confirmation', async () => {
    m.getItem.mockResolvedValue(tent);
    const user = userEvent.setup();
    renderApp('/items/7', undefined, { leader: false });
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = await pinDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(m.deleteItem).not.toHaveBeenCalled();
  });

  it('a 401 on save clears the token, asks for the PIN and retries the save', async () => {
    m.getItem.mockResolvedValue(tent);
    m.updateItem.mockRejectedValueOnce(new ApiError('Leader PIN required', 401)).mockResolvedValueOnce(tent);
    const user = userEvent.setup();
    renderApp('/items/7/edit');
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    const dialog = await pinDialog();
    expect(dialog).toHaveTextContent(/session has ended/);
    expect(getToken()).toBeNull();
    await user.type(within(dialog).getByLabelText('PIN'), '246810');
    await user.click(within(dialog).getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(m.updateItem).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Changes saved.')).toBeInTheDocument();
  });

  it('locked import: choosing a file asks for the PIN before the dry run', async () => {
    const dryRun: ImportResult = { dryRun: true, created: 1, updated: 0, skipped: 0, errors: [], preview: [] };
    m.importFile.mockResolvedValue(dryRun);
    const user = userEvent.setup();
    renderApp('/import', undefined, { leader: false });
    expect(screen.getByText(/Importing needs the leader PIN/)).toBeInTheDocument();
    await user.upload(screen.getByLabelText('Excel or CSV file'), new File(['x'], 'a.xlsx'));
    const dialog = await pinDialog();
    expect(m.importFile).not.toHaveBeenCalled();
    await user.type(within(dialog).getByLabelText('PIN'), '246810');
    await user.click(within(dialog).getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(m.importFile).toHaveBeenCalledWith(expect.any(File), true));
    expect(await screen.findByTestId('import-counts')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------------
describe('Scan', () => {
  const photo = () => new File(['jpeg'], 'label.jpg', { type: 'image/jpeg' });
  const found: ScanMatchResponse = {
    matches: [{ item: tent, score: 0.92, matchedOn: ['brand', 'model'] }],
    query: { tokens: ['coleman', 'sundome', '4p'] },
  };

  beforeEach(() => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:photo'), revokeObjectURL: vi.fn() }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function openScan() {
    const user = userEvent.setup();
    renderApp('/scan');
    await screen.findByRole('heading', { level: 1, name: 'Scan a label' });
    return user;
  }

  it('offers a camera input (capture=environment), a gallery input and tips', async () => {
    await openScan();
    const camera = screen.getByLabelText(/Take a photo/);
    expect(camera).toHaveAttribute('type', 'file');
    expect(camera).toHaveAttribute('accept', 'image/*');
    expect(camera).toHaveAttribute('capture', 'environment');
    expect(screen.getByLabelText('Choose a photo')).not.toHaveAttribute('capture');
    expect(screen.getByRole('list', { name: /Tips/ })).toHaveTextContent(/Good light/);
  });

  it('photo → barcode miss → OCR text → matches shown as result cards with "Matched on"', async () => {
    const thumb = document.createElement('canvas');
    engine.prepareImage.mockResolvedValue({ canvas: document.createElement('canvas'), width: 1, height: 1, thumbnail: thumb });
    engine.readText.mockImplementation(async (_c: unknown, progress?: (s: string, f: number) => void) => {
      progress?.('reading', 0.5);
      return 'COLEMAN\nSUNDOME 4P\nMade in China';
    });
    m.scanMatch.mockResolvedValue(found);
    const user = await openScan();
    await user.upload(screen.getByLabelText(/Take a photo/), photo());
    expect(await screen.findByText('Found 1 match — best first')).toBeInTheDocument();
    expect(engine.findBarcode).toHaveBeenCalled();
    expect(m.scanMatch).toHaveBeenCalledWith({ text: 'COLEMAN\nSUNDOME 4P\nMade in China' });
    const card = screen.getByTestId('item-card');
    expect(within(card).getByTestId('location-badge')).toHaveTextContent('R03-B-2');
    expect(card).toHaveTextContent('Matched on: brand, model');
    // P6: the thumbnail is the small canvas made from the downscaled photo (no second decode of the original).
    expect(screen.getByRole('img', { name: 'Your photo' }).querySelector('canvas')).toBe(thumb);
    expect(screen.getByLabelText(/Fix any mistakes/)).toHaveValue('COLEMAN\nSUNDOME 4P\nMade in China');
  });

  it('shows progress while reading', async () => {
    let finish: (t: string) => void = () => {};
    engine.readText.mockImplementation(
      (_c: unknown, progress?: (s: string, f: number) => void) =>
        new Promise<string>((r) => {
          progress?.('reading', 0.4);
          finish = r;
        }),
    );
    const user = await openScan();
    await user.upload(screen.getByLabelText(/Take a photo/), photo());
    const status = await screen.findByTestId('scan-progress');
    await waitFor(() => expect(status).toHaveTextContent('Reading text…'));
    expect(within(status).getByRole('progressbar')).toHaveAttribute('value', '40');
    await act(async () => finish(''));
  });

  it('a barcode that matches skips OCR entirely', async () => {
    engine.findBarcode.mockResolvedValue('9555012345678');
    m.scanMatch.mockResolvedValue({
      matches: [{ item: tent, score: 1, matchedOn: ['barcode'] }],
      query: { tokens: [], barcode: '9555012345678' },
    });
    const user = await openScan();
    await user.upload(screen.getByLabelText(/Take a photo/), photo());
    expect(await screen.findByText('Matched on: barcode')).toBeInTheDocument();
    expect(m.scanMatch).toHaveBeenCalledWith({ barcode: '9555012345678' });
    expect(engine.readText).not.toHaveBeenCalled();
    expect(screen.getByTestId('scan-barcode')).toHaveTextContent('9555012345678');
  });

  it('no match: friendly message with "Try another photo" and "Type to search"; edited text can be searched', async () => {
    engine.readText.mockResolvedValue('C0LEMAN SUNDOM');
    m.scanMatch.mockResolvedValueOnce({ matches: [], query: { tokens: ['c0leman'] } }).mockResolvedValueOnce(found);
    const user = await openScan();
    await user.upload(screen.getByLabelText(/Take a photo/), photo());
    expect(await screen.findByText('No matching item found')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try another photo' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Type to search' })).toHaveAttribute('href', '/');

    const box = screen.getByLabelText(/Fix any mistakes/);
    await user.clear(box);
    await user.type(box, 'Coleman Sundome');
    await user.click(screen.getByRole('button', { name: 'Search with this text' }));
    expect(m.scanMatch).toHaveBeenLastCalledWith({ text: 'Coleman Sundome' });
    expect(await screen.findByText('Found 1 match — best first')).toBeInTheDocument();
  });

  it('an OCR failure shows an error with recovery options', async () => {
    engine.readText.mockRejectedValue(new Error('Failed to load the text reader'));
    const user = await openScan();
    await user.upload(screen.getByLabelText(/Take a photo/), photo());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Failed to load the text reader');
    expect(within(alert).getByRole('link', { name: 'Type to search' })).toBeInTheDocument();
  });

  it('the search page has a 📷 button that opens the scanner', async () => {
    renderApp('/');
    expect(screen.getByRole('link', { name: /Scan a label or barcode/ })).toHaveAttribute('href', '/scan');
  });

  it('labels matched fields in plain words', () => {
    expect(matchedOnText(['code', 'brand', 'mystery'])).toBe('item code, brand, mystery');
  });
});

// ---------------------------------------------------------------------------------------------
describe('Needs a location', () => {
  const a = makeItem({ id: 1, code: 'A-1', name: 'Billy can', locationCode: null });
  const b = makeItem({ id: 2, code: 'B-1', name: 'Tarp', locationCode: 'shed corner' });
  const c = makeItem({ id: 3, code: 'C-1', name: 'Mallet', locationCode: null });

  it('rack prefix helper', () => {
    expect(withRackPrefix('r3', 'b-2')).toBe('R03-b-2');
    expect(withRackPrefix('R03', 'R04-A-1')).toBe('R04-A-1');
    expect(withRackPrefix('3', '4 a 1')).toBe('4 a 1');
    expect(withRackPrefix('', 'B-2')).toBe('B-2');
    expect(withRackPrefix('nope', 'B-2')).toBe('B-2');
  });

  it('lists unlocated items; saving one removes it and focuses the next box', async () => {
    m.listUnlocated.mockResolvedValue([a, b, c]);
    m.updateItem.mockImplementation(async (id, input) => ({ ...a, id: Number(id), ...input }) as never);
    const user = userEvent.setup();
    renderApp('/locate');
    expect(await screen.findByText('3 items need a location')).toBeInTheDocument();
    expect(screen.getByText('Now: “shed corner”')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Rack prefix (optional)'), 'r3');
    const first = screen.getByLabelText('Location for Billy can (A-1)');
    await user.type(first, 'b-2');
    expect(screen.getAllByTestId('locate-row')[0]).toHaveTextContent('R03-B-2');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(m.updateItem).toHaveBeenCalledWith(1, { locationCode: 'R03-B-2' }));
    await waitFor(() => expect(screen.getByLabelText('Location for Tarp (B-1)')).toHaveFocus());
    await waitFor(() => expect(screen.queryByLabelText('Location for Billy can (A-1)')).toBeNull());
    expect(screen.getByText('2 items need a location')).toBeInTheDocument();
  });

  it('refuses text that is not a rack coordinate', async () => {
    m.listUnlocated.mockResolvedValue([a]);
    const user = userEvent.setup();
    renderApp('/locate');
    await user.type(await screen.findByLabelText('Location for Billy can (A-1)'), 'top shelf{Enter}');
    expect(await screen.findByText(/isn't a rack coordinate/)).toBeInTheDocument();
    expect(m.updateItem).not.toHaveBeenCalled();
  });

  it('locked: Save asks for the PIN', async () => {
    m.listUnlocated.mockResolvedValue([a]);
    const user = userEvent.setup();
    renderApp('/locate', undefined, { leader: false });
    expect(await screen.findByText(/Saving locations needs the leader PIN/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Location for Billy can (A-1)'), 'R01-A-1');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await pinDialog();
    expect(m.updateItem).not.toHaveBeenCalled();
  });

  it('empty state when every item has a location', async () => {
    renderApp('/locate');
    expect(await screen.findByText('Every item has a location')).toBeInTheDocument();
  });

  it('is linked from the Search page badge and the Map page', async () => {
    m.listRacks.mockResolvedValue({ racks: [{ rack: 'R01', shelves: ['A'], itemCount: 1 }], unlocated: 4 });
    renderApp('/');
    expect(await screen.findByTestId('unlocated-badge')).toHaveAttribute('href', '/locate');
    expect(screen.getByTestId('unlocated-badge')).toHaveTextContent('4 items need a location');
  });
});

// ---------------------------------------------------------------------------------------------
describe('Brand / model / barcode', () => {
  const base: FormValues = {
    code: 'TNT-1',
    name: 'Tent',
    category: '',
    location: '',
    quantity: '1',
    unit: 'pcs',
    condition: 'good',
    notes: '',
    brand: ' Coleman ',
    model: 'Sundome 4P',
    barcode: '9555 0123 45678',
  };

  it('toInput trims, strips spaces from the barcode, and sends null only to clear a value', () => {
    expect(toInput(base)).toMatchObject({ brand: 'Coleman', model: 'Sundome 4P', barcode: '9555012345678' });
    const cleared = toInput(
      { ...base, brand: '', model: '', barcode: '' },
      { brand: 'Old', model: null, barcode: '1' },
    );
    expect(cleared.brand).toBeNull();
    expect(cleared.model).toBeUndefined();
    expect(cleared.barcode).toBeNull();
  });

  it('validates barcode characters and lengths', () => {
    expect(validate(base)).toEqual({});
    expect(validate({ ...base, barcode: '12-34' }).barcode).toMatch(/letters and digits/);
    expect(validate({ ...base, barcode: '1'.repeat(65) }).barcode).toMatch(/at most 64/);
    expect(validate({ ...base, brand: 'x'.repeat(101) }).brand).toMatch(/at most 100/);
  });

  it('form fields, and a duplicate barcode (409) is shown on the barcode field', async () => {
    m.createItem.mockRejectedValue(new ApiError('Duplicate barcode', 409, { field: 'barcode' }));
    const user = userEvent.setup();
    renderApp('/items/new');
    await user.type(await screen.findByLabelText(/item code/i), 'X-1');
    await user.type(screen.getByLabelText(/^name/i), 'n');
    await user.type(screen.getByLabelText(/^Brand/), 'Coleman');
    await user.type(screen.getByLabelText(/^Model/), 'Sundome');
    await user.type(screen.getByLabelText(/^Barcode/), '123 456');
    await user.click(screen.getByRole('button', { name: 'Add item' }));
    await waitFor(() =>
      expect(m.createItem).toHaveBeenCalledWith(
        expect.objectContaining({ brand: 'Coleman', model: 'Sundome', barcode: '123456' }),
      ),
    );
    expect(await screen.findByText('That barcode is already used by another item.')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Barcode/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(/item code/i)).not.toHaveAttribute('aria-invalid');
  });

  it('detail page and result cards show them', async () => {
    m.getItem.mockResolvedValue(tent);
    renderApp('/items/7');
    const facts = await screen.findByText('Brand');
    expect(facts.closest('dl')).toHaveTextContent(/BrandColeman.*ModelSundome 4P.*Barcode9555012345678/);
    render(
      <MemoryRouter>
        <ItemCard item={tent} />
      </MemoryRouter>,
    );
    const cards = screen.getAllByTestId('item-card');
    expect(cards.at(-1)).toHaveTextContent('Coleman · Sundome 4P');
    expect(cards.at(-1)).toHaveTextContent('9555012345678');
  });

  it('import preview adds Brand/Model/Barcode columns only when present', async () => {
    m.importFile.mockResolvedValue({
      dryRun: true,
      created: 1,
      updated: 0,
      skipped: 0,
      errors: [],
      preview: [{ row: 2, action: 'create', code: 'T-1', name: 'Tent', brand: 'Coleman', barcode: '123' }],
    });
    const user = userEvent.setup();
    renderApp('/import');
    await user.upload(screen.getByLabelText('Excel or CSV file'), new File(['x'], 'a.csv'));
    const table = await screen.findByTestId('import-preview');
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual([
      'Row',
      'Action',
      'Code',
      'Location',
      'Name',
      'Brand',
      'Barcode',
      'Category',
      'Qty',
      'Condition',
    ]);
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent(/Tent\s*Coleman\s*123/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('API client sends the leader token', () => {
  it('adds Authorization: Bearer when leader mode is on', async () => {
    const actual = await vi.importActual<typeof import('../src/api/client')>('../src/api/client');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    setToken('tok-1');
    await actual.api.listUnlocated();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/items?unlocated=true',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok-1' }) }),
    );
    clearToken();
    await actual.api.scanMatch({ text: 'x' });
    const [, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(init.method).toBe('POST');
    vi.unstubAllGlobals();
  });
});
