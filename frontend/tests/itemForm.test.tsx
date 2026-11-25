import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api/client';
import type { Item, ItemInput } from '../src/api/types';
import { toInput, validate, type FormValues } from '../src/pages/ItemFormPage';
import { installApiDefaults } from './apiMock';
import { currentLocation, makeItem, renderApp } from './helpers';

vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>();
  const { createApiMock } = await import('./apiMock');
  return { ...actual, api: createApiMock() };
});

const m = vi.mocked(api);

const existing = makeItem({
  id: 5,
  code: 'TNT-006',
  name: '6-man patrol tent',
  locationCode: 'R01-C-1',
  quantity: 3,
  condition: 'needs_repair',
  notes: 'Broken zip',
});

function savedFrom(input: Partial<ItemInput>, id = 42): Item {
  return makeItem({ ...input, id, locationCode: input.locationCode ?? null } as Partial<Item>);
}

beforeEach(() => {
  installApiDefaults(api);
  m.listCategories.mockResolvedValue([{ name: 'Tents', count: 3 }]);
  m.createItem.mockImplementation(async (input: ItemInput) => savedFrom(input));
  m.updateItem.mockImplementation(async (id: string | number, input: Partial<ItemInput>) =>
    savedFrom({ ...existing, ...input }, Number(id)),
  );
  m.getItem.mockImplementation(async (id: string | number) => (Number(id) === 5 ? existing : savedFrom({}, Number(id))));
  m.getRack.mockResolvedValue({ rack: 'R03', shelves: [], unshelved: [] });
});

const field = (name: RegExp | string) => screen.getByLabelText(name);

/** Render the add form and wait until it has loaded. */
async function openNew(history: string[] = ['/items/new']) {
  renderApp(history);
  await screen.findByRole('heading', { level: 1, name: 'Add an item' });
}

describe('validate / toInput (pure)', () => {
  const base: FormValues = {
    code: ' tnt-099 ',
    name: ' Bivvy ',
    category: ' ',
    location: 'r3 b 2',
    quantity: ' 007 ',
    unit: ' ',
    condition: 'good',
    notes: ' hi ',
  };

  it('requires code and name, and a whole-number quantity >= 0', () => {
    expect(validate({ ...base, code: '  ', name: '' })).toEqual({
      code: expect.stringMatching(/item code/i),
      name: expect.stringMatching(/name/i),
    });
    for (const q of ['-1', '1.5', 'abc', '1e3']) expect(validate({ ...base, quantity: q }).quantity).toMatch(/whole number/);
    expect(validate({ ...base, quantity: '' }).quantity).toMatch(/enter a quantity/);
    expect(validate({ ...base, quantity: '0' })).toEqual({});
  });

  it('normalises the payload (uppercase code, canonical location, defaults)', () => {
    expect(toInput(base)).toEqual({
      code: 'TNT-099',
      name: 'Bivvy',
      category: null,
      locationCode: 'R03-B-2',
      quantity: 7,
      unit: 'pcs',
      condition: 'good',
      notes: 'hi',
    });
    expect(toInput({ ...base, location: '  ' }).locationCode).toBeNull();
    expect(toInput({ ...base, location: ' shed corner ' }).locationCode).toBe('shed corner');
  });
});

describe('Add item form', () => {
  it('has labelled fields with sensible defaults', async () => {
    await openNew();
    expect(field(/item code/i)).toHaveValue('');
    expect(field(/^name/i)).toHaveValue('');
    expect(field('Quantity')).toHaveValue(1);
    expect(field('Unit')).toHaveValue('pcs');
    expect(field('Condition')).toHaveValue('good');
    expect(within(field('Condition')).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Good',
      'Needs repair',
      'Damaged',
      'Written off',
    ]);
    expect(screen.getByRole('link', { name: 'Add' })).toHaveAttribute('aria-current', 'page');
  });

  it('blocks submit with validation messages, an error summary that gets focus, and aria-invalid', async () => {
    const user = userEvent.setup();
    await openNew();
    await user.clear(field('Quantity'));
    await user.click(screen.getByRole('button', { name: 'Add item' }));

    const summary = await screen.findByRole('alert');
    expect(summary).toHaveTextContent('Please fix the following:');
    expect(summary).toHaveFocus();
    const links = within(summary).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual([
      'Please enter an item code, e.g. TNT-004.',
      'Please enter a name, e.g. 4-man dome tent.',
      'Please enter a quantity (0 or more).',
    ]);
    expect(links[0]).toHaveAttribute('href', `#${field(/item code/i).id}`);
    expect(field(/item code/i)).toHaveAttribute('aria-invalid', 'true');
    expect(field(/item code/i)).toHaveAccessibleDescription(/Please enter an item code/);
    expect(field(/^name/i)).toHaveAttribute('aria-invalid', 'true');
    expect(m.createItem).not.toHaveBeenCalled();
  });

  it('clears a field error live once it is fixed (after the first submit)', async () => {
    const user = userEvent.setup();
    await openNew();
    await user.click(screen.getByRole('button', { name: 'Add item' }));
    await user.type(field(/item code/i), 'x-1');
    expect(field(/item code/i)).not.toHaveAttribute('aria-invalid');
    expect(screen.getByRole('alert')).not.toHaveTextContent('Please enter an item code');
    expect(screen.getByRole('alert')).toHaveTextContent('Please enter a name');
  });

  it('rejects a fractional quantity', async () => {
    const user = userEvent.setup();
    await openNew();
    await user.type(field(/item code/i), 'X-1');
    await user.type(field(/^name/i), 'Thing');
    fireEvent.change(field('Quantity'), { target: { value: '2.5' } });
    await user.click(screen.getByRole('button', { name: 'Add item' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Quantity must be a whole number, 0 or more.');
    expect(m.createItem).not.toHaveBeenCalled();
  });

  it.each([
    ['r3-b-2', 'R03-B-2', 'Rack 03 · Shelf B · Bin 2'],
    ['R3 B 2', 'R03-B-2', 'Rack 03 · Shelf B · Bin 2'],
    ['3/c', 'R03-C', 'Rack 03 · Shelf C'],
    ['r12', 'R12', 'Rack 12'],
  ])('live preview of the normalised location: %s -> %s', async (typed, code, desc) => {
    const user = userEvent.setup();
    await openNew();
    const preview = screen.getByTestId('location-preview');
    expect(preview).toHaveTextContent(/Optional/);
    expect(preview).toHaveAttribute('aria-live', 'polite');
    await user.type(field('Location'), typed);
    expect(preview).toHaveTextContent('Will be saved as');
    expect(within(preview).getByTestId('location-badge')).toHaveTextContent(code);
    expect(preview).toHaveTextContent(desc);
    expect(field('Location')).toHaveAccessibleDescription(new RegExp(code));
  });

  it('warns (but allows) a location that is not a rack coordinate', async () => {
    const user = userEvent.setup();
    await openNew();
    await user.type(field('Location'), 'behind the door');
    expect(screen.getByTestId('location-preview')).toHaveTextContent(
      "“behind the door” isn't a rack coordinate. It will be saved exactly as typed",
    );
    await user.type(field(/item code/i), 'MSC-9');
    await user.type(field(/^name/i), 'Broom');
    await user.click(screen.getByRole('button', { name: 'Add item' }));
    await waitFor(() => expect(m.createItem).toHaveBeenCalled());
    expect(m.createItem.mock.calls[0]?.[0]).toMatchObject({ locationCode: 'behind the door' });
  });

  it('creates the item with a normalised payload and opens its detail page with a flash', async () => {
    const user = userEvent.setup();
    await openNew(['/', '/items/new']);
    await user.type(field(/item code/i), 'tnt-099');
    await user.type(field(/^name/i), '  Bivvy bag ');
    await user.type(field('Location'), 'r3 b 2');
    await user.type(field('Category'), 'Tents');
    await user.clear(field('Quantity'));
    await user.type(field('Quantity'), '4');
    await user.selectOptions(field('Condition'), 'damaged');
    await user.type(field('Notes'), 'Torn');
    await user.click(screen.getByRole('button', { name: 'Add item' }));

    await waitFor(() => expect(m.createItem).toHaveBeenCalledTimes(1));
    expect(m.createItem).toHaveBeenCalledWith({
      code: 'TNT-099',
      name: 'Bivvy bag',
      category: 'Tents',
      locationCode: 'R03-B-2',
      quantity: 4,
      unit: 'pcs',
      condition: 'damaged',
      notes: 'Torn',
    });
    expect(await screen.findByText('Added “Bivvy bag”.')).toBeInTheDocument();
    expect(currentLocation()).toBe('/items/42');
  });

  it('disables the submit button while saving (no double submit)', async () => {
    let finish: (v: Item) => void = () => {};
    m.createItem.mockImplementation(() => new Promise<Item>((r) => (finish = r)));
    const user = userEvent.setup();
    await openNew();
    await user.type(field(/item code/i), 'A-1');
    await user.type(field(/^name/i), 'A');
    await user.click(screen.getByRole('button', { name: 'Add item' }));
    const busy = screen.getByRole('button', { name: 'Saving…' });
    expect(busy).toBeDisabled();
    await user.click(busy);
    expect(m.createItem).toHaveBeenCalledTimes(1);
    finish(savedFrom({ code: 'A-1', name: 'A' }));
    await waitFor(() => expect(currentLocation()).toBe('/items/42'));
  });

  it('shows a duplicate-code (409) error on the code field', async () => {
    m.createItem.mockRejectedValue(new ApiError('Duplicate item code', 409));
    const user = userEvent.setup();
    await openNew();
    await user.type(field(/item code/i), 'TNT-004');
    await user.type(field(/^name/i), 'Dup');
    await user.click(screen.getByRole('button', { name: 'Add item' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That item code is already taken.');
    expect(field(/item code/i)).toHaveAttribute('aria-invalid', 'true');
    expect(field(/item code/i)).toHaveAccessibleDescription(/Another item already uses this code/);
    expect(currentLocation()).toBe('/items/new');
    // Editing the code clears the server error.
    await user.type(field(/item code/i), 'X');
    expect(field(/item code/i)).not.toHaveAttribute('aria-invalid');
  });

  it('maps backend 400 validation details ({path, message}[]) onto the fields', async () => {
    m.createItem.mockRejectedValue(
      new ApiError('Validation failed', 400, [
        { path: 'name', message: 'Name must be at most 200 characters' },
        { path: 'quantity', message: 'Quantity is too large' },
      ]),
    );
    const user = userEvent.setup();
    await openNew();
    await user.type(field(/item code/i), 'X-1');
    await user.type(field(/^name/i), 'n');
    await user.click(screen.getByRole('button', { name: 'Add item' }));
    const alert = await screen.findByRole('alert');
    // Lead decision (round 2): a generic "Validation failed" is replaced by friendly wording.
    expect(alert).toHaveTextContent('Please fix the highlighted fields.');
    expect(field(/^name/i)).toHaveAccessibleDescription(/Name must be at most 200 characters/);
    expect(field('Quantity')).toHaveAccessibleDescription(/Quantity is too large/);
  });

  it('shows backend errors for category / location inline on those fields too', async () => {
    m.createItem.mockRejectedValue(
      new ApiError('Validation failed', 400, [
        { path: 'category', message: 'Too big: expected string to have <=100 characters' },
        { path: 'locationCode', message: 'Too big: expected string to have <=100 characters' },
      ]),
    );
    const user = userEvent.setup();
    await openNew();
    await user.type(field(/item code/i), 'X-1');
    await user.type(field(/^name/i), 'n');
    await user.click(screen.getByRole('button', { name: 'Add item' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getAllByRole('link')).toHaveLength(2);
    expect(field('Category')).toHaveAttribute('aria-invalid', 'true');
    // Lead decision (round 2): raw zod text ("Too big: …") is translated into friendly wording.
    expect(field('Category')).toHaveAccessibleDescription(/Category can be at most 100 characters/);
    expect(field('Location')).toHaveAttribute('aria-invalid', 'true');
    expect(field('Location')).toHaveAccessibleDescription(/Location can be at most 100 characters/);
    expect(alert).not.toHaveTextContent(/Too big|expected string/);
  });

  it('shows a network error message without losing the typed values', async () => {
    m.createItem.mockRejectedValue(new ApiError("Can't reach the store-room server.", 0));
    const user = userEvent.setup();
    await openNew();
    await user.type(field(/item code/i), 'X-1');
    await user.type(field(/^name/i), 'Keep me');
    await user.click(screen.getByRole('button', { name: 'Add item' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't reach the store-room server.");
    expect(field(/^name/i)).toHaveValue('Keep me');
    expect(screen.getByRole('button', { name: 'Add item' })).toBeEnabled();
  });
});

describe('Edit item form', () => {
  it('prefills every field from the item', async () => {
    renderApp('/items/5/edit');
    expect(await screen.findByRole('heading', { level: 1, name: 'Edit TNT-006' })).toBeInTheDocument();
    expect(field(/item code/i)).toHaveValue('TNT-006');
    expect(field(/^name/i)).toHaveValue('6-man patrol tent');
    expect(field('Location')).toHaveValue('R01-C-1');
    expect(field('Category')).toHaveValue('Tents');
    expect(field('Quantity')).toHaveValue(3);
    expect(field('Condition')).toHaveValue('needs_repair');
    expect(field('Notes')).toHaveValue('Broken zip');
    expect(screen.getByRole('link', { name: 'Cancel' })).toHaveAttribute('href', '/items/5');
  });

  it('saves changes with updateItem and shows "Changes saved."', async () => {
    const user = userEvent.setup();
    renderApp(['/items/5', '/items/5/edit']);
    const loc = await screen.findByLabelText('Location');
    await user.clear(loc);
    await user.type(loc, 'r2 a 1');
    await user.clear(field('Quantity'));
    await user.type(field('Quantity'), '0');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(m.updateItem).toHaveBeenCalledTimes(1));
    expect(m.updateItem.mock.calls[0]?.[0]).toBe(5);
    expect(m.updateItem.mock.calls[0]?.[1]).toMatchObject({ code: 'TNT-006', locationCode: 'R02-A-1', quantity: 0 });
    expect(m.createItem).not.toHaveBeenCalled();
    expect(await screen.findByText('Changes saved.')).toBeInTheDocument();
    expect(currentLocation()).toBe('/items/5');
  });

  it('clearing the location sends locationCode: null', async () => {
    const user = userEvent.setup();
    renderApp('/items/5/edit');
    await user.clear(await screen.findByLabelText('Location'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(m.updateItem).toHaveBeenCalled());
    expect(m.updateItem.mock.calls[0]?.[1]).toMatchObject({ locationCode: null });
  });

  it('shows not-found for an unknown id', async () => {
    m.getItem.mockRejectedValue(new ApiError('Item 404 not found', 404));
    renderApp('/items/404/edit');
    expect(await screen.findByText("We couldn't find that item")).toBeInTheDocument();
  });

  it('after saving, the detail page Back link does not return to the edit form', async () => {
    // Flow: search -> detail -> edit -> save -> detail; Back should leave the item, not reopen the form.
    m.listItems.mockResolvedValue([existing]);
    const user = userEvent.setup();
    renderApp(['/?q=tent', '/items/5', '/items/5/edit']);
    await screen.findByRole('heading', { level: 1, name: 'Edit TNT-006' });
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes saved.');
    await user.click(await screen.findByRole('link', { name: /^Back$/ }));
    // Expected: back to the search the user came from (the edit entry should have been replaced).
    await waitFor(() => expect(currentLocation()).toBe('/?q=tent'));
  });
});
