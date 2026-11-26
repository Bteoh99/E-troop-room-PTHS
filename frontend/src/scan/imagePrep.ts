/** Longest side of the image we work on. Big phone photos (12+ MP) are far too slow for OCR on old phones. */
export const MAX_SIDE = 1600;

export interface PreparedImage {
  /** Greyscale, contrast-stretched, at most MAX_SIDE px on the longest side. */
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  /** One luminance byte per pixel (for the barcode reader). */
  grey: Uint8ClampedArray;
}

async function decode(file: Blob): Promise<CanvasImageSource & { width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    try {
      // Respect the phone's EXIF rotation.
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* fall back to <img> */
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

export function scaledSize(width: number, height: number, maxSide = MAX_SIDE): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Downscale + greyscale + stretch contrast (helps OCR on dim store-room photos). */
export async function prepareImage(file: Blob): Promise<PreparedImage> {
  const source = await decode(file);
  const { width, height } = scaledSize(source.width, source.height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('This browser cannot process photos.');
  ctx.drawImage(source, 0, 0, width, height);
  if ('close' in source && typeof source.close === 'function') source.close();

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
  return { canvas, width, height, grey };
}
