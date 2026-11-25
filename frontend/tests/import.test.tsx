import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api/client';
import type { ImportResult } from '../src/api/types';
import { MAX_IMPORT_BYTES, checkFile, describeImportError, isWarning, splitProblems } from '../src/pages/ImportPage';
import { installApiDefaults } from './apiMock';
import { renderApp } from './helpers';

vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>();
  const { createApiMock } = await import('./apiMock');
  return { ...actual, api: createApiMock() };
});

const m = vi.mocked(api);

const dryRun: ImportResult = {
  dryRun: true,
  created: 2,
  updated: 1,
  skipped: 1,
  errors: [
    { row: 4, message: 'Missing name' },
    { row: 5, message: 'Warning: unknown condition "meh" — saved as good' },
  ],
  preview: [
    { row: 2, action: 'create', id: null, code: 'TNT-100', name: 'Big tent', locationCode: 'R03-B-2', category: 'Tents', quantity: 2, unit: 'pcs', condition: 'good' },
    { row: 3, action: 'update', id: 1, code: 'TNT-004', name: '4-man dome tent', locationCode: 'R01-B-2', category: 'Tents', quantity: 6, unit: 'pcs', condition: 'needs_repair' },
    { row: 5, action: 'create', id: null, code: 'MSC-1', name: 'Bucket', locationCode: null, category: null, quantity: 1, unit: 'pcs', condition: 'good' },
  ],
  headerRow: 1,
  columns: { code: 0, name: 1 },
  ignoredColumns: ['Colour'],
};
const realRun: ImportResult = { ...dryRun, dryRun: false };

const xlsx = (name = 'stock.xlsx', size = 1234) => {
  const f = new File(['x'], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

beforeEach(() => {
  installApiDefaults(api);
});

async function choose(file: File) {
  const user = userEvent.setup({ applyAccept: false });
  renderApp('/import');
  await user.upload(screen.getByLabelText('Excel or CSV file'), file);
  return user;
}

describe('import helpers (pure)', () => {
  it('checkFile accepts .xlsx/.csv up to 5 MB only', () => {
    expect(checkFile(xlsx('a.xlsx'))).toBeNull();
    expect(checkFile(xlsx('A.CSV'))).toBeNull();
    expect(checkFile(xlsx('a.xls'))).toMatch(/\.xlsx.*\.csv/);
    expect(checkFile(xlsx('a.xlsx', MAX_IMPORT_BYTES))).toBeNull();
    expect(checkFile(xlsx('a.xlsx', MAX_IMPORT_BYTES + 1))).toMatch(/bigger than 5 MB/);
  });

  it('splits warnings ("Warning:" prefix) from problems', () => {
    expect(isWarning({ row: 1, message: 'Warning: x' })).toBe(true);
    expect(isWarning({ row: 1, message: 'warning - x' })).toBe(true);
    expect(isWarning({ row: 1, message: 'Missing name' })).toBe(false);
    const { problems, warnings } = splitProblems(dryRun);
    expect(problems.map((p) => p.row)).toEqual([4]);
    expect(warnings.map((p) => p.row)).toEqual([5]);
  });

  it('describes missing-column and too-large errors in plain words', () => {
    const missing = describeImportError(
      new ApiError('Missing columns', 400, { missingColumns: ['code', 'name'], headersFound: ['Barang', 'Qty'] }),
    );
    expect(missing.message).toBe("We couldn't find the code and name columns in your file.");
    expect(missing.hints[0]).toBe('Column headings we found: Barang, Qty.');
    expect(describeImportError(new ApiError('File too large', 413)).message).toMatch(/bigger than 5 MB/);
    expect(describeImportError(new Error('Other')).message).toBe('Other');
  });
});

describe('Import page', () => {
  it('offers the template download link', () => {
    renderApp('/import');
    const link = screen.getByRole('link', { name: /download the template/i });
    expect(link).toHaveAttribute('href', '/api/import/template');
    expect(link).toHaveAttribute('download', 'item-template.xlsx');
    expect(screen.getByLabelText('Excel or CSV file')).toHaveAttribute('accept', expect.stringContaining('.xlsx'));
  });

  it('rejects a wrong file type on the client without calling the API', async () => {
    await choose(new File(['x'], 'old.xls'));
    expect(screen.getByRole('alert')).toHaveTextContent('Please choose an Excel (.xlsx) or CSV (.csv) file.');
    expect(m.importFile).not.toHaveBeenCalled();
  });

  it('rejects a file over 5 MB on the client', async () => {
    await choose(xlsx('big.xlsx', MAX_IMPORT_BYTES + 10));
    expect(screen.getByRole('alert')).toHaveTextContent('bigger than 5 MB');
    expect(m.importFile).not.toHaveBeenCalled();
  });

  it('runs a dry run automatically and shows counts, problems, warnings, ignored columns and preview rows', async () => {
    let finish: (r: ImportResult) => void = () => {};
    m.importFile.mockImplementationOnce(() => new Promise<ImportResult>((r) => (finish = r)));
    const file = xlsx();
    await choose(file);
    expect(m.importFile).toHaveBeenCalledWith(file, true);
    expect(screen.getByText('Checking stock.xlsx…')).toBeInTheDocument();
    expect(screen.getByLabelText('Excel or CSV file')).toBeDisabled();
    finish(dryRun);

    const counts = await screen.findByTestId('import-counts');
    const stat = (label: string) => within(counts).getByText(label).nextElementSibling?.textContent;
    expect(stat('Will be added')).toBe('2');
    expect(stat('Will be updated')).toBe('1');
    expect(stat('Will be skipped')).toBe('1');
    expect(stat('Problems')).toBe('1');
    expect(stat('Warnings')).toBe('1');

    const problems = screen.getByTestId('import-problems');
    expect(problems).toHaveTextContent('these rows will be skipped (1)');
    expect(within(problems).getAllByRole('row')[1]).toHaveTextContent(/4\s*Missing name/);
    const warnings = screen.getByTestId('import-warnings');
    expect(warnings).toHaveTextContent('these rows will still be imported (1)');
    expect(warnings).toHaveTextContent('Unknown condition "meh" — saved as good');
    expect(warnings).not.toHaveTextContent('Warning:');

    expect(screen.getByText(/will be ignored/)).toHaveTextContent('Colour');

    const preview = screen.getByTestId('import-preview');
    const rows = within(preview).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent(/2\s*Add new\s*TNT-100\s*Big tent\s*R03-B-2\s*Tents\s*2 pcs\s*Good/);
    expect(rows[1]).toHaveTextContent(/Update.*TNT-004.*Needs repair/);
    expect(rows[2]).toHaveTextContent(/MSC-1\s*Bucket\s*—/);
    expect(screen.getByText(/First 3 rows as they will be saved/)).toBeInTheDocument();
    // Nothing written yet.
    expect(m.importFile).toHaveBeenCalledTimes(1);
  });

  it('Confirm import sends dryRun=false and shows the finished summary', async () => {
    m.importFile.mockResolvedValueOnce(dryRun).mockResolvedValueOnce(realRun);
    const file = xlsx();
    const user = await choose(file);
    await user.click(await screen.findByRole('button', { name: 'Confirm import' }));
    expect(m.importFile).toHaveBeenLastCalledWith(file, false);
    expect(await screen.findByRole('heading', { name: /Import finished/ })).toBeInTheDocument();
    const counts = screen.getByTestId('import-counts');
    expect(within(counts).getByText('Added').nextElementSibling).toHaveTextContent('2');
    expect(within(counts).getByText('Updated').nextElementSibling).toHaveTextContent('1');
    expect(screen.getByTestId('import-problems')).toHaveTextContent('these rows were skipped');
    expect(screen.getByRole('link', { name: 'Search items' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'View the map' })).toHaveAttribute('href', '/map');
    // Import another file returns to step 1.
    await user.click(screen.getByRole('button', { name: 'Import another file' }));
    expect(screen.getByLabelText('Excel or CSV file')).toBeEnabled();
    expect(m.importFile).toHaveBeenCalledTimes(2);
  });

  it('disables Confirm when there is nothing to import', async () => {
    m.importFile.mockResolvedValueOnce({ ...dryRun, created: 0, updated: 0, skipped: 3, preview: [] });
    await choose(xlsx());
    expect(await screen.findByRole('button', { name: 'Confirm import' })).toBeDisabled();
    expect(screen.getByText(/There is nothing to import in this file/)).toBeInTheDocument();
  });

  it('"Choose a different file" goes back to step 1 without importing', async () => {
    m.importFile.mockResolvedValueOnce(dryRun);
    const user = await choose(xlsx());
    await user.click(await screen.findByRole('button', { name: 'Choose a different file' }));
    expect(screen.queryByTestId('import-preview')).toBeNull();
    expect(m.importFile).toHaveBeenCalledTimes(1);
  });

  it('explains a 400 missing-columns error and offers the template (no pointless retry)', async () => {
    m.importFile.mockRejectedValueOnce(
      new ApiError('Could not find code/name columns', 400, { missingColumns: ['code'], headersFound: ['Barang', 'Nama'] }),
    );
    await choose(xlsx());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't check that file");
    expect(alert).toHaveTextContent("We couldn't find the code column in your file.");
    expect(alert).toHaveTextContent('Column headings we found: Barang, Nama.');
    expect(within(alert).queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(within(alert).getByRole('link', { name: 'Download the template' })).toHaveAttribute(
      'href',
      '/api/import/template',
    );
  });

  it('explains a 413 from the server', async () => {
    m.importFile.mockRejectedValueOnce(new ApiError('File too large; the maximum is 5 MB', 413));
    await choose(xlsx());
    expect(await screen.findByRole('alert')).toHaveTextContent('That file is bigger than 5 MB');
  });

  it('network failure during the real import says nothing was saved and can retry the real import', async () => {
    m.importFile
      .mockResolvedValueOnce(dryRun)
      .mockRejectedValueOnce(new ApiError("Can't reach the store-room server.", 0))
      .mockResolvedValueOnce(realRun);
    const file = xlsx();
    const user = await choose(file);
    await user.click(await screen.findByRole('button', { name: 'Confirm import' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The import did not finish — nothing was saved');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { name: /Import finished/ });
    expect(m.importFile.mock.calls.map((c) => c[1])).toEqual([true, false, false]);
  });

  it('shows the step indicator with aria-current', async () => {
    m.importFile.mockResolvedValueOnce(dryRun);
    renderApp('/import');
    const steps = screen.getByRole('list', { name: 'Import steps' });
    expect(within(steps).getByText('Choose file').closest('li')).toHaveAttribute('aria-current', 'step');
    await userEvent.setup().upload(screen.getByLabelText('Excel or CSV file'), xlsx());
    await waitFor(() =>
      expect(within(steps).getByText('Check preview').closest('li')).toHaveAttribute('aria-current', 'step'),
    );
  });
});
