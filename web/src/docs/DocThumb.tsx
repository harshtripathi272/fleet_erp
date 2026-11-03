import { FileText } from "lucide-react";
import type { Attachment, Extracted } from "../domain/types";
import { useDocImage } from "./useDocImage";

/** A small picture of a document, or a PDF mark when it's a PDF. */
export function DocThumb({ doc, className }: { doc: { file?: Attachment; read?: Extracted; tripId?: string }; className?: string }) {
  const { src, pdf } = useDocImage(doc);
  if (pdf) return <span className={`${className ?? ""} doc-pdf`} title={doc.file?.name}><FileText size={18} /></span>;
  return src ? <img className={className} src={src} alt={doc.file?.name ?? ""} /> : <span className={`${className ?? ""} dapp-doc-blank`} />;
}
