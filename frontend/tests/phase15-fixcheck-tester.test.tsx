// Phase 1.5 fix-round regression tests (frontend tester): OCR load failure → error → retry,
// 429 Retry-After wording (PIN + scan), 503 damaged-settings dialog, short-PIN notice.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api/client';
import type { Item, ItemInput } from '../src/api/types';
import { clearToken } from '../src/lib/auth';
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
const tent = makeItem({ id: 7, code: 'TNT-004', name: '4-man dome tent' });
const PIN = '246810';

beforeEach(() => {
  installApiDefaults(api);
  clearToken();
  m.getItem.mockResolvedValue(tent);
  m.updateItem.mockImplementation(async (id: string | number, input: Partial<ItemInput>) => ({ ...tent, id: Number(id), ...input }) as Item);
  const canvas = document.createElement('canvas');
  engine.prepareImage.mockReset().mockResolvedValue({ canvas, thumb: canvas, width: 1, height: 1 });
  engine.findBarcode.mockReset().mockResolvedValue(null);
  engine.readText.mockReset().mockResolvedValue('');
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }));
});
afterEach(() => vi.unstubAllGlobals());

async function unlockVia(user: ReturnType<typeof userEvent.setup>, pin = PIN) {
  await user.click(screen.getByTestId('leader-button'));
  const dialog = await screen.findByRole('dialog', { name: /Leader PIN/ });
  await user.type(within(dialog).getByLabelText('PIN'), pin);
  await user.click(within(dialog).getByRole('button', { name: 'Unlock' }));
  return dialog;
}

describe('OCR asset load failure', () => {
  it('shows the "text reader couldn\'t load" error, and the next photo retries and works', async () => {
    engine.readText
      .mockRejectedValueOnce(
        new Error(
          "The text reader couldn't load — check you're on the store-room Wi-Fi and try again. The English language file (ocr/eng.traineddata.gz) did not load.",
        ),
      )
      .mockResolvedValueOnce('COLEMAN');
    m.scanMatch.mockResolvedValue({ matches: [{ item: tent, score: 0.8, matchedOn: ['brand'] }], query: { tokens: ['coleman'] } });
    const user = userEvent.setup();
    renderApp('/scan');
    await screen.findByRole('heading', { level: 1, name: 'Scan a label' });
    const photo = new File(['x'], 'p.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText(/Take a photo/), photo);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("The text reader couldn't load");
    expect(alert).toHaveTextContent('eng.traineddata.gz');
    expect(within(alert).getByRole('button', { name: 'Try another photo' })).toBeEnabled();
    expect(m.scanMatch).not.toHaveBeenCalled();
    await user.upload(screen.getByLabelText(/Take a photo/), photo);
    expect(await screen.findByText('Found 1 match — best first')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(engine.readText).toHaveBeenCalledTimes(2);
  });
});

describe('429 Retry-After wording', () => {
  it.each([
    [300, 'Too many wrong tries — wait 5 minutes, then try again.'],
    [120, 'Too many wrong tries — wait 2 minutes, then try again.'],
    [45, 'Too many wrong tries — wait 45 seconds, then try again.'],
    [1, 'Please wait a moment, then try again.'],
    [undefined, 'Too many wrong tries — wait 5 minutes, then try again.'],
  ])('PIN: Retry-After %s s', async (secs, text) => {
    m.login.mockRejectedValue(new ApiError('Too many wrong PIN attempts.', 429, undefined, secs));
    const user = userEvent.setup();
    renderApp('/', undefined, { leader: false });
    const dialog = await unlockVia(user);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(text);
    expect(within(dialog).getByLabelText('PIN')).toHaveFocus();
  });

  it('PIN: retryAfterSeconds in the error details is used when there is no header', async () => {
    m.login.mockRejectedValue(new ApiError('Too many', 429, { retryAfterSeconds: 240 }));
    const user = userEvent.setup();
    renderApp('/', undefined, { leader: false });
    const dialog = await unlockVia(user);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('wait 4 minutes');
  });

  it.each([
    [30, 'Too many scans in a minute — wait 30 seconds, then try again.'],
    [90, 'Too many scans in a minute — wait 2 minutes, then try again.'],
    [undefined, 'Too many scans in a minute — wait a minute, then try again.'],
  ])('scan: Retry-After %s s', async (secs, text) => {
    engine.readText.mockResolvedValue('COLEMAN');
    m.scanMatch.mockRejectedValue(new ApiError('Too many scans', 429, undefined, secs));
    const user = userEvent.setup();
    renderApp('/scan');
    await screen.findByRole('heading', { level: 1, name: 'Scan a label' });
    await user.upload(screen.getByLabelText(/Take a photo/), new File(['x'], 'p.jpg', { type: 'image/jpeg' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    // the recognised text stays editable for a retry
    expect(screen.getByLabelText(/Fix any mistakes/)).toHaveValue('COLEMAN');
  });
});

describe('503 damaged settings', () => {
  it('login 503 opens the repair dialog (focus on OK), the action does not run', async () => {
    m.login.mockRejectedValue(new ApiError('Leader settings are damaged.', 503));
    const user = userEvent.setup();
    renderApp('/items/7', undefined, { leader: false });
    await user.click(await screen.findByRole('link', { name: /Edit item/ }));
    const dialog = await screen.findByRole('dialog', { name: /Leader PIN/ });
    await user.type(within(dialog).getByLabelText('PIN'), PIN);
    await user.click(within(dialog).getByRole('button', { name: 'Unlock' }));
    const damaged = await screen.findByRole('dialog', { name: /settings damaged/ });
    expect(damaged).toHaveTextContent(/damaged.*set-pin/);
    expect(within(damaged).getByRole('button', { name: 'OK' })).toHaveFocus();
    await user.click(within(damaged).getByRole('button', { name: 'OK' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: '4-man dome tent' })).toBeInTheDocument();
  });

  it('a "Needs a location" save answered 503 shows the repair dialog and keeps the row', async () => {
    m.listUnlocated.mockResolvedValue([makeItem({ id: 1, code: 'A-1', name: 'Billy can', locationCode: null })]);
    m.updateItem.mockRejectedValue(new ApiError('Leader settings are damaged.', 503));
    const user = userEvent.setup();
    renderApp('/locate');
    await user.type(await screen.findByLabelText('Location for Billy can (A-1)'), 'R01-A-1{Enter}');
    const damaged = await screen.findByRole('dialog', { name: /settings damaged/ });
    await user.click(within(damaged).getByRole('button', { name: 'OK' }));
    expect(screen.getAllByTestId('locate-row')).toHaveLength(1);
  });
});

describe('short-PIN notice', () => {
  it('after unlocking with an old short PIN the notice is shown, can be dismissed, and nothing is blocked', async () => {
    m.authStatus.mockResolvedValue({ pinSet: true, leader: true, pinTooShort: true } as never);
    const user = userEvent.setup();
    renderApp('/', undefined, { leader: false });
    await unlockVia(user, '2468');
    expect(m.login).toHaveBeenCalledWith('2468');
    const notice = await screen.findByTestId('pin-notice');
    expect(notice).toHaveTextContent('Please ask the quartermaster to set a 6-digit PIN');
    expect(screen.getByTestId('leader-button')).toHaveAccessibleName('Leader mode on. Lock');
    await user.click(within(notice).getByRole('button', { name: 'Dismiss PIN notice' }));
    expect(screen.queryByTestId('pin-notice')).toBeNull();
  });

  it('no notice for a long-enough PIN', async () => {
    m.authStatus.mockResolvedValue({ pinSet: true, leader: true, pinTooShort: false } as never);
    const user = userEvent.setup();
    renderApp('/', undefined, { leader: false });
    await unlockVia(user);
    await waitFor(() => expect(m.authStatus).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('pin-notice')).toBeNull();
  });
});
