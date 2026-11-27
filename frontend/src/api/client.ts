import { getToken } from '../lib/auth';
import type {
  ApiErrorBody,
  AuthStatus,
  LoginResult,
  ScanMatchRequest,
  ScanMatchResponse,
  CategoryCount,
  ImportResult,
  Item,
  ItemFilters,
  ItemInput,
  RackDetail,
  RacksResponse,
} from './types';

/** Error thrown for any failed API call. `status` is 0 when the server could not be reached. */
export class ApiError extends Error {
  readonly status: number;
  readonly details?: unknown;
  /** Seconds to wait before retrying (429/503): from the Retry-After header or details.retryAfterSeconds. */
  readonly retryAfterSeconds?: number;

  constructor(message: string, status: number, details?: unknown, retryAfterSeconds?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
    const fromDetails = (details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
    const secs = retryAfterSeconds ?? (typeof fromDetails === 'number' ? fromDetails : undefined);
    if (secs !== undefined && Number.isFinite(secs) && secs >= 0) this.retryAfterSeconds = Math.ceil(secs);
  }
}

/** Parses a Retry-After header given in seconds (the HTTP-date form is converted too). */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value.trim());
  if (Number.isFinite(secs)) return Math.max(0, secs);
  const when = Date.parse(value);
  return Number.isFinite(when) ? Math.max(0, Math.ceil((when - Date.now()) / 1000)) : undefined;
}

const BASE = '/api';

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const err = (value as { error: unknown }).error;
  return typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string';
}

/** Leader token (if any) — required by the server for writes, harmless on reads. */
function authHeader(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...authHeader(),
        ...init.headers,
      },
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError("Can't reach the store-room server. Check your connection and try again.", 0);
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }

  if (!res.ok) {
    const retryAfter = parseRetryAfter(res.headers.get('Retry-After'));
    if (isApiErrorBody(data)) {
      throw new ApiError(data.error.message, res.status, data.error.details, retryAfter);
    }
    throw new ApiError(
      `Something went wrong (error ${res.status}). Please try again.`,
      res.status,
      undefined,
      retryAfter,
    );
  }
  return data as T;
}

function toQuery(params: object): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      usp.set(key, String(value));
    }
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

export const api = {
  health(signal?: AbortSignal): Promise<{ ok: boolean }> {
    return request('/health', { signal });
  },

  async listItems(filters: ItemFilters = {}, signal?: AbortSignal): Promise<Item[]> {
    const data = await request<{ items: Item[] }>(`/items${toQuery(filters)}`, { signal });
    return data.items;
  },

  getItem(id: number | string, signal?: AbortSignal): Promise<Item> {
    return request(`/items/${encodeURIComponent(String(id))}`, { signal });
  },

  createItem(input: ItemInput): Promise<Item> {
    return request('/items', { method: 'POST', body: JSON.stringify(input) });
  },

  updateItem(id: number | string, input: Partial<ItemInput>): Promise<Item> {
    return request(`/items/${encodeURIComponent(String(id))}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  },

  deleteItem(id: number | string): Promise<void> {
    return request(`/items/${encodeURIComponent(String(id))}`, { method: 'DELETE' });
  },

  async listCategories(signal?: AbortSignal): Promise<CategoryCount[]> {
    const data = await request<{ categories: CategoryCount[] }>('/categories', { signal });
    return data.categories;
  },

  listRacks(signal?: AbortSignal): Promise<RacksResponse> {
    return request('/racks', { signal });
  },

  getRack(rack: string, signal?: AbortSignal): Promise<RackDetail> {
    return request(`/racks/${encodeURIComponent(rack)}`, { signal });
  },

  importFile(file: File, dryRun: boolean): Promise<ImportResult> {
    const form = new FormData();
    form.append('file', file);
    return request(`/import?dryRun=${dryRun ? 'true' : 'false'}`, { method: 'POST', body: form });
  },

  templateUrl: `${BASE}/import/template`,

  /** Items that have no rack (no location, or one that isn't a rack coordinate), sorted by code. */
  async listUnlocated(signal?: AbortSignal): Promise<Item[]> {
    const data = await request<{ items: Item[] }>('/items?unlocated=true', { signal });
    return data.items;
  },

  authStatus(signal?: AbortSignal): Promise<AuthStatus> {
    return request('/auth/status', { signal });
  },

  login(pin: string): Promise<LoginResult> {
    return request('/auth/login', { method: 'POST', body: JSON.stringify({ pin }) });
  },

  scanMatch(body: ScanMatchRequest, signal?: AbortSignal): Promise<ScanMatchResponse> {
    return request('/scan/match', { method: 'POST', body: JSON.stringify(body), signal });
  },
};

export type Api = typeof api;
