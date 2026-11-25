// Regression tests for the round-3 fixes (developer-added).
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api/client';
import type { ImportResult } from '../src/api/types';
import { RackDiagram } from '../src/components/RackDiagram';
import { installApiDefaults } from './apiMock';
import { renderApp } from './helpers';

vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>();
  const { createApiMock } = await import('./apiMock');
  return { ...actual, api: createApiMock() };
});

const m = vi.mocked(api);

beforeEach(() => {
  installApiDefaults(api);
});

describe('bin 0', () => {
  it('every shelf of the rack starts at bin 0 when any item uses it', () => {
    render(
      <RackDiagram
        rack="R03"
        items={[
          { id: 1, shelf: 'A', bin: 0 },
          { id: 2, shelf: 'B', bin: 2 },
        ]}
      />,
    );
    const d = screen.getByTestId('rack-diagram');
    expect([...d.querySelectorAll('[data-shelf="B"] [data-bin]')].map((b) => b.getAttribute('data-bin'))).toEqual([
      '0',
      '1',
      '2',
      '3',
    ]);
    expect(d.querySelector('[data-shelf="A"] [data-bin="0"]')).toHaveClass('has-items');
  });

  it('racks without bin 0 still start at bin 1', () => {
    render(<RackDiagram rack="R03" items={[{ id: 1, shelf: 'A', bin: 2 }]} />);
    const first = screen.getByTestId('rack-diagram').querySelector('[data-shelf="A"] [data-bin]');
    expect(first).toHaveAttribute('data-bin', '1');
  });
});

describe('Import (round 3)', () => {
  const xlsx = () => new File(['x'], 'items.xlsx');
  const dryRun: ImportResult = {
    dryRun: true,
    created: 1,
    updated: 0,
    skipped: 0,
    errors: [],
    preview: [{ row: 2, action: 'create', code: 'A-1', name: 'A', locationCode: 'R01-A-1' }],
    ignoredColumns: ['Colour', 'Colour', 'ID (duplicate code column; "Code" is used)'],
  };

  async function choose() {
    const user = userEvent.setup();
    renderApp('/import');
    await user.upload(await screen.findByLabelText('Excel or CSV file'), xlsx());
    return user;
  }

  it('repeated ignored-column names render without duplicate-key warnings', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.importFile.mockResolvedValueOnce(dryRun);
    await choose();
    const note = await screen.findByText(/will be ignored/);
    expect(within(note).getAllByRole('listitem')).toHaveLength(3);
    expect(spy.mock.calls.flat().join(' ')).not.toMatch(/same key/);
    spy.mockRestore();
  });

  it('names the chosen file next to the (reset) picker while checking and in the preview', async () => {
    let finish: (r: ImportResult) => void = () => {};
    m.importFile.mockImplementationOnce(() => new Promise<ImportResult>((r) => (finish = r)));
    await choose();
    expect(screen.getByTestId('chosen-file')).toHaveTextContent('Checking: items.xlsx');
    finish(dryRun);
    await screen.findByTestId('import-counts');
    expect(screen.getByTestId('chosen-file')).toHaveTextContent('Selected: items.xlsx');
  });

  it('a server error (not a dropped connection) during the real import still says nothing was saved', async () => {
    m.importFile.mockResolvedValueOnce(dryRun).mockRejectedValueOnce(new ApiError('Internal server error', 500));
    const user = await choose();
    await user.click(await screen.findByRole('button', { name: 'Confirm import' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The import did not finish — nothing was saved');
  });

  it('a dropped connection during the real import asks the user to check before importing again', async () => {
    m.importFile.mockResolvedValueOnce(dryRun).mockRejectedValueOnce(new ApiError("Can't reach the server.", 0));
    const user = await choose();
    await user.click(await screen.findByRole('button', { name: 'Confirm import' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't confirm whether the import finished/);
    expect(alert).not.toHaveTextContent('nothing was saved');
  });

  it('the preview puts Location right after Code', async () => {
    m.importFile.mockResolvedValueOnce(dryRun);
    await choose();
    const headers = within(await screen.findByTestId('import-preview'))
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers.slice(0, 4)).toEqual(['Row', 'Action', 'Code', 'Location']);
  });
});
