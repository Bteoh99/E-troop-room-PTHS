import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { AppRoutes, routerFuture } from '../src/App';
import type { Item } from '../src/api/types';
import { parseLocation } from '../src/lib/location';

let nextId = 100;

/** Build an Item; rack/shelf/bin are derived from locationCode unless given. */
export function makeItem(overrides: Partial<Item> = {}): Item {
  const loc = parseLocation(overrides.locationCode === undefined ? 'R03-B-2' : overrides.locationCode);
  return {
    id: nextId++,
    code: 'TNT-004',
    name: '4-man dome tent',
    category: 'Tents',
    locationCode: loc.locationCode,
    rack: loc.rack,
    shelf: loc.shelf,
    bin: loc.bin,
    quantity: 1,
    unit: 'pcs',
    condition: 'good',
    notes: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function LocationProbe() {
  const loc = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="current-location" hidden>
        {loc.pathname + loc.search}
      </output>
      {/* Simulates the browser's Back / Forward buttons. */}
      <button type="button" data-testid="history-back" hidden onClick={() => navigate(-1)} />
      <button type="button" data-testid="history-forward" hidden onClick={() => navigate(1)} />
    </>
  );
}

/** Press the browser Back button (history -1). */
export function browserBack(): void {
  fireEvent.click(screen.getByTestId('history-back'));
}

/** Render the whole app (routes + layout) at `path` (or a history stack). */
export function renderApp(path: string | string[], initialIndex?: number) {
  const entries = Array.isArray(path) ? path : [path];
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={initialIndex ?? entries.length - 1} future={routerFuture}>
      <AppRoutes />
      <LocationProbe />
    </MemoryRouter>,
  );
}

/** Current router path + search, as rendered by the probe. */
export function currentLocation(): string {
  return screen.getByTestId('current-location').textContent ?? '';
}
