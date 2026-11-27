// Types mirror the API contract in docs/SPEC.md. Keep them in sync.

export type Condition = 'good' | 'needs_repair' | 'damaged' | 'written_off';

export const CONDITIONS: readonly Condition[] = ['good', 'needs_repair', 'damaged', 'written_off'];

export interface Item {
  id: number;
  code: string;
  name: string;
  category: string | null;
  locationCode: string | null;
  rack: string | null;
  shelf: string | null;
  bin: number | null;
  quantity: number;
  unit: string;
  condition: Condition;
  notes: string;
  /** Phase 1.5 fields (optional so older data/tests stay valid). */
  brand?: string | null;
  model?: string | null;
  barcode?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Body for POST /api/items (and PUT, where every field is optional). */
export interface ItemInput {
  code: string;
  name: string;
  category?: string | null;
  locationCode?: string | null;
  quantity?: number;
  unit?: string;
  condition?: Condition;
  notes?: string;
  brand?: string | null;
  model?: string | null;
  barcode?: string | null;
}

export interface ItemFilters {
  q?: string;
  category?: string;
  rack?: string;
  condition?: Condition;
}

export interface CategoryCount {
  name: string;
  count: number;
}

export interface RackSummary {
  rack: string;
  shelves: string[];
  itemCount: number;
}

export interface RacksResponse {
  racks: RackSummary[];
  unlocated: number;
}

export interface RackShelf {
  shelf: string;
  items: Item[];
}

export interface RackDetail {
  rack: string;
  shelves: RackShelf[];
  /** Items on this rack with no shelf recorded (e.g. location "R03"). Backend addition. */
  unshelved?: Item[];
}

export interface ImportRowError {
  row: number;
  message: string;
}

/**
 * Preview rows are "Item-like". The backend also adds `row` (sheet row number),
 * `action` and `id` (null for new items).
 */
export type ImportPreviewRow = Partial<Omit<Item, 'id'>> & {
  id?: number | null;
  row?: number;
  /** "unchanged" = existing item the file leaves as is. Unknown future values are shown as-is. */
  action?: 'create' | 'update' | 'unchanged' | (string & {});
} & Record<string, unknown>;

export interface ImportResult {
  dryRun: boolean;
  created: number;
  updated: number;
  skipped: number;
  /** Entries whose message starts with "Warning:" are warnings; the row was still imported. */
  errors: ImportRowError[];
  preview: ImportPreviewRow[];
  /** Backend additions (optional). Existing items the file leaves as is (counted per distinct code). */
  unchanged?: number;
  headerRow?: number;
  columns?: Record<string, number>;
  /** Unrecognised or duplicate headers, possibly with a reason, e.g. `ID (duplicate code column; "Code" is used)`. */
  ignoredColumns?: string[];
}

export interface ApiErrorBody {
  error: { message: string; details?: unknown };
}

// ---- Phase 1.5 ----

export interface AuthStatus {
  pinSet: boolean;
  leader: boolean;
  /** The PIN is an old 4–5 digit one (new PINs are 6–8 digits). */
  pinTooShort?: boolean;
}

export interface LoginResult {
  token: string;
  expiresAt: string;
}

export interface ScanMatchRequest {
  text?: string;
  barcode?: string;
}

export interface ScanMatch {
  item: Item;
  /** 0..1 */
  score: number;
  /** e.g. ["brand", "model"] */
  matchedOn: string[];
}

export interface ScanMatchResponse {
  matches: ScanMatch[];
  query: { tokens: string[]; barcode?: string };
}
