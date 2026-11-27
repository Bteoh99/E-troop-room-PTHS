// Phase 1.5 tester suite: leader mode (every gated action, locked vs unlocked, PIN errors, 401
// re-prompt without loops, storage failures), Scan (mocked engine), "Needs a location", deep links.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api/client';
import type { ImportResult, Item, ItemInput } from '../src/api/types';
import { TOKEN_STORAGE_KEY, clearToken, getToken } from '../src/lib/auth';
import { takeFlash } from '../src/lib/flash';
import { consumeRouteFocus } from '../src/lib/routeFocus';
import { installApiDefaults } from './apiMock';
import { currentLocation, makeItem, renderApp } from './helpers';

vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>();
  const { createApiMock } = await import('./apiMock');
  return { ...actual, api: createApiMock() };
});

const engine = vi.hoisted(() => ({
  prepareImage: vi.fn(),
  findBarcode: vi.fn(),
  readText: vi.fn(),
}));
vi.mock('../src/scan/engine', () => engine);

const m = vi.mocked(api);

const tent = makeItem({
  id: 7,
  code: 'TNT-004',
  name: '4-man dome tent',
  locationCode: 'R03-B-2',
  brand: 'Coleman',
  model: 'Sundome 4P',
  barcode: '9555012345678',
} as Partial<Item>);
const lantern = makeItem({ id: 9, code: 'LGT-001', name: 'Gas lantern', locationCode: 'R05-B-1' });

const dryRun: ImportResult = {
  dryRun: true,
  created: 1,
  updated: 0,
  skipped: 0,
  errors: [],
  preview: [{ row: 2, action: 'create', code: 'A-1', name: 'A', quantity: 1, unit: 'pcs', condition: 'good' }],
};

beforeEach(() => {
  installApiDefaults(api);
  clearToken(); // also resets the in-memory fallback
  takeFlash();
  consumeRouteFocus();
  m.getItem.mockImplementation(async (id: string | number) => (Number(id) === 9 ? lantern : tent));
  m.listItems.mockResolvedValue([tent, lantern]);
  m.updateItem.mockImplementation(async (id: string | number, input: Partial<ItemInput>) => ({ ...tent, id: Number(id), ...input }) as Item);
  m.createItem.mockImplementation(async (input: ItemInput) => makeItem({ ...input, id: 77 } as Partial<Item>));
  m.importFile.mockResolvedValue(dryRun);
  engine.prepareImage.mockReset().mockResolvedValue({ canvas: document.createElement('canvas'), width: 1, height: 1 });
  engine.findBarcode.mockReset().mockResolvedValue(null);
  engine.readText.mockReset().mockResolvedValue('');
});

afterEach(() => {
  vi.restoreAllMocks();
});

const pinDialog = () => screen.findByRole('dialog', { name: /Leader PIN/ });
const nav = () => screen.getByRole('navigation', { name: 'Main' });

async function enterPin(user: ReturnType<typeof userEvent.setup>, pin = '246810') {
  const dialog = await pinDialog();
  await user.type(within(dialog).getByLabelText('PIN'), pin);
  await user.click(within(dialog).getByRole('button', { name: 'Unlock' }));
  return dialog;
}

// =============================================================================================
describe('leader mode: every gated action, locked → PIN → action continues', () => {
  it('Add tab', async () => {
    const user = userEvent.setup();
    renderApp('/', undefined, { leader: false });
    await user.click(within(nav()).getByRole('link', { name: 'Add' }));
    expect(currentLocation()).toBe('/');
    await enterPin(user);
    await screen.findByRole('heading', { level: 1, name: 'Add an item' });
    expect(m.login).toHaveBeenCalledWith('246810');
    expect(getToken()).toBe('test-leader-token');
  });

  it('Import tab', async () => {
    const user = userEvent.setup();
    renderApp('/map', undefined, { leader: false });
    await user.click(within(nav()).getByRole('link', { name: 'Import' }));
    await enterPin(user);
    await screen.findByRole('heading', { level: 1, name: 'Import from Excel' });
  });

  it('Edit button on the detail page', async () => {
    const user = userEvent.setup();
    renderApp('/items/7', undefined, { leader: false });
    await user.click(await screen.findByRole('link', { name: /Edit item/ }));
    expect(currentLocation()).toBe('/items/7');
    await enterPin(user);
    await screen.findByRole('heading', { level: 1, name: 'Edit TNT-004' });
  });

  it('Delete button: PIN first, then the delete confirmation, then the delete', async () => {
    const user = userEvent.setup();
    renderApp(['/', '/items/7'], undefined, { leader: false });
    await user.click(await screen.findByRole('button', { name: /Delete/ }));
    expect(screen.queryByRole('dialog', { name: 'Delete this item?' })).toBeNull();
    await enterPin(user);
    const confirm = await screen.findByRole('dialog', { name: 'Delete this item?' });
    await user.click(within(confirm).getByRole('button', { name: 'Yes, delete' }));
    await waitFor(() => expect(m.deleteItem).toHaveBeenCalledWith(7));
    expect(await screen.findByText('Deleted “4-man dome tent” (TNT-004).')).toBeInTheDocument();
  });

  it('Save on the add form opened by URL', async () => {
    const user = userEvent.setup();
    renderApp('/items/new', undefined, { leader: false });
    await screen.findByRole('heading', { level: 1, name: 'Add an item' });
    expect(screen.getByText(/Saving needs the leader PIN/)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/item code/i), 'X-1');
    await user.type(screen.getByLabelText(/^name/i), 'Thing');
    await user.click(screen.getByRole('button', { name: 'Add item' }));
    await enterPin(user);
    await waitFor(() => expect(currentLocation()).toBe('/items/77'));
    expect(m.createItem).toHaveBeenCalledTimes(1);
  });

  it('Save on the edit form opened by URL', async () => {
    const user = userEvent.setup();
    renderApp('/items/7/edit', undefined, { leader: false });
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    expect(m.updateItem).not.toHaveBeenCalled();
    await enterPin(user);
    await waitFor(() => expect(m.updateItem).toHaveBeenCalledTimes(1));
  });

  it('choosing an import file: PIN before the dry run, then the dry run and confirm', async () => {
    const user = userEvent.setup();
    renderApp('/import', undefined, { leader: false });
    await user.upload(screen.getByLabelText('Excel or CSV file'), new File(['code,name\nA-1,A\n'], 'a.csv'));
    expect(m.importFile).not.toHaveBeenCalled();
    await enterPin(user);
    await screen.findByTestId('import-counts');
    expect(m.importFile).toHaveBeenCalledWith(expect.any(File), true);
    await user.click(screen.getByRole('button', { name: 'Confirm import' }));
    await waitFor(() => expect(m.importFile).toHaveBeenLastCalledWith(expect.any(File), false));
  });

  it('cancelling the PIN on import explains what to do and imports nothing', async () => {
    const user = userEvent.setup();
    renderApp('/import', undefined, { leader: false });
    await user.upload(screen.getByLabelText('Excel or CSV file'), new File(['x'], 'a.csv'));
    const dialog = await pinDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(
      await screen.findByText('Importing needs the leader PIN. Choose the file again after unlocking.'),
    ).toBeInTheDocument();
    expect(m.importFile).not.toHaveBeenCalled();
  });

  it('Save on "Needs a location"', async () => {
    m.listUnlocated.mockResolvedValue([makeItem({ id: 1, code: 'A-1', name: 'Billy can', locationCode: null })]);
    const user = userEvent.setup();
    renderApp('/locate', undefined, { leader: false });
    await user.type(await screen.findByLabelText('Location for Billy can (A-1)'), 'r1 a 1{Enter}');
    await enterPin(user);
    await waitFor(() => expect(m.updateItem).toHaveBeenCalledWith(1, { locationCode: 'R01-A-1' }));
    expect(await screen.findByText('Every item has a location')).toBeInTheDocument();
  });

  it('cancelling the PIN keeps the user where they were and does nothing', async () => {
    const user = userEvent.setup();
    renderApp('/items/7', undefined, { leader: false });
    await user.click(await screen.findByRole('link', { name: /Edit item/ }));
    const dialog = await pinDialog();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(currentLocation()).toBe('/items/7');
    expect(m.login).not.toHaveBeenCalled();
    void dialog;
  });
});

describe('leader mode: unlocked → no PIN prompt anywhere', () => {
  it('Add, Import, Edit, Delete, save, import and locate never open the PIN dialog', async () => {
    m.listUnlocated.mockResolvedValue([makeItem({ id: 1, code: 'A-1', name: 'Billy can', locationCode: null })]);
    const user = userEvent.setup();
    renderApp(['/', '/items/7']);
    await user.click(await screen.findByRole('button', { name: /Delete/ }));
    expect(await screen.findByRole('dialog', { name: 'Delete this item?' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('link', { name: /Edit item/ }));
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(m.updateItem).toHaveBeenCalled());
    await user.click(within(nav()).getByRole('link', { name: 'Add' }));
    await screen.findByRole('heading', { level: 1, name: 'Add an item' });
    await user.click(within(nav()).getByRole('link', { name: 'Import' }));
    await user.upload(await screen.findByLabelText('Excel or CSV file'), new File(['x'], 'a.csv'));
    await screen.findByTestId('import-counts');
    expect(screen.queryByText(/needs the leader PIN/)).toBeNull();
    expect(screen.queryByRole('dialog', { name: /Leader PIN/ })).toBeNull();
    expect(m.login).not.toHaveBeenCalled();
    // and the leader button says so
    expect(screen.getByTestId('leader-button')).toHaveAccessibleName('Leader mode on. Lock');
  });

  it('locked pages show the 🔒 hint; unlocked pages do not', async () => {
    renderApp('/items/7', undefined, { leader: false });
    expect(await screen.findByRole('link', { name: /Edit item/ })).toHaveTextContent('🔒');
    expect(screen.getByTestId('leader-button')).toHaveAccessibleName('Leader mode off. Unlock with PIN');
  });
});

// =============================================================================================
describe('PIN dialog', () => {
  it('numeric PIN input: inputmode numeric, autocomplete off, masked, non-digits dropped, max 8', async () => {
    const user = userEvent.setup();
    renderApp('/', undefined, { leader: false });
    await user.click(screen.getByTestId('leader-button'));
    const input = within(await pinDialog()).getByLabelText('PIN');
    expect(input).toHaveAttribute('inputmode', 'numeric');
    expect(input).toHaveAttribute('autocomplete', 'off');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveFocus();
    await user.type(input, '12a3-4 56789');
    expect(input).toHaveValue('12345678');
  });

  it('too-short PIN is refused without asking the server', async () => {
    const user = userEvent.setup();
    renderApp('/', undefined, { leader: false });
    await user.click(screen.getByTestId('leader-button'));
    await enterPin(user, '12');
    // Lead decision (fix round): PINs are now 6–8 digits.
    expect(await screen.findByRole('alert')).toHaveTextContent('The PIN is 6 to 8 digits.');
    expect(m.login).not.toHaveBeenCalled();
  });

  it('wrong PIN: message, input cleared and focused, dialog stays; the right PIN then continues the action', async () => {
    m.login.mockRejectedValueOnce(new ApiError('Wrong PIN.', 401));
    const user = userEvent.setup();
    renderApp('/items/7', undefined, { leader: false });
    await user.click(await screen.findByRole('link', { name: /Edit item/ }));
    const dialog = await enterPin(user, '1111');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("That PIN isn't right. Please try again.");
    const input = within(dialog).getByLabelText('PIN');
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(currentLocation()).toBe('/items/7');
    await enterPin(user, '246810');
    await screen.findByRole('heading', { level: 1, name: 'Edit TNT-004' });
  });

  it('429: "Too many wrong tries — wait 5 minutes"; cancelling then does nothing', async () => {
    m.login.mockRejectedValue(new ApiError('Too many wrong PIN attempts. Try again in 5 minutes.', 429));
    const user = userEvent.setup();
    renderApp('/items/7', undefined, { leader: false });
    await user.click(await screen.findByRole('button', { name: /Delete/ }));
    const dialog = await enterPin(user, '246810');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/Too many wrong tries — wait 5 minutes/);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(m.deleteItem).not.toHaveBeenCalled();
    expect(getToken()).toBeNull();
  });

  it('403 on login (PIN not set): explains set-pin on the laptop; OK closes; action not run', async () => {
    m.login.mockRejectedValue(new ApiError('Leader PIN not set. Run set-pin on the laptop.', 403));
    const user = userEvent.setup();
    renderApp('/', undefined, { leader: false });
    await user.click(within(nav()).getByRole('link', { name: 'Add' }));
    await enterPin(user);
    const setup = await screen.findByRole('dialog', { name: /not set up/ });
    expect(setup).toHaveTextContent(/set-pin/);
    expect(within(setup).getByRole('button', { name: 'OK' })).toHaveFocus();
    await user.click(within(setup).getByRole('button', { name: 'OK' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(currentLocation()).toBe('/');
  });

  it('403 on a write (PIN removed on the laptop) shows the setup explanation, not a raw error', async () => {
    m.updateItem.mockRejectedValue(new ApiError('Leader PIN not set. Run set-pin on the laptop.', 403));
    const user = userEvent.setup();
    renderApp('/items/7/edit');
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    const setup = await screen.findByRole('dialog', { name: /not set up/ });
    await user.click(within(setup).getByRole('button', { name: 'OK' }));
    expect(m.updateItem).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  it('a network error while checking the PIN is shown in the dialog', async () => {
    m.login.mockRejectedValue(new ApiError("Can't reach the store-room server. Check your connection and try again.", 0));
    const user = userEvent.setup();
    renderApp('/', undefined, { leader: false });
    await user.click(screen.getByTestId('leader-button'));
    const dialog = await enterPin(user);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("Can't reach the store-room server");
  });

  it('focus returns to the button that opened it', async () => {
    const user = userEvent.setup();
    renderApp('/', undefined, { leader: false });
    const btn = screen.getByTestId('leader-button');
    await user.click(btn);
    await pinDialog();
    await user.keyboard('{Escape}');
    expect(btn).toHaveFocus();
  });
});

// =============================================================================================
describe('401 mid-session', () => {
  it('clears the token, re-prompts with an explanation, and retries the save once', async () => {
    m.updateItem.mockRejectedValueOnce(new ApiError('Leader session expired. Enter the leader PIN again.', 401));
    const user = userEvent.setup();
    renderApp(['/items/7', '/items/7/edit']);
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    const dialog = await pinDialog();
    expect(dialog).toHaveTextContent(/session has ended/);
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    await enterPin(user);
    await waitFor(() => expect(m.updateItem).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Changes saved.')).toBeInTheDocument();
    expect(m.login).toHaveBeenCalledTimes(1);
  });

  it('no loop: a second 401 after re-entering the PIN shows an error instead of asking again', async () => {
    m.updateItem.mockRejectedValue(new ApiError('Leader PIN required. Unlock leader mode first.', 401));
    const user = userEvent.setup();
    renderApp('/items/7/edit');
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    await enterPin(user);
    await waitFor(() => expect(m.updateItem).toHaveBeenCalledTimes(2));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.queryByRole('dialog', { name: /Leader PIN/ })).toBeNull();
    expect(m.login).toHaveBeenCalledTimes(1);
    expect(m.updateItem).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Leader PIN required/);
  });

  it('cancelling the re-prompt keeps the form values and leaves leader mode off', async () => {
    m.updateItem.mockRejectedValueOnce(new ApiError('Leader session expired.', 401));
    const user = userEvent.setup();
    renderApp('/items/7/edit');
    const name = await screen.findByLabelText(/^name/i);
    await user.clear(name);
    await user.type(name, 'Edited tent');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await user.click(within(await pinDialog()).getByRole('button', { name: 'Cancel' }));
    expect(name).toHaveValue('Edited tent');
    expect(m.updateItem).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('leader-button')).toHaveAccessibleName('Leader mode off. Unlock with PIN');
  });

  it('401 on delete re-prompts, then deletes', async () => {
    m.deleteItem.mockRejectedValueOnce(new ApiError('Leader session expired.', 401)).mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    renderApp(['/', '/items/7']);
    await user.click(await screen.findByRole('button', { name: /Delete/ }));
    await user.click(screen.getByRole('button', { name: 'Yes, delete' }));
    await enterPin(user);
    expect(await screen.findByText('Deleted “4-man dome tent” (TNT-004).')).toBeInTheDocument();
    expect(m.deleteItem).toHaveBeenCalledTimes(2);
  });

  it('401 on the real import re-prompts and retries the real import (not the dry run)', async () => {
    m.importFile
      .mockResolvedValueOnce(dryRun)
      .mockRejectedValueOnce(new ApiError('Leader session expired.', 401))
      .mockResolvedValueOnce({ ...dryRun, dryRun: false });
    const user = userEvent.setup();
    renderApp('/import');
    await user.upload(screen.getByLabelText('Excel or CSV file'), new File(['x'], 'a.csv'));
    await user.click(await screen.findByRole('button', { name: 'Confirm import' }));
    await enterPin(user);
    await screen.findByRole('heading', { name: /Import finished/ });
    expect(m.importFile.mock.calls.map((c) => c[1])).toEqual([true, false, false]);
  });

  it('a stored token the server rejects on start is dropped (status leader=false)', async () => {
    m.authStatus.mockResolvedValue({ pinSet: true, leader: false });
    renderApp('/');
    await waitFor(() =>
      expect(screen.getByTestId('leader-button')).toHaveAccessibleName('Leader mode off. Unlock with PIN'),
    );
  });

  it('an offline status check keeps the token', async () => {
    m.authStatus.mockRejectedValue(new ApiError("Can't reach", 0));
    renderApp('/');
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(screen.getByTestId('leader-button')).toHaveAccessibleName('Leader mode on. Lock');
  });
});

// =============================================================================================
describe('Lock and token storage', () => {
  it('Lock clears the stored token and gated actions ask for the PIN again', async () => {
    const user = userEvent.setup();
    renderApp('/items/7');
    await screen.findByRole('heading', { level: 1, name: '4-man dome tent' });
    await user.click(screen.getByTestId('leader-button'));
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(getToken()).toBeNull();
    expect(screen.getByTestId('leader-button')).toHaveAccessibleName('Leader mode off. Unlock with PIN');
    await user.click(screen.getByRole('link', { name: /Edit item/ }));
    await pinDialog();
  });

  it('an expired stored token starts locked', async () => {
    renderApp('/');
    clearToken();
    window.localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify({ token: 't', expiresAt: '2000-01-01T00:00:00Z' }));
    expect(getToken()).toBeNull();
  });

  it('localStorage that throws on every call: app works, unlock keeps the token in memory, lock clears it', async () => {
    const boom = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    renderApp('/', undefined, { leader: false });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(boom);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('leader-button'));
    await enterPin(user);
    await waitFor(() => expect(screen.getByTestId('leader-button')).toHaveAccessibleName('Leader mode on. Lock'));
    expect(getToken()).toBe('test-leader-token');
    await user.click(screen.getByTestId('leader-button'));
    expect(getToken()).toBeNull();
  });

  it('localStorage where only writes fail (quota full / old private mode): unlocking still turns leader mode on', async () => {
    renderApp('/', undefined, { leader: false });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('leader-button'));
    await enterPin(user);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(getToken()).toBe('test-leader-token');
    expect(screen.getByTestId('leader-button')).toHaveAccessibleName('Leader mode on. Lock');
  });

  it('a garbage stored value is treated sensibly (bare string token)', () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'abc.def');
    expect(getToken()).toBe('abc.def');
    window.localStorage.setItem(TOKEN_STORAGE_KEY, '{"nope":1}');
    expect(getToken()).toBeNull();
  });
});

// =============================================================================================
describe('Scan (engine mocked)', () => {
  const photo = () => new File(['jpeg'], 'label.jpg', { type: 'image/jpeg' });
  const found = (item: Item, matchedOn: string[], score = 0.9) => ({ item, score, matchedOn });

  beforeEach(() => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:photo'), revokeObjectURL: vi.fn() }));
  });
  afterEach(() => vi.unstubAllGlobals());

  async function openScan(opts: { leader?: boolean } = {}) {
    const user = userEvent.setup();
    renderApp(['/', '/scan'], undefined, opts);
    await screen.findByRole('heading', { level: 1, name: 'Scan a label' });
    return user;
  }
  const camera = () => screen.getByLabelText(/Take a photo/);

  it('works without leader mode and shows progress while looking for a barcode', async () => {
    let release: (v: string | null) => void = () => {};
    engine.findBarcode.mockImplementation(() => new Promise((r) => (release = r)));
    const user = await openScan({ leader: false });
    await user.upload(camera(), photo());
    expect(await screen.findByTestId('scan-progress')).toHaveTextContent('Looking for a barcode…');
    expect(camera()).toBeDisabled();
    await act(async () => release(null));
    await screen.findByText('No matching item found');
    expect(screen.queryByRole('dialog', { name: /Leader PIN/ })).toBeNull();
  });

  it('a barcode hit skips OCR; the card shows the 📍 badge and "Matched on: barcode"', async () => {
    engine.findBarcode.mockResolvedValue('9555012345678');
    m.scanMatch.mockResolvedValue({ matches: [found(tent, ['barcode'], 1)], query: { tokens: [], barcode: '9555012345678' } });
    const user = await openScan();
    await user.upload(camera(), photo());
    const card = await screen.findByTestId('item-card');
    expect(within(card).getByTestId('location-badge')).toHaveTextContent('📍');
    expect(card).toHaveTextContent('Matched on: barcode');
    expect(engine.readText).not.toHaveBeenCalled();
    expect(m.scanMatch).toHaveBeenCalledTimes(1);
    expect(m.scanMatch).toHaveBeenCalledWith({ barcode: '9555012345678' });
  });

  it('a barcode with no match falls back to OCR and sends text + barcode together', async () => {
    engine.findBarcode.mockResolvedValue('4006381333931');
    engine.readText.mockResolvedValue('COLEMAN');
    m.scanMatch
      .mockResolvedValueOnce({ matches: [], query: { tokens: [] } })
      .mockResolvedValueOnce({ matches: [found(tent, ['brand'])], query: { tokens: ['coleman'] } });
    const user = await openScan();
    await user.upload(camera(), photo());
    await screen.findByText('Found 1 match — best first');
    expect(m.scanMatch).toHaveBeenLastCalledWith({ text: 'COLEMAN', barcode: '4006381333931' });
    expect(screen.getByTestId('scan-barcode')).toHaveTextContent('4006381333931');
  });

  it('OCR text → several matches, best first, each with "Matched on"', async () => {
    engine.readText.mockResolvedValue('  COLEMAN  \nSUNDOME 4P   \n\n');
    m.scanMatch.mockResolvedValue({
      matches: [found(tent, ['brand', 'model'], 0.9), found(lantern, ['brand'], 0.3)],
      query: { tokens: ['coleman', 'sundome', '4p'] },
    });
    const user = await openScan();
    await user.upload(camera(), photo());
    expect(await screen.findByText('Found 2 matches — best first')).toBeInTheDocument();
    expect(m.scanMatch).toHaveBeenCalledWith({ text: 'COLEMAN\nSUNDOME 4P' });
    const cards = screen.getAllByTestId('item-card');
    expect(cards[0]).toHaveTextContent('4-man dome tent');
    expect(cards[0]).toHaveTextContent('Matched on: brand, model');
    expect(cards[1]).toHaveTextContent('Gas lantern');
    expect(within(cards[0] as HTMLElement).getByRole('link', { name: '4-man dome tent' })).toHaveAttribute('href', '/items/7');
  });

  it('very long OCR text is cut to 2000 characters for the API', async () => {
    engine.readText.mockResolvedValue('A'.repeat(2500));
    const user = await openScan();
    await user.upload(camera(), photo());
    await screen.findByText('No matching item found');
    const sent = (m.scanMatch.mock.calls[0]?.[0] as { text: string }).text;
    expect(sent).toHaveLength(2000);
  });

  it('editable text: fixing the OCR text and searching again replaces the results', async () => {
    engine.readText.mockResolvedValue('TNT-OO4');
    m.scanMatch
      .mockResolvedValueOnce({ matches: [], query: { tokens: [] } })
      .mockResolvedValueOnce({ matches: [found(tent, ['code'], 1)], query: { tokens: ['tnt004'] } });
    const user = await openScan();
    await user.upload(camera(), photo());
    await screen.findByText('No matching item found');
    const box = screen.getByLabelText(/Fix any mistakes/);
    expect(box).toHaveValue('TNT-OO4');
    await user.clear(box);
    expect(screen.getByRole('button', { name: 'Search with this text' })).toBeDisabled();
    await user.type(box, 'TNT-004');
    await user.click(screen.getByRole('button', { name: 'Search with this text' }));
    expect(m.scanMatch).toHaveBeenLastCalledWith({ text: 'TNT-004' });
    expect(await screen.findByText('Matched on: item code')).toBeInTheDocument();
    expect(screen.queryByText('No matching item found')).toBeNull();
  });

  it('no text and no barcode: the no-match screen without calling the API; Try another photo opens the camera', async () => {
    engine.readText.mockResolvedValue('   \n  ');
    const user = await openScan();
    await user.upload(camera(), photo());
    expect(await screen.findByText('No matching item found')).toBeInTheDocument();
    expect(m.scanMatch).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Fix any mistakes/)).toHaveValue('');
    expect(screen.getByRole('link', { name: 'Type to search' })).toHaveAttribute('href', '/');
    const click = vi.spyOn(camera() as HTMLInputElement, 'click');
    await user.click(screen.getByRole('button', { name: 'Try another photo' }));
    expect(click).toHaveBeenCalled();
  });

  it('OCR failure: friendly error with recovery; picking another photo works', async () => {
    engine.readText.mockRejectedValueOnce(new Error('Failed to load the text reader')).mockResolvedValueOnce('COLEMAN');
    m.scanMatch.mockResolvedValue({ matches: [found(tent, ['brand'])], query: { tokens: ['coleman'] } });
    const user = await openScan();
    await user.upload(camera(), photo());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't finish the scan");
    expect(alert).toHaveTextContent('Failed to load the text reader');
    expect(within(alert).getByRole('button', { name: 'Try another photo' })).toBeInTheDocument();
    await user.upload(screen.getByLabelText('Choose a photo'), photo());
    expect(await screen.findByText('Found 1 match — best first')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('image preparation failure (unreadable photo) is reported, not swallowed', async () => {
    engine.prepareImage.mockRejectedValue(new Error('This photo could not be opened.'));
    const user = await openScan();
    await user.upload(camera(), photo());
    expect(await screen.findByRole('alert')).toHaveTextContent('This photo could not be opened.');
  });

  it('match API failure keeps the recognised text so the user can retry', async () => {
    engine.readText.mockResolvedValue('COLEMAN');
    m.scanMatch
      .mockRejectedValueOnce(new ApiError("Can't reach the store-room server.", 0))
      .mockResolvedValueOnce({ matches: [found(tent, ['brand'])], query: { tokens: ['coleman'] } });
    const user = await openScan();
    await user.upload(camera(), photo());
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't reach the store-room server.");
    expect(screen.getByLabelText(/Fix any mistakes/)).toHaveValue('COLEMAN');
    await user.click(screen.getByRole('button', { name: 'Search with this text' }));
    expect(await screen.findByText('Found 1 match — best first')).toBeInTheDocument();
  });

  it('the same photo can be picked twice in a row', async () => {
    const user = await openScan();
    const f = photo();
    await user.upload(camera(), f);
    await screen.findByText('No matching item found');
    await user.upload(camera(), f);
    await waitFor(() => expect(engine.prepareImage).toHaveBeenCalledTimes(2));
  });

  it('leaving the page mid-scan abandons the scan (no match request afterwards, no errors)', async () => {
    let finishOcr: (t: string) => void = () => {};
    engine.readText.mockImplementation(() => new Promise<string>((r) => (finishOcr = r)));
    const errors = vi.spyOn(console, 'error');
    const user = await openScan();
    await user.upload(camera(), photo());
    await waitFor(() => expect(engine.readText).toHaveBeenCalled());
    await user.click(within(nav()).getByRole('link', { name: 'Map' }));
    await screen.findByRole('heading', { level: 1, name: 'Store-room map' });
    await act(async () => finishOcr('COLEMAN SUNDOME'));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(m.scanMatch).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it('leaving and coming back starts a fresh, idle Scan page', async () => {
    engine.readText.mockImplementation(() => new Promise<string>(() => {}));
    const user = await openScan();
    await user.upload(camera(), photo());
    await screen.findByTestId('scan-progress');
    await user.click(within(nav()).getByRole('link', { name: 'Map' }));
    await user.click(within(nav()).getByRole('link', { name: 'Scan' }));
    await screen.findByRole('heading', { level: 1, name: 'Scan a label' });
    expect(screen.queryByTestId('scan-progress')).toBeNull();
    expect(camera()).toBeEnabled();
  });

  it('the 📷 button beside the search box and the Scan tab both open /scan', async () => {
    const user = userEvent.setup();
    renderApp('/');
    const scanLinks = screen.getAllByRole('link', { name: /scan/i });
    expect(scanLinks.length).toBeGreaterThanOrEqual(2);
    for (const l of scanLinks) expect(l).toHaveAttribute('href', '/scan');
    await user.click(within(nav()).getByRole('link', { name: 'Scan' }));
    await screen.findByRole('heading', { level: 1, name: 'Scan a label' });
    expect(within(nav()).getByRole('link', { name: 'Scan' })).toHaveAttribute('aria-current', 'page');
  });
});

// =============================================================================================
describe('Needs a location (/locate)', () => {
  const a = makeItem({ id: 1, code: 'A-1', name: 'Billy can', locationCode: null, quantity: 4, unit: 'sets' });
  const b = makeItem({ id: 2, code: 'B-1', name: 'Tarp', locationCode: 'shed corner' });
  const c = makeItem({ id: 3, code: 'C-1', name: 'Mallet', locationCode: null });
  const box = (name: string, code: string) => screen.getByLabelText(`Location for ${name} (${code})`);

  beforeEach(() => {
    m.listUnlocated.mockResolvedValue([a, b, c]);
  });

  it('lists code, name and quantity, with a live normalised preview', async () => {
    const user = userEvent.setup();
    renderApp('/locate');
    expect(await screen.findByText('3 items need a location')).toBeInTheDocument();
    const row = screen.getAllByTestId('locate-row')[0] as HTMLElement;
    expect(row).toHaveTextContent('A-1');
    expect(row).toHaveTextContent('Billy can');
    expect(row).toHaveTextContent('Qty 4 sets');
    await user.type(box('Billy can', 'A-1'), 'r3 b 2');
    expect(within(row).getByTestId('location-badge')).toHaveTextContent('R03-B-2');
    expect(row).toHaveTextContent('Rack 03 · Shelf B · Bin 2');
  });

  it('Enter saves and focus walks down the list; the last one goes back up; then the empty state', async () => {
    const user = userEvent.setup();
    renderApp('/locate');
    await user.type(await screen.findByLabelText('Location for Billy can (A-1)'), 'R01-A-1{Enter}');
    await waitFor(() => expect(box('Tarp', 'B-1')).toHaveFocus());
    await user.keyboard('R01-A-2{Enter}');
    await waitFor(() => expect(box('Mallet', 'C-1')).toHaveFocus());
    await user.keyboard('R01-A-3{Enter}');
    expect(await screen.findByText('Every item has a location')).toBeInTheDocument();
    expect(m.updateItem.mock.calls.map((call) => call[1])).toEqual([
      { locationCode: 'R01-A-1' },
      { locationCode: 'R01-A-2' },
      { locationCode: 'R01-A-3' },
    ]);
  });

  it('saving the last row moves focus to the row above', async () => {
    const user = userEvent.setup();
    renderApp('/locate');
    await user.type(await screen.findByLabelText('Location for Mallet (C-1)'), 'R02{Enter}');
    await waitFor(() => expect(box('Tarp', 'B-1')).toHaveFocus());
  });

  it('rack prefix: set R03 once, type B-2; a full coordinate still wins; an invalid prefix is flagged', async () => {
    const user = userEvent.setup();
    renderApp('/locate');
    const prefix = await screen.findByLabelText('Rack prefix (optional)');
    await user.type(prefix, 'rack 3');
    expect(screen.getByText(/Working on rack R03/)).toBeInTheDocument();
    await user.type(box('Billy can', 'A-1'), 'b-2{Enter}');
    await waitFor(() => expect(m.updateItem).toHaveBeenCalledWith(1, { locationCode: 'R03-B-2' }));
    await user.type(box('Tarp', 'B-1'), 'R04-A-1{Enter}');
    await waitFor(() => expect(m.updateItem).toHaveBeenCalledWith(2, { locationCode: 'R04-A-1' }));
    await user.clear(prefix);
    await user.type(prefix, 'shelf');
    expect(prefix).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/That isn’t a rack/)).toBeInTheDocument();
  });

  it('invalid or empty text is refused, focus stays, nothing is saved; typing clears the error', async () => {
    const user = userEvent.setup();
    renderApp('/locate');
    const first = await screen.findByLabelText('Location for Billy can (A-1)');
    await user.click(first);
    await user.keyboard('{Enter}');
    expect(await screen.findByText(/Type a location first/)).toBeInTheDocument();
    await user.type(first, 'top shelf{Enter}');
    expect(await screen.findByText(/“top shelf” isn't a rack coordinate/)).toBeInTheDocument();
    expect(first).toHaveFocus();
    expect(first).toHaveAttribute('aria-invalid', 'true');
    await user.type(first, 'x');
    expect(screen.queryByText(/isn't a rack coordinate\. Use/)).toBeNull();
    expect(m.updateItem).not.toHaveBeenCalled();
    expect(screen.getAllByTestId('locate-row')).toHaveLength(3);
  });

  it('a save error stays on the row and the row is not removed', async () => {
    m.updateItem.mockRejectedValueOnce(new ApiError('Internal server error', 500));
    const user = userEvent.setup();
    renderApp('/locate');
    await user.type(await screen.findByLabelText('Location for Billy can (A-1)'), 'R01-A-1{Enter}');
    expect(await screen.findByText('Internal server error')).toBeInTheDocument();
    expect(screen.getAllByTestId('locate-row')).toHaveLength(3);
    expect(screen.getByText('3 items need a location')).toBeInTheDocument();
  });

  it('shows the current non-coordinate location', async () => {
    renderApp('/locate');
    expect(await screen.findByText('Now: “shed corner”')).toBeInTheDocument();
  });

  it('empty state and list load error with retry', async () => {
    m.listUnlocated.mockRejectedValueOnce(new ApiError('Internal server error', 500)).mockResolvedValueOnce([]);
    const user = userEvent.setup();
    renderApp('/locate');
    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Every item has a location')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View the map' })).toHaveAttribute('href', '/map');
  });

  it('locked, then Unlock from the page note: saves without a second prompt', async () => {
    const user = userEvent.setup();
    renderApp('/locate', undefined, { leader: false });
    await user.click(await screen.findByRole('button', { name: 'Unlock' }));
    await enterPin(user);
    await waitFor(() => expect(screen.queryByText(/Saving locations needs the leader PIN/)).toBeNull());
    await user.type(box('Billy can', 'A-1'), 'R01-A-1{Enter}');
    await waitFor(() => expect(m.updateItem).toHaveBeenCalledTimes(1));
    expect(m.login).toHaveBeenCalledTimes(1);
  });

  it('linked from the Map page note when items have no location', async () => {
    m.listRacks.mockResolvedValue({ racks: [{ rack: 'R01', shelves: ['A'], itemCount: 1 }], unlocated: 3 });
    renderApp('/map');
    const link = await screen.findByRole('link', { name: /location/i });
    expect(link).toHaveAttribute('href', '/locate');
  });
});

// =============================================================================================
describe('deep links render directly', () => {
  beforeEach(() => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['/scan', 'Scan a label'],
    ['/locate', 'Needs a location'],
    ['/items/7', '4-man dome tent'],
    ['/items/7/edit', 'Edit TNT-004'],
    ['/import', 'Import from Excel'],
  ])('%s', async (path, heading) => {
    renderApp(path, undefined, { leader: false });
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('item detail shows brand, model and barcode', async () => {
    renderApp('/items/7');
    await screen.findByRole('heading', { level: 1, name: '4-man dome tent' });
    expect(screen.getByText('Coleman')).toBeInTheDocument();
    expect(screen.getByText('Sundome 4P')).toBeInTheDocument();
    expect(screen.getByText('9555012345678')).toBeInTheDocument();
  });
});
