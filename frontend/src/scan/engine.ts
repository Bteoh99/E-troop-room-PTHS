/**
 * Everything heavy the Scan screen needs (image prep, barcode reader, OCR). Imported only by the
 * lazily-loaded ScanPage, so none of it is in the main bundle. Tests mock this module.
 */
export { prepareImage, type PreparedImage } from './imagePrep';
export { findBarcode } from './barcode';
export { readText, type OcrProgress } from './ocr';
