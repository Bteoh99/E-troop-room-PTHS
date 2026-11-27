/** Longest side of the image we work on. Big phone photos (12+ MP) are far too slow for OCR on old phones. */
export const MAX_SIDE = 1600;
/** Longest side of the on-screen thumbnail. */
export const THUMB_SIDE = 240;

export interface PreparedImage {
  /** Greyscale, contrast-stretched, at most MAX_SIDE px on the longest side. */
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  /** One luminance byte per pixel (for the barcode reader). */
  grey: Uint8ClampedArray;
  /** Small copy for the screen (so the 12 MP original is never decoded a second time). */
  thumbnail?: HTMLCanvasElement;
}

export function scaledSize(width: number, height: number, maxSide = MAX_SIDE): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

type Source = CanvasImageSource & { width: number; height: number; close?: () => void };

/** Reads only the image's size (the browser decodes pixels lazily, on draw). */
function naturalSize(file: Blob): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(file);
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("This photo couldn't be opened. Try taking it again."));
    img.src = url;
  }).finally(() => URL.revokeObjectURL(url));
}

/**
 * Decodes the photo ONCE, already downscaled where the browser supports it
 * (createImageBitmap resize options), respecting the phone's EXIF rotation.
 */
async function decodeDownscaled(file: Blob): Promise<Source> {
  if (typeof createImageBitmap === 'function') {
    try {
      const size = await naturalSize(file);
      const target = scaledSize(size.width, size.height);
      // Give only the long side: the browser keeps the aspect ratio (also after EXIF rotation).
      const resize = size.width >= size.height ? { resizeWidth: target.width } : { resizeHeight: target.height };
      return await createImageBitmap(file, { imageOrientation: 'from-image', resizeQuality: 'medium', ...resize });
    } catch {
      try {
        return await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch {
        /* fall back to <img> */
      }
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Downscale + greyscale + stretch contrast (helps OCR on dim store-room photos). */
export async function prepareImage(file: Blob): Promise<PreparedImage> {
  const source = await decodeDownscaled(file);
  const { width, height } = scaledSize(source.width, source.height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('This browser cannot process photos.');
  ctx.drawImage(source, 0, 0, width, height);
  source.close?.(); // free the decoded bitmap right away

  const image = ctx.getImageData(0, 0, width, height);
  const px = image.data;
  const grey = new Uint8ClampedArray(width * height);
  const histogram = new Uint32Array(256);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const y = (px[i]! * 299 + px[i + 1]! * 587 + px[i + 2]! * 114) / 1000;
    grey[j] = y;
    histogram[grey[j]!]!++;
  }
  // Stretch between the 1st and 99th percentile.
  const total = width * height;
  let lo = 0;
  let hi = 255;
  for (let acc = 0; lo < 255 && (acc += histogram[lo]!) < total * 0.01; lo++);
  for (let acc = 0; hi > 0 && (acc += histogram[hi]!) < total * 0.01; hi--);
  const range = Math.max(1, hi - lo);
  for (let j = 0, i = 0; j < grey.length; j++, i += 4) {
    const v = ((grey[j]! - lo) * 255) / range;
    grey[j] = v;
    px[i] = px[i + 1] = px[i + 2] = grey[j]!;
  }
  ctx.putImageData(image, 0, 0);

  const t = scaledSize(width, height, THUMB_SIDE);
  const thumbnail = document.createElement('canvas');
  thumbnail.width = t.width;
  thumbnail.height = t.height;
  thumbnail.getContext('2d')?.drawImage(canvas, 0, 0, t.width, t.height);
  return { canvas, width, height, grey, thumbnail };
}

/** Releases the big working canvas once the scan is done (old phones are short on memory). */
export function releaseImage(img: PreparedImage | null | undefined): void {
  if (!img) return;
  img.canvas.width = 0;
  img.canvas.height = 0;
}
