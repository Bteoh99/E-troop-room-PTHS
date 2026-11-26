import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api/client';
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

describe('Store-room map', () => {
  beforeEach(() => {
    m.listRacks.mockResolvedValue({
      racks: [
        { rack: 'R01', shelves: ['A', 'B', 'C', 'D'], itemCount: 5 },
        { rack: 'R02', shelves: ['A'], itemCount: 1 },
      ],
      unlocated: 3,
    });
  });

  it('shows one tile per rack with item counts and shelf span, linking to the rack view', async () => {
    renderApp('/map');
    const map = await screen.findByTestId('store-map');
    const r1 = within(map).getByRole('link', { name: 'Rack R01, 5 items' });
    expect(r1).toHaveAttribute('href', '/racks/R01');
    expect(r1).toHaveTextContent('Shelves A–D');
    expect(within(map).getByRole('link', { name: 'Rack R02, 1 item' })).toHaveTextContent('Shelf A');
    expect(map.querySelectorAll('[data-highlighted="true"]')).toHaveLength(0);
    expect(screen.getByRole('link', { name: 'Map' })).toHaveAttribute('aria-current', 'page');
  });

  it('says how many items have no location', async () => {
    renderApp('/map');
    expect(await screen.findByText(/3 items have no rack location yet/)).toBeInTheDocument();
  });

  it('uses singular wording for 1 unlocated item', async () => {
    m.listRacks.mockResolvedValue({ racks: [{ rack: 'R01', shelves: ['A'], itemCount: 1 }], unlocated: 1 });
    renderApp('/map');
    expect(await screen.findByText(/1 item has no rack location yet, so it is not on the map/)).toBeInTheDocument();
  });

  it('shows an empty state when there are no racks', async () => {
    m.listRacks.mockResolvedValue({ racks: [], unlocated: 0 });
    renderApp('/map');
    expect(await screen.findByText('No racks yet')).toBeInTheDocument();
  });

  it('shows an error with retry', async () => {
    m.listRacks.mockRejectedValueOnce(new ApiError('Internal server error', 500));
    const user = userEvent.setup();
    renderApp('/map');
    await user.click(within(await screen.findByRole('alert')).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('store-map')).toBeInTheDocument();
  });

  it('tapping a tile opens the rack view', async () => {
    m.getRack.mockResolvedValue({ rack: 'R01', shelves: [], unshelved: [] });
    const user = userEvent.setup();
    renderApp('/map');
    await user.click(await screen.findByRole('link', { name: 'Rack R01, 5 items' }));
    expect(currentLocation()).toBe('/racks/R01');
    expect(await screen.findByRole('heading', { level: 1, name: 'Rack R01' })).toBeInTheDocument();
  });
});

describe('Rack view', () => {
  const a1 = makeItem({ id: 1, code: 'ROP-010', name: 'Manila rope', locationCode: 'R03-A-1' });
  const a2 = makeItem({ id: 2, code: 'ROP-030', name: 'Nylon rope', locationCode: 'R03-A-2', quantity: 6, unit: 'coils' });
  const b = makeItem({ id: 3, code: 'ROP-050', name: 'Lashing cord', locationCode: 'R03-B' });
  const loose = makeItem({ id: 4, code: 'PNR-009', name: 'Loose spar', locationCode: 'R03' });

  beforeEach(() => {
    m.getRack.mockResolvedValue({
      rack: 'R03',
      shelves: [
        { shelf: 'A', items: [a1, a2] },
        { shelf: 'B', items: [b] },
      ],
      unshelved: [loose],
    });
  });

  it.each(['r3', '3', 'R03', 'R3'])('normalises the route param %s to R03 for the API', async (param) => {
    renderApp(`/racks/${param}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Rack R03' })).toBeInTheDocument();
    expect(m.getRack).toHaveBeenCalledWith('R03', expect.any(AbortSignal));
  });

  it('groups items by shelf (sorted by bin), lists unshelved items separately, links to details', async () => {
    renderApp('/racks/R03');
    expect(await screen.findByText(/4 items · shelf A is the top/)).toBeInTheDocument();
    const shelfA = screen.getByRole('region', { name: /Shelf A/ });
    const names = within(shelfA)
      .getAllByRole('link')
      .map((l) => l.textContent);
    expect(names).toEqual(['Manila rope', 'Nylon rope']);
    expect(within(shelfA).getByText('Nylon rope').closest('li')).toHaveTextContent(/Bin\s*2.*ROP-030.*Qty 6 coils/);
    const shelfB = screen.getByRole('region', { name: /Shelf B/ });
    expect(within(shelfB).getByText('No bin')).toBeInTheDocument();
    const none = screen.getByRole('region', { name: /shelf not recorded/ });
    expect(within(none).getByRole('link', { name: 'Loose spar' })).toHaveAttribute('href', '/items/4');
    expect(screen.getByTestId('rack-diagram').querySelectorAll('[data-shelf]')).toHaveLength(2);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Map' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /^Map$/, current: false })).toHaveAttribute('href', '/map');
  });

  it('marks occupied bins in the diagram', async () => {
    renderApp('/racks/R03');
    const diagram = await screen.findByTestId('rack-diagram');
    expect(diagram.querySelector('[data-shelf="A"] [data-bin="1"]')).toHaveClass('has-items');
    expect(diagram.querySelector('[data-shelf="A"] [data-bin="3"]')).not.toHaveClass('has-items');
  });

  it('shows a friendly empty state for a rack with no items (404)', async () => {
    m.getRack.mockRejectedValue(new ApiError('Rack R09 has no items', 404));
    renderApp('/racks/9');
    expect(await screen.findByText('Rack R09 has no items')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the map' })).toHaveAttribute('href', '/map');
  });
});

describe('Layout & navigation', () => {
  it('has a skip link, a labelled main nav with 4 tabs, and marks the active tab', async () => {
    renderApp('/import');
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    // Phase 1.5 (SPEC F.2): a "Scan" tab was added after Search.
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Search',
      'Scan',
      'Map',
      'Add',
      'Import',
    ]);
    expect(within(nav).getByRole('link', { name: 'Import' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Search' })).not.toHaveAttribute('aria-current');
  });

  it('shows the not-found page for unknown routes', () => {
    renderApp('/nope');
    expect(screen.getByText("This page doesn't exist")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to search' })).toHaveAttribute('href', '/');
  });

  it('flash messages (from navigation state) are shown once and can be dismissed', async () => {
    m.getItem.mockResolvedValue(makeItem({ id: 1, name: 'Tarp', code: 'T-1', locationCode: null }));
    const user = userEvent.setup();
    renderApp('/items/1');
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Yes, delete' }));
    const flash = await screen.findByText('Deleted “Tarp” (T-1).');
    expect(flash.closest('[role="status"]')).toHaveAttribute('aria-live', 'polite');
    await user.click(screen.getByRole('button', { name: 'Dismiss message' }));
    expect(screen.queryByText('Deleted “Tarp” (T-1).')).toBeNull();
  });
});
