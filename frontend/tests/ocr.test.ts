// The OCR wrapper (P2/P3/P7) with tesseract.js mocked: timeouts, no cached failures, cancel, idle stop.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Opts = { errorHandler?: (d: unknown) => void; logger?: (m: { status: string; progress: number }) => void };

const tess = vi.hoisted(() => ({ createWorker: vi.fn() }));
vi.mock('tesseract.js', () => ({ createWorker: tess.createWorker, OEM: { LSTM_ONLY: 1 } }));

import { OCR_TIMEOUTS, OcrError, READER_UNAVAILABLE, readText, resetReader } from '../src/scan/ocr';

function fakeWorker(text = 'COLEMAN') {
  return { recognize: vi.fn(async () => ({ data: { text } })), terminate: vi.fn(async () => undefined) };
}

const canvas = () => document.createElement('canvas');
const saved = { ...OCR_TIMEOUTS };

beforeEach(() => {
  tess.createWorker.mockReset();
  resetReader();
  Object.assign(OCR_TIMEOUTS, { initMs: 50, readMs: 50, idleMs: 30 });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  Object.assign(OCR_TIMEOUTS, saved);
  vi.restoreAllMocks();
});

describe('readText', () => {
  it('reads text and reuses the worker', async () => {
    const w = fakeWorker();
    tess.createWorker.mockResolvedValue(w);
    expect(await readText(canvas())).toBe('COLEMAN');
    expect(await readText(canvas())).toBe('COLEMAN');
    expect(tess.createWorker).toHaveBeenCalledTimes(1);
    const opts = tess.createWorker.mock.calls[0]![2] as Record<string, string>;
    expect(opts.workerPath).toMatch(/\/ocr\/worker\.min\.js$/);
    expect(opts.langPath).toMatch(/\/ocr\/$/);
  });

  it('a language file that fails to download rejects with a clear message, and the next scan retries', async () => {
    tess.createWorker.mockImplementationOnce((_l: unknown, _o: unknown, opts: Opts) => {
      opts.logger?.({ status: 'loading language traineddata', progress: 0 });
      setTimeout(() => opts.errorHandler?.('TypeError: Failed to fetch'), 0);
      return new Promise(() => {}); // tesseract.js never settles in this case
    });
    const err = await readText(canvas()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OcrError);
    expect((err as OcrError).part).toBe('language');
    expect((err as Error).message).toContain(READER_UNAVAILABLE);
    expect((err as Error).message).toMatch(/English language file/);

    tess.createWorker.mockResolvedValueOnce(fakeWorker('SUNDOME'));
    expect(await readText(canvas())).toBe('SUNDOME');
    expect(tess.createWorker).toHaveBeenCalledTimes(2);
  });

  it('a start-up that never finishes times out (worker script) instead of hanging', async () => {
    tess.createWorker.mockImplementationOnce(() => new Promise(() => {}));
    const err = (await readText(canvas()).catch((e: unknown) => e)) as OcrError;
    expect(err.part).toBe('worker');
    expect(err.message).toMatch(/reader program/);
  });

  it('a core that fails to load is named', async () => {
    tess.createWorker.mockImplementationOnce((_l: unknown, _o: unknown, opts: Opts) => {
      opts.logger?.({ status: 'loading tesseract core', progress: 0 });
      return Promise.reject('NetworkError: failed to import core');
    });
    const err = (await readText(canvas()).catch((e: unknown) => e)) as OcrError;
    expect(err.part).toBe('core');
  });

  it('a read that hangs times out and the worker is thrown away', async () => {
    const stuck = { recognize: vi.fn(() => new Promise(() => {})), terminate: vi.fn(async () => undefined) };
    tess.createWorker.mockResolvedValueOnce(stuck);
    const err = (await readText(canvas()).catch((e: unknown) => e)) as OcrError;
    expect(err.part).toBe('read-timeout');
    await vi.waitFor(() => expect(stuck.terminate).toHaveBeenCalled());
  });

  it('cancelling (leaving the page) rejects at once and terminates the worker; progress stops', async () => {
    let logger: Opts['logger'];
    const w = { recognize: vi.fn(() => new Promise(() => {})), terminate: vi.fn(async () => undefined) };
    tess.createWorker.mockImplementationOnce(async (_l: unknown, _o: unknown, opts: Opts) => {
      logger = opts.logger;
      return w;
    });
    const progress = vi.fn();
    const controller = new AbortController();
    const reading = readText(canvas(), progress, controller.signal).catch((e: unknown) => e);
    await vi.waitFor(() => expect(w.recognize).toHaveBeenCalled());
    logger?.({ status: 'recognizing text', progress: 0.5 });
    expect(progress).toHaveBeenCalledWith('reading', 0.5);
    controller.abort();
    const err = (await reading) as OcrError;
    expect(err.part).toBe('cancelled');
    await vi.waitFor(() => expect(w.terminate).toHaveBeenCalled());
    progress.mockClear();
    logger?.({ status: 'recognizing text', progress: 0.9 });
    expect(progress).not.toHaveBeenCalled();
  });

  it('the worker is terminated after being idle', async () => {
    const w = fakeWorker();
    tess.createWorker.mockResolvedValue(w);
    await readText(canvas());
    await vi.waitFor(() => expect(w.terminate).toHaveBeenCalled());
    await readText(canvas());
    expect(tess.createWorker).toHaveBeenCalledTimes(2);
  });
});
