import { isPdf, useFileUrl } from "../api/files";
import type { Attachment, Extracted } from "../domain/types";
import { docImage } from "../phone/samples";
import { useApp } from "../store";

/**
 * What to show for a document: an uploaded file (fetched with the session), or the simulated phone's
 * sample picture. `pdf` files can't sit in an <img>; they open in a new tab instead.
 */
export function useDocImage(doc?: { file?: Attachment; read?: Extracted; tripId?: string }) {
  // The driver app has no desk data; there only uploaded files (and no sample pictures) are shown.
  const data = useApp()?.data;
  const uploaded = useFileUrl(doc?.file?.fileId);
  if (!doc?.file) return { src: undefined, pdf: false, sample: false };
  if (doc.file.fileId) return { src: uploaded, pdf: isPdf(doc.file.mime), sample: false };
  return { src: data ? docImage(data, doc) : undefined, pdf: false, sample: Boolean(doc.file.sampleId) };
}
