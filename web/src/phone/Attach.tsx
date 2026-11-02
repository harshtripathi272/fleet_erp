import { useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, ImagePlus, SendHorizontal, X } from "lucide-react";
import { useApp } from "../store";
import { byId } from "../domain/calc";
import { activeTrip } from "../domain/helpers";
import type { Attachment, DocKind } from "../domain/types";
import { galleryFor } from "./samples";
import type { Sample } from "./samples";

const KIND_LABEL: Record<DocKind, string> = {
  loading: "Loading invoice",
  delivery: "Delivery note",
  expense: "Receipt",
  fuel: "Fuel slip",
  other: "Other",
};

export async function readFile(file: File): Promise<Attachment> {
  if (!file.type.startsWith("image/")) throw new Error("Send a photo in this demo.");
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, 1100 / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return { name: file.name, mime: "image/jpeg", dataUrl: canvas.toDataURL("image/jpeg", 0.72) };
}

/** Gallery and camera sheet inside the phone. Sample documents make the demo work without files. */
export function AttachSheet({
  open,
  kind,
  driverId,
  tripId,
  channel = "WhatsApp",
  onClose,
  onSent,
}: {
  open: boolean;
  kind?: DocKind;
  driverId: string;
  tripId?: string;
  channel?: "WhatsApp" | "App";
  onClose: () => void;
  onSent: () => void;
}) {
  const { data, run, toast } = useApp();
  const trip =
    byId(data.trips, tripId) ?? data.trips.filter((t) => t.driverId === driverId && activeTrip(t)).at(-1) ?? data.trips.filter((t) => t.driverId === driverId && !t.settlementId).at(-1);
  const gallery = useMemo(() => galleryFor(data, trip), [data, trip]);
  const sorted = kind ? [...gallery.filter((g) => g.kind === kind), ...gallery.filter((g) => g.kind !== kind)] : gallery;
  const [picked, setPicked] = useState<{ sample?: Sample; upload?: Attachment } | null>(null);
  const [chosenKind, setChosenKind] = useState<DocKind>(kind ?? "expense");
  const [caption, setCaption] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const close = () => {
    setPicked(null);
    setCaption("");
    onClose();
  };
  const choose = (sample: Sample) => {
    setPicked({ sample });
    setChosenKind(sample.kind);
  };
  const send = async () => {
    if (!picked) return;
    const sampleKind = picked.sample?.kind ?? chosenKind;
    const ok = await run(
      {
        type: "doc.send",
        driverId,
        tripId: trip?.id,
        kind: sampleKind,
        channel,
        note: caption.trim() || undefined,
        file: picked.sample ? { name: `IMG_${String(Date.now()).slice(-4)}.jpg`, mime: "image/jpeg", sampleId: picked.sample.sampleId } : picked.upload,
        read: picked.sample?.read,
      },
      channel === "App" ? "Sent to the office." : undefined,
    );
    if (ok) {
      setPicked(null);
      setCaption("");
      onSent();
    }
  };
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="attach" initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }} transition={{ type: "spring", stiffness: 380, damping: 38 }}>
          {!picked ? (
            <>
              <header className="attach-head">
                <button className="wa-back" onClick={close} aria-label="Close">
                  <X size={20} />
                </button>
                <strong>Recents</strong>
                <span />
              </header>
              <div className="gallery">
                <button className="gallery-cell upload" onClick={() => input.current?.click()}>
                  <ImagePlus size={24} />
                  <span>From this computer</span>
                </button>
                {sorted.map((g) => (
                  <button key={g.sampleId} className={`gallery-cell ${kind && g.kind === kind ? "suggested" : ""}`} onClick={() => choose(g)}>
                    <img src={g.image} alt={g.title} loading="lazy" />
                    <span className="gallery-label">{g.title}</span>
                  </button>
                ))}
              </div>
              <input
                ref={input}
                type="file"
                accept="image/*"
                hidden
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  try {
                    setPicked({ upload: await readFile(file) });
                    setChosenKind(kind ?? "expense");
                  } catch (error) {
                    toast(error instanceof Error ? error.message : "Couldn't read the photo.", "error");
                  }
                }}
              />
            </>
          ) : (
            <div className="preview">
              <header className="attach-head dark">
                <button className="wa-back" onClick={() => setPicked(null)} aria-label="Back">
                  <ArrowLeft size={20} />
                </button>
                <strong>{picked.sample?.title ?? "Photo"}</strong>
                <span />
              </header>
              <div className="preview-image">
                <img src={picked.sample?.image ?? picked.upload?.dataUrl} alt="" />
                <span className="scan-line" aria-hidden />
              </div>
              {!picked.sample && (
                <div className="preview-kinds">
                  {(["loading", "delivery", "expense", "other"] as DocKind[]).map((k) => (
                    <button key={k} className={chosenKind === k ? "on" : ""} onClick={() => setChosenKind(k)}>
                      {KIND_LABEL[k]}
                    </button>
                  ))}
                </div>
              )}
              <footer className="preview-send">
                <input value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Add a caption" aria-label="Caption" />
                <button className="wa-send" onClick={send} aria-label="Send">
                  <SendHorizontal size={19} />
                </button>
              </footer>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
