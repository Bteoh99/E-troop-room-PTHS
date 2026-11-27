// Phase 1.5 fix round (review P1–P7, tester P15-1..3, new backend 429/503, 6–8 digit PIN).
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api/client';
import { TOKEN_STORAGE_KEY, clearToken, getToken, setToken } from '../src/lib/auth';
import { waitText } from '../src/lib/wait';
import { scanErrorText } from '../src/pages/ScanPage';
import { installApiDefaults } from './apiMock';
import { makeItem, renderApp } from './helpers';

vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>();
  const { createApiMock } = await import('./apiMock');
  return { ...actual, api: createApiMock() };
});

const engine = vi.hoisted(() => ({ prepareImage: vi.fn(), findBarcode: vi.fn(), readText: vi.fn() }));
vi.mock('../src/scan/engine', () => engine);

const m = vi.mocked(api);

beforeEach(() => {
  installApiDefaults(api);
  engine.prepareImage.mockReset().mockResolvedValue({ canvas: document.createElement('canvas'), width: 1, height: 1 });
  engine.findBarcode.mockReset().mockResolvedValue(null);
  engine.readText.mockReset().mockResolvedValue('');
});

async function openPinDialog() {
  const user = userEvent.setup();
  renderApp('/', undefined, { leader: false });
  await user.click(screen.getByTestId('leader-button'));
  const dialog = await screen.findByRole('dialog', { name: /Leader PIN/ });
  return { user, dialog, input: within(dialog).getByLabelText('PIN') };
}

describe('PIN dialog (P1, Retry-After, 503, 6–8 digits)', () => {
  it('after a wrong PIN the box keeps focus, and Escape still closes the dialog', async () => {
    m.login.mockRejectedValueOnce(new ApiError('Wrong PIN', 401));
    const { user, dialog, input } = await openPinDialog();
    await user.type(input, '111111');
    await user.click(within(dialog).getByRole('button', { name: 'Unlock' }));
    await within(dialog).findByText(/That PIN isn't right/);
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveValue('');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Escape works even if focus slipped outside the dialog', async () => {
    const { user } = await openPinDialog();
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('"too many at once" (Retry-After: 1) says to wait a moment; a long block uses the real time', async () => {
    m.login
      .mockRejectedValueOnce(new ApiError('Too many PIN attempts at once.', 429, undefined, 1))
      .mockRejectedValueOnce(new ApiError('Too many wrong PIN attempts.', 429, { retryAfterSeconds: 120 }));
    const { user, dialog, input } = await openPinDialog();
    await user.type(input, '246810');
    await user.click(within(dialog).getByRole('button', { name: 'Unlock' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Please wait a moment, then try again.');
    await user.type(input, '246810');
    await user.click(within(dialog).getByRole('button', { name: 'Unlock' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent('Too many wrong tries — wait 2 minutes'),
    );
  });

  it('503 (damaged settings file on the laptop) explains how to repair it', async () => {
    m.login.mockRejectedValueOnce(new ApiError('Leader settings file is damaged.', 503));
    const { user, dialog, input } = await openPinDialog();
    await user.type(input, '246810');
    await user.click(within(dialog).getByRole('button', { name: 'Unlock' }));
    const damaged = await screen.findByRole('dialog', { name: /settings damaged/ });
    expect(damaged).toHaveTextContent(/run "set-pin" to repair it/);
    expect(within(damaged).getByRole('button', { name: 'OK' })).toHaveFocus();
  });

  it('a write answered 503 shows the same repair message', async () => {
    m.getItem.mockResolvedValue(makeItem({ id: 7 }));
    m.updateItem.mockRejectedValue(new ApiError('Leader settings file is damaged.', 503));
    const user = userEvent.setup();
    renderApp('/items/7/edit');
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('dialog', { name: /settings damaged/ })).toBeInTheDocument();
  });

  it('hint says 6 to 8 digits; an old 4-digit PIN is still sent to the server', async () => {
    const { user, dialog, input } = await openPinDialog();
    expect(input).toHaveAccessibleDescription(/6 to 8 digits/);
    await user.type(input, '2468');
    await user.click(within(dialog).getByRole('button', { name: 'Unlock' }));
    expect(m.login).toHaveBeenCalledWith('2468');
  });

  it('after unlocking with an old short PIN, leaders see a gentle note', async () => {
    m.authStatus.mockResolvedValue({ pinSet: true, leader: true, pinTooShort: true });
    const { user, dialog, input } = await openPinDialog();
    await user.type(input, '2468');
    await user.click(within(dialog).getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByTestId('pin-notice')).toHaveTextContent(
      'Please ask the quartermaster to set a 6-digit PIN',
    );
    await user.click(screen.getByRole('button', { name: 'Dismiss PIN notice' }));
    expect(screen.queryByTestId('pin-notice')).toBeNull();
  });
});

describe('token storage (P4, other tabs)', () => {
  it('a write that is accepted but not kept falls back to memory', () => {
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {});
    setToken('quiet');
    expect(getToken()).toBe('quiet');
    set.mockRestore();
    clearToken();
    expect(getToken()).toBeNull();
  });

  it('locking in another tab locks this one too', async () => {
    renderApp('/');
    expect(screen.getByTestId('leader-button')).toHaveAccessibleName(/Leader mode on/);
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: TOKEN_STORAGE_KEY, newValue: null }));
    });
    expect(screen.getByTestId('leader-button')).toHaveAccessibleName(/Leader mode off/);
  });
});

describe('Scan (P3, throttling)', () => {
  const photo = () => new File(['jpeg'], 'label.jpg', { type: 'image/jpeg' });

  it('leaving the page aborts the running text read', async () => {
    let signal: AbortSignal | undefined;
    engine.readText.mockImplementation((_c: unknown, _p: unknown, s?: AbortSignal) => {
      signal = s;
      return new Promise<string>(() => {});
    });
    const user = userEvent.setup();
    renderApp('/scan');
    await user.upload(await screen.findByLabelText(/Take a photo/), photo());
    await waitFor(() => expect(signal).toBeDefined());
    expect(signal!.aborted).toBe(false);
    await user.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Map' }));
    await waitFor(() => expect(signal!.aborted).toBe(true));
  });

  it('the scan throttle (429) says how long to wait', async () => {
    engine.readText.mockResolvedValue('COLEMAN');
    m.scanMatch.mockRejectedValue(new ApiError('Too many scans', 429, { retryAfterSeconds: 42 }));
    const user = userEvent.setup();
    renderApp('/scan');
    await user.upload(await screen.findByLabelText(/Take a photo/), photo());
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many scans in a minute — wait 42 seconds');
    // The text read so far stays editable for a retry.
    expect(screen.getByLabelText(/Fix any mistakes/)).toHaveValue('COLEMAN');
  });

  it('results heading keeps its heading role (live region wraps it)', async () => {
    engine.readText.mockResolvedValue('COLEMAN');
    m.scanMatch.mockResolvedValue({
      matches: [{ item: makeItem({ id: 3 }), score: 0.9, matchedOn: ['brand'] }],
      query: { tokens: [] },
    });
    const user = userEvent.setup();
    renderApp('/scan');
    await user.upload(await screen.findByLabelText(/Take a photo/), photo());
    expect(await screen.findByRole('heading', { name: /Found 1 match/ })).toBeInTheDocument();
  });

  it('error wording helpers', () => {
    expect(scanErrorText(new ApiError('x', 429))).toMatch(/wait a minute/);
    expect(scanErrorText('weird')).toMatch(/Something went wrong/);
    expect(waitText(1)).toBe('1 second');
    expect(waitText(61)).toBe('2 minutes');
  });
});

describe('Needs a location (P5)', () => {
  it('saving the last item moves focus to the "Every item has a location" heading', async () => {
    const only = makeItem({ id: 1, code: 'A-1', name: 'Billy can', locationCode: null });
    m.listUnlocated.mockResolvedValue([only]);
    m.updateItem.mockResolvedValue({ ...only, locationCode: 'R01-A-1' });
    const user = userEvent.setup();
    renderApp('/locate');
    await user.type(await screen.findByLabelText('Location for Billy can (A-1)'), 'R01-A-1{Enter}');
    const heading = await screen.findByRole('heading', { name: 'Every item has a location' });
    await waitFor(() => expect(heading).toHaveFocus());
  });
});

describe('Barcode field (N4)', () => {
  it('uses a text keyboard (letters allowed) with a hint', async () => {
    renderApp('/items/new');
    const field = await screen.findByLabelText(/^Barcode/);
    expect(field).toHaveAttribute('inputmode', 'text');
    expect(field).toHaveAccessibleDescription(/Letters A–Z and digits only/);
  });
});

describe('API client: Retry-After', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('reads Retry-After into ApiError.retryAfterSeconds', async () => {
    const actual = await vi.importActual<typeof import('../src/api/client')>('../src/api/client');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'Too many' } }), {
            status: 429,
            headers: { 'Retry-After': '7' },
          }),
      ),
    );
    const err = await actual.api.scanMatch({ text: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(actual.ApiError);
    expect((err as ApiError).retryAfterSeconds).toBe(7);
  });
});
