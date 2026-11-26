// Shared API-client mock. Must NOT import app modules (it is loaded from inside vi.mock factories).
import { vi } from 'vitest';
import type { Api } from '../src/api/client';

/** Every API method as a vi.fn(); call `installApiDefaults` in beforeEach for sane defaults. */
export function createApiMock() {
  return {
    health: vi.fn(),
    listItems: vi.fn(),
    getItem: vi.fn(),
    createItem: vi.fn(),
    updateItem: vi.fn(),
    deleteItem: vi.fn(),
    listCategories: vi.fn(),
    listRacks: vi.fn(),
    getRack: vi.fn(),
    importFile: vi.fn(),
    // Phase 1.5
    listUnlocated: vi.fn(),
    authStatus: vi.fn(),
    login: vi.fn(),
    scanMatch: vi.fn(),
    templateUrl: '/api/import/template',
  };
}

/** Reset all mocks and give each method a harmless default result. */
export function installApiDefaults(api: Api): void {
  const m = vi.mocked(api);
  vi.resetAllMocks();
  m.health.mockResolvedValue({ ok: true });
  m.listItems.mockResolvedValue([]);
  m.listCategories.mockResolvedValue([]);
  m.listRacks.mockResolvedValue({ racks: [], unlocated: 0 });
  m.getRack.mockResolvedValue({ rack: 'R01', shelves: [], unshelved: [] });
  m.deleteItem.mockResolvedValue(undefined);
  // Phase 1.5: a PIN is set and the stored test token is valid.
  m.listUnlocated.mockResolvedValue([]);
  m.authStatus.mockResolvedValue({ pinSet: true, leader: true });
  m.login.mockResolvedValue({ token: 'test-leader-token', expiresAt: '2099-01-01T00:00:00.000Z' });
  m.scanMatch.mockResolvedValue({ matches: [], query: { tokens: [] } });
}
