import { useEffect } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { Printer, X } from "lucide-react";
import { useApp } from "../store";
import { byId } from "../domain/calc";
import { docImage } from "../phone/samples";
import { Button } from "../ui/kit";
import { TripSheet } from "./TripSheet";
import { Statement } from "./Statement";

export function DocumentOverlay() {
  const { data, overlay, setOverlay } = useApp();
  const doc = overlay.document;
  const close = () => setOverlay({ ...overlay, document: undefined });
  useEffect(() => {
    if (!doc) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  let photo: string | undefined;
  if (doc?.kind === "photo") {
    if (doc.id.startsWith("msg:")) {
      const m = data.messages.find((x) => x.id === doc.id.slice(4));
      const d = data.docs.find((x) => x.file && m?.attachment && x.file.name === m.attachment.name && x.file.sampleId === m.attachment.sampleId);
      photo = m?.attachment ? docImage(data, { file: m.attachment, tripId: d?.tripId ?? m.attachment.sampleId?.split(":")[1], read: d?.read }) : undefined;
    } else {
      const d = byId(data.docs, doc.id);
      photo = d ? docImage(data, d) : undefined;
    }
  }
  return createPortal(
    <AnimatePresence>
      {doc && (
        <motion.div className={`doc-layer ${doc.kind === "photo" ? "photo" : ""}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="doc-toolbar">
            {doc.kind !== "photo" && (
              <Button tone="primary" onClick={() => window.print()}>
                <Printer /> Print or save as PDF
              </Button>
            )}
            <button className="doc-close" onClick={close} aria-label="Close">
              <X size={20} />
            </button>
          </div>
          <div className="doc-scroll" onClick={(e) => e.target === e.currentTarget && close()}>
            <motion.div initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: "spring", stiffness: 260, damping: 28 }}>
              {doc.kind === "trip-sheet" && <TripSheet tripId={doc.id} />}
              {doc.kind === "statement" && <Statement id={doc.id} />}
              {doc.kind === "photo" && photo && <img className="photo-full" src={photo} alt="Document" />}
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
