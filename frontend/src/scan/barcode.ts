import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from '@zxing/library';
import type { PreparedImage } from './imagePrep';

interface NativeDetector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
type NativeDetectorCtor = new (opts?: { formats?: string[] }) => NativeDetector;

const NATIVE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'];

/** Barcode value as the API expects it: letters/digits only. */
export function cleanBarcode(raw: string): string | null {
  const v = raw.replace(/[^A-Za-z0-9]/g, '');
  return v.length > 0 && v.length <= 64 ? v : null;
}

async function tryNative(img: PreparedImage): Promise<string | null> {
  const Ctor = (globalThis as { BarcodeDetector?: NativeDetectorCtor }).BarcodeDetector;
  if (!Ctor) return null;
  try {
    const found = await new Ctor({ formats: NATIVE_FORMATS }).detect(img.canvas);
    for (const f of found) {
      const v = cleanBarcode(f.rawValue);
      if (v) return v;
    }
  } catch {
    /* unsupported format list etc. — fall back to zxing */
  }
  return null;
}

function tryZxing(img: PreparedImage): string | null {
  const hints = new Map<DecodeHintType, unknown>();
  hints.set(DecodeHintType.TRY_HARDER, true);
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.EAN_13,
    BarcodeFormat.EAN_8,
    BarcodeFormat.UPC_A,
    BarcodeFormat.UPC_E,
    BarcodeFormat.CODE_128,
    BarcodeFormat.CODE_39,
    BarcodeFormat.ITF,
    BarcodeFormat.QR_CODE,
  ]);
  const reader = new MultiFormatReader();
  reader.setHints(hints);
  try {
    const source = new RGBLuminanceSource(img.grey, img.width, img.height);
    const result = reader.decode(new BinaryBitmap(new HybridBinarizer(source)));
    return cleanBarcode(result.getText());
  } catch {
    return null; // NotFoundException etc.
  }
}

/** Finds a shop barcode in the photo: the phone's built-in detector if it has one, else zxing (bundled). */
export async function findBarcode(img: PreparedImage): Promise<string | null> {
  return (await tryNative(img)) ?? tryZxing(img);
}
