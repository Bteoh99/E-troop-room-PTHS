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
  action?: 'create' | 'update';
} & Record<string, unknown>;

export interface ImportResult {
  dryRun: boolean;
  created: number;
  updated: number;
  skipped: number;
  /** Entries whose message starts with "Warning:" are warnings; the row was still imported. */
  errors: ImportRowError[];
  preview: ImportPreviewRow[];
  /** Backend additions (optional). */
  headerRow?: number;
  columns?: Record<string, number>;
  ignoredColumns?: string[];
}

export interface ApiErrorBody {
  error: { message: string; details?: unknown };
}
