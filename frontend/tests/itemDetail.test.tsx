import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api/client';
import type { Item } from '../src/api/types';
import { installApiDefaults } from './apiMock';
import { currentLocation, makeItem, renderApp } from './helpers';

vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>();
  const { createApiMock } = await import('./apiMock');
  return { ...actual, api: createApiMock() };
});

const m = vi.mocked(api);

const tent = makeItem({
  id: 7,
  code: 'TNT-004',
  name: '4-man dome tent',
  locationCode: 'R03-B-2',
  quantity: 6,
  notes: 'Green, with rain fly',
});
const neighbours: Item[] = [
  makeItem({ id: 8, code: 'ROP-010', name: 'Manila rope', locationCode: 'R03-A-1' }),
  makeItem({ id: 9, code: 'PNR-001', name: 'Spar', locationCode: 'R03-D-5' }),
];

function rackFor(items: Item[], rack = 'R03') {
  const shelves = [...new Set(items.filter((i) => i.shelf).map((i) => i.shelf as string))].sort();
  return {
    rack,
    shelves: shelves.map((shelf) => ({ shelf, items: items.filter((i) => i.shelf === shelf) })),
    unshelved: items.filter((i) => !i.shelf),
  };
}

beforeEach(() => {
  installApiDefaults(api);
  m.getItem.mockResolvedValue(tent);
  m.getRack.mockResolvedValue(rackFor([tent, ...neighbours]));
  m.listRacks.mockResolvedValue({
    racks: [
      { rack: 'R01', shelves: ['A', 'B'], itemCount: 5 },
      { rack: 'R03', shelves: ['A', 'B', 'D'], itemCount: 3 },
      { rack: 'R05', shelves: ['A'], itemCount: 1 },
    ],
    unlocated: 0,
  });
});

describe('Item detail', () => {
  it('shows all fields and the big location badge', async () => {
    renderApp('/items/7');
    expect(await screen.findByRole('heading', { level: 1, name: '4-man dome tent' })).toBeInTheDocument();
    expect(m.getItem).toHaveBeenCalledWith('7', expect.any(AbortSignal));
    const badge = screen.getAllByTestId('location-badge')[0] as HTMLElement;
    expect(badge).toHaveTextContent('R03-B-2');
    expect(screen.getByText('Rack 03 · Shelf B · Bin 2')).toBeInTheDocument();
    expect(screen.getByText('TNT-004')).toBeInTheDocument();
    expect(screen.getByText('6 pcs')).toBeInTheDocument();
    expect(screen.getByText('Tents')).toBeInTheDocument();
    expect(screen.getByText('Green, with rain fly')).toBeInTheDocument();
    expect(screen.getAllByText(/^Good$/).length).toBeGreaterThan(0);
    expect(document.title).toBe('4-man dome tent · e-Troop Store Room');
  });

  it('highlights exactly the item’s shelf and bin in the rack diagram (shelf A on top)', async () => {
    renderApp('/items/7');
    const diagram = await screen.findByTestId('rack-diagram');
    await waitFor(() => expect(m.getRack).toHaveBeenCalledWith('R03', expect.any(AbortSignal)));
    // Shelves A..D shown, A first (top).
    await waitFor(() =>
      expect([...diagram.querySelectorAll('[data-shelf]')].map((r) => r.getAttribute('data-shelf'))).toEqual([
        'A',
        'B',
        'C',
        'D',
      ]),
    );
    const hits = diagram.querySelectorAll('[data-highlighted="true"]');
    expect(hits).toHaveLength(1);
    const hit = hits[0] as HTMLElement;
    expect(hit).toHaveAttribute('data-bin', '2');
    expect(hit.closest('[data-shelf]')).toHaveAttribute('data-shelf', 'B');
    expect(hit).toHaveTextContent('📍');
    // Non-colour marker on the highlighted row.
    expect(within(hit.closest('[data-shelf]') as HTMLElement).getByText(/here/)).toBeInTheDocument();
    // Bins sized to the largest bin on the rack (D-5).
    expect(diagram.querySelectorAll('[data-shelf="A"] [data-bin]')).toHaveLength(5);
    // Screen-reader summary.
    expect(within(diagram).getByText(/Highlighted: shelf B, bin 2\./)).toBeInTheDocument();
  });

  it('highlights the rack on the store-room map, and only that rack', async () => {
    renderApp('/items/7');
    const map = await screen.findByTestId('store-map');
    const hits = map.querySelectorAll('[data-highlighted="true"]');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toHaveAttribute('data-rack', 'R03');
    expect(within(hits[0] as HTMLElement).getByText('Here')).toBeInTheDocument();
    expect(within(map).getByRole('link', { name: /Rack R03, 3 items, this item is here/ })).toHaveAttribute(
      'href',
      '/racks/R03',
    );
    expect(screen.getByRole('link', { name: 'See everything on rack R03' })).toHaveAttribute('href', '/racks/R03');
  });

  it('highlights the whole shelf (no bin) for a location like R03-B', async () => {
    m.getItem.mockResolvedValue({ ...tent, locationCode: 'R03-B', bin: null });
    m.getRack.mockResolvedValue(rackFor([{ ...tent, locationCode: 'R03-B', bin: null }]));
    renderApp('/items/7');
    const diagram = await screen.findByTestId('rack-diagram');
    await waitFor(() => expect(diagram.querySelector('[data-shelf="B"]')).toHaveClass('is-hit'));
    expect(diagram.querySelectorAll('[data-highlighted="true"]')).toHaveLength(0);
    expect(diagram.querySelector('[data-shelf="A"]')).not.toHaveClass('is-hit');
  });

  it('rack-only location: no shelf highlighted and a hint to look along the rack', async () => {
    const it2 = { ...tent, locationCode: 'R03', shelf: null, bin: null };
    m.getItem.mockResolvedValue(it2);
    m.getRack.mockResolvedValue(rackFor([it2, ...neighbours]));
    renderApp('/items/7');
    expect(await screen.findByText(/shelf isn't recorded/i)).toBeInTheDocument();
    const diagram = await screen.findByTestId('rack-diagram');
    expect(diagram.querySelectorAll('.is-hit')).toHaveLength(0);
  });

  it('item without location: no diagrams, a link to add one', async () => {
    m.getItem.mockResolvedValue({ ...tent, locationCode: null, rack: null, shelf: null, bin: null });
    renderApp('/items/7');
    expect(await screen.findByText(/This item has no location yet/)).toBeInTheDocument();
    expect(screen.queryByTestId('rack-diagram')).toBeNull();
    expect(screen.queryByTestId('store-map')).toBeNull();
    expect(screen.getByRole('link', { name: /Add a location like R03-B-2/ })).toHaveAttribute('href', '/items/7/edit');
    expect(m.getRack).not.toHaveBeenCalled();
  });

  it('non-coordinate location is shown as typed and explained', async () => {
    m.getItem.mockResolvedValue({ ...tent, locationCode: 'shed corner', rack: null, shelf: null, bin: null });
    renderApp('/items/7');
    expect(await screen.findByText(/The location “shed corner” isn't a rack coordinate/)).toBeInTheDocument();
    expect(screen.queryByTestId('rack-diagram')).toBeNull();
  });

  it('shows a not-found state for a 404', async () => {
    m.getItem.mockRejectedValue(new ApiError('Item 99 not found', 404));
    renderApp('/items/99');
    expect(await screen.findByText("We couldn't find that item")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to search' })).toHaveAttribute('href', '/');
  });

  it('shows an error state with retry for other errors', async () => {
    m.getItem.mockRejectedValueOnce(new ApiError('Internal server error', 500));
    const user = userEvent.setup();
    renderApp('/items/7');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load this item");
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: '4-man dome tent' })).toBeInTheDocument();
  });

  it('still shows the diagram (from the item alone) when the rack request fails', async () => {
    m.getRack.mockRejectedValue(new ApiError('boom', 500));
    renderApp('/items/7');
    const diagram = await screen.findByTestId('rack-diagram');
    await waitFor(() => expect(diagram.querySelector('[data-highlighted="true"]')).toHaveAttribute('data-bin', '2'));
  });

  it('Edit button links to the edit form', async () => {
    renderApp('/items/7');
    expect(await screen.findByRole('link', { name: 'Edit item' })).toHaveAttribute('href', '/items/7/edit');
  });
});

describe('Delete confirmation', () => {
  async function openDialog() {
    const user = userEvent.setup();
    renderApp(['/?q=tent', '/items/7']);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this item?' });
    return { user, dialog };
  }

  it('asks for confirmation; Cancel keeps the item and returns focus', async () => {
    const { user, dialog } = await openDialog();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveTextContent('“4-man dome tent” (TNT-004) will be removed');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(m.deleteItem).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveFocus();
  });

  it('Escape closes the dialog without deleting', async () => {
    const { user } = await openDialog();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(m.deleteItem).not.toHaveBeenCalled();
  });

  it('keeps keyboard focus inside the dialog (Tab wraps)', async () => {
    const { user, dialog } = await openDialog();
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    const confirm = within(dialog).getByRole('button', { name: 'Yes, delete' });
    await user.tab();
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
  });

  it('clicking the backdrop cancels', async () => {
    const { user, dialog } = await openDialog();
    await user.click(dialog.parentElement as HTMLElement);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(m.deleteItem).not.toHaveBeenCalled();
  });

  it('confirming deletes the item, goes back to search and shows a flash message', async () => {
    let finish: () => void = () => {};
    m.deleteItem.mockImplementation(() => new Promise<void>((r) => (finish = r)));
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Yes, delete' }));
    expect(m.deleteItem).toHaveBeenCalledWith(7);
    // Busy while waiting: buttons disabled.
    expect(within(dialog).getByRole('button', { name: 'Please wait…' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    finish();
    expect(await screen.findByText('Deleted “4-man dome tent” (TNT-004).')).toBeInTheDocument();
    expect(currentLocation()).toBe('/');
    expect(screen.getByRole('heading', { level: 1, name: 'Find an item' })).toBeInTheDocument();
  });

  it('shows the server error and keeps the item when delete fails', async () => {
    m.deleteItem.mockRejectedValue(new ApiError('Item 7 not found', 404));
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Yes, delete' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Item 7 not found');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(currentLocation()).toBe('/items/7');
  });
});

describe('Back link', () => {
  it('goes back in history to the previous search (keeps ?q=)', async () => {
    m.listItems.mockResolvedValue([tent]);
    const user = userEvent.setup();
    renderApp(['/?q=tent', '/items/7']);
    await user.click(await screen.findByRole('link', { name: /Back/ }));
    await waitFor(() => expect(currentLocation()).toBe('/?q=tent'));
    expect(screen.getByRole('searchbox')).toHaveValue('tent');
  });

  it('falls back to "/" when opened directly (no in-app history)', async () => {
    const user = userEvent.setup();
    renderApp('/items/7');
    await user.click(await screen.findByRole('link', { name: /Back/ }));
    await waitFor(() => expect(currentLocation()).toBe('/'));
  });
});
