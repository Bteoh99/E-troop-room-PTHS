import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api/client';

const fetchMock = vi.fn();

function respond(status: number, body?: unknown, raw?: string) {
  const text = raw ?? (body === undefined ? '' : JSON.stringify(body));
  return new Response(status === 204 ? null : text, { status });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const lastUrl = () => String(fetchMock.mock.calls.at(-1)?.[0]);
const lastInit = () => fetchMock.mock.calls.at(-1)?.[1] as RequestInit;

describe('api client', () => {
  it('listItems builds the query string and skips empty filters', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(respond(200, { items: [] })));
    await api.listItems({ q: 'r3 b', category: '', rack: undefined, condition: 'good' });
    expect(lastUrl()).toBe('/api/items?q=r3+b&condition=good');
    await api.listItems();
    expect(lastUrl()).toBe('/api/items');
    expect(lastInit().headers).toMatchObject({ Accept: 'application/json' });
  });

  it('passes the AbortSignal through', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(respond(200, { items: [] })));
    const c = new AbortController();
    await api.listItems({}, c.signal);
    expect(lastInit().signal).toBe(c.signal);
  });

  it('createItem POSTs JSON; updateItem PUTs; deleteItem handles 204', async () => {
    fetchMock.mockResolvedValueOnce(respond(201, { id: 1 }));
    await api.createItem({ code: 'A', name: 'B' });
    expect(lastUrl()).toBe('/api/items');
    expect(lastInit().method).toBe('POST');
    expect(lastInit().headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(lastInit().body))).toEqual({ code: 'A', name: 'B' });

    fetchMock.mockResolvedValueOnce(respond(200, { id: 1 }));
    await api.updateItem(1, { name: 'C' });
    expect(lastUrl()).toBe('/api/items/1');
    expect(lastInit().method).toBe('PUT');

    fetchMock.mockResolvedValueOnce(respond(204));
    await expect(api.deleteItem(1)).resolves.toBeUndefined();
    expect(lastInit().method).toBe('DELETE');
  });

  it('unwraps list endpoints', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, { categories: [{ name: 'Tents', count: 2 }] }));
    await expect(api.listCategories()).resolves.toEqual([{ name: 'Tents', count: 2 }]);
    fetchMock.mockResolvedValueOnce(respond(200, { racks: [], unlocated: 0 }));
    await expect(api.listRacks()).resolves.toEqual({ racks: [], unlocated: 0 });
  });

  it('getRack URL-encodes the rack', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, { rack: 'R03', shelves: [] }));
    await api.getRack('R 3/x');
    expect(lastUrl()).toBe('/api/racks/R%203%2Fx');
  });

  it('importFile sends multipart FormData (no JSON content-type) with the dryRun flag', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(respond(200, { dryRun: true })));
    const file = new File(['code,name\nA,B\n'], 'a.csv', { type: 'text/csv' });
    await api.importFile(file, true);
    expect(lastUrl()).toBe('/api/import?dryRun=true');
    const init = lastInit();
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('file')).toBeInstanceOf(File);
    expect(init.headers).not.toHaveProperty('Content-Type');
    await api.importFile(file, false);
    expect(lastUrl()).toBe('/api/import?dryRun=false');
    expect(api.templateUrl).toBe('/api/import/template');
  });

  it('turns the error envelope into ApiError(message, status, details)', async () => {
    fetchMock.mockResolvedValue(
      respond(400, { error: { message: 'Validation failed', details: [{ path: 'name', message: 'Name is required' }] } }),
    );
    const err = await api.createItem({ code: 'A', name: '' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ message: 'Validation failed', status: 400, details: [{ path: 'name' }] });
  });

  it('gives a generic message for non-JSON error bodies', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(respond(502, undefined, '<html>Bad gateway</html>')));
    await expect(api.getItem(1)).rejects.toMatchObject({
      status: 502,
      message: 'Something went wrong (error 502). Please try again.',
    });
  });

  it('gives a friendly "can’t reach the server" error (status 0) on network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(api.health()).rejects.toMatchObject({ status: 0, message: expect.stringMatching(/Can't reach/) });
  });

  it('re-throws AbortError untouched', async () => {
    fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'));
    await expect(api.health()).rejects.toMatchObject({ name: 'AbortError' });
  });
});
