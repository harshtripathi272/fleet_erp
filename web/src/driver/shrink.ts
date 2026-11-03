/**
 * Phone photos are often 4000 px and 4 MB; an invoice reads fine at 1600 px. Shrinking on the phone saves
 * the driver's data and makes an upload on a weak signal likelier to finish.
 */
const LONG_SIDE = 1600;
const QUALITY = 0.85;
/** Smaller photos are sent as they are. */
const SMALL_ENOUGH = 600 * 1024;

export interface Shrunk {
  blob: Blob;
  name: string;
}

/** A JPEG at most 1600 px on its long side. PDFs, and photos the browser can't read (HEIC outside Safari), go as they are. */
export async function shrinkPhoto(file: File): Promise<Shrunk> {
  const as = { blob: file as Blob, name: file.name };
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(file.type)) return as;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return as;
  }
  try {
    const scale = Math.min(1, LONG_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= SMALL_ENOUGH) return as;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d");
    if (!context) return as;
    // White under any transparency (a PNG screenshot), since JPEG has none.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", QUALITY));
    if (!blob || blob.size >= file.size) return as;
    return { blob, name: file.name.replace(/\.[^.]+$/, "") + ".jpg" };
  } finally {
    bitmap.close();
  }
}
