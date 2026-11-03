import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { Download, Printer, X } from "lucide-react";
import { useApp } from "../store";
import { ApiError } from "../api/client";
import { downloadPdf } from "../api/files";
import { byId } from "../domain/calc";
import type { Attachment, Extracted } from "../domain/types";
import { useDocImage } from "./useDocImage";
import { Button } from "../ui/kit";
import { TripSheet } from "./TripSheet";
import { Statement } from "./Statement";

export function DocumentOverlay() {
  const { data, overlay, setOverlay, toast } = useApp();
  const doc = overlay.document;
  const [downloading, setDownloading] = useState(false);
  // The same PDF the e-mails attach, laid out by the company's print layout.
  const pdf = doc?.kind === "trip-sheet" ? { path: `/trips/${doc.id}/sheet.pdf`, name: "Trip sheet.pdf" }
    : doc?.kind === "statement" ? { path: `/settlements/${doc.id}/statement.pdf`, name: "Driver statement.pdf" }
    : undefined;
  const download = async () => {
    if (!pdf) return;
    setDownloading(true);
    try {
      await downloadPdf(pdf.path, pdf.name);
    } catch (error) {
      toast(error instanceof ApiError ? error.message : "The PDF didn't download. Check the connection and try again.", "error");
    } finally {
      setDownloading(false);
    }
  };
  const close = () => setOverlay({ ...overlay, document: undefined });
  useEffect(() => {
    if (!doc) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  let shown: { file?: Attachment; tripId?: string; read?: Extracted; simulated?: boolean } | undefined;
  if (doc?.kind === "photo") {
    if (doc.id.startsWith("msg:")) {
      const m = data.messages.find((x) => x.id === doc.id.slice(4));
      const a = m?.attachment;
      const d = a ? data.docs.find((x) => x.file && (a.fileId ? x.file.fileId === a.fileId : x.file.name === a.name && x.file.sampleId === a.sampleId)) : undefined;
      shown = a ? { file: a, tripId: d?.tripId ?? a.sampleId?.split(":")[1], read: d?.read, simulated: d?.simulated ?? Boolean(a.sampleId) } : undefined;
    } else {
      shown = byId(data.docs, doc.id);
    }
  }
  const { src: photo } = useDocImage(shown);
  return createPortal(
    <AnimatePresence>
      {doc && (
        <motion.div className={`doc-layer ${doc.kind === "photo" ? "photo" : ""}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="doc-toolbar">
            {pdf && (
              <Button tone="primary" onClick={() => void download()} busy={downloading} disabled={downloading}>
                <Download /> Download PDF
              </Button>
            )}
            {doc.kind !== "photo" && (
              <Button onClick={() => window.print()}>
                <Printer /> Print
              </Button>
            )}
            <button className="doc-close" onClick={close}>
              <X size={20} />
              <span>Close</span>
            </button>
          </div>
          <div className="doc-scroll" onClick={(e) => e.target === e.currentTarget && close()}>
            <motion.div initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: "spring", stiffness: 260, damping: 28 }}>
              {doc.kind === "trip-sheet" && <TripSheet tripId={doc.id} />}
              {doc.kind === "statement" && <Statement id={doc.id} />}
              {doc.kind === "photo" && photo && (
                <figure className="photo-figure">
                  <img className="photo-full" src={photo} alt="Document" />
                  {shown?.simulated && <figcaption className="sim-tag">Simulated: a sample picture, not a real document</figcaption>}
                </figure>
              )}
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
