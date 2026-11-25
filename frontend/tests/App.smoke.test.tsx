import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes, routerFuture } from '../src/App';
import type { Item } from '../src/api/types';

// Example of mocking the typed API client — testers can follow this pattern.
vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>();
  const item: Item = {
    id: 1,
    code: 'TNT-004',
    name: '4-man dome tent',
    category: 'Tents',
    locationCode: 'R03-B-2',
    rack: 'R03',
    shelf: 'B',
    bin: 2,
    quantity: 1,
    unit: 'pcs',
    condition: 'good',
    notes: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  return {
    ...actual,
    api: {
      ...actual.api,
      listItems: vi.fn().mockResolvedValue([item]),
      listCategories: vi.fn().mockResolvedValue([{ name: 'Tents', count: 1 }]),
    },
  };
});

describe('App smoke', () => {
  it('renders search results with the location badge', async () => {
    render(
      <MemoryRouter initialEntries={['/']} future={routerFuture}>
        <AppRoutes />
      </MemoryRouter>,
    );
    expect(screen.getByRole('searchbox', { name: /search/i })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: '4-man dome tent' })).toBeInTheDocument();
    expect(screen.getByTestId('location-badge')).toHaveTextContent('R03-B-2');
  });
});
