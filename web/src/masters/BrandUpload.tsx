import { useState } from "react";
import { Upload, X } from "lucide-react";
import { uploadFile, useFileUrl } from "../api/files";
import { useApp } from "../store";
import { Button } from "../ui/kit";

/**
 * One of the brand's images (#71): the logo, the logo for dark backgrounds or the icon. A logo is also saved as a
 * JPEG on white, which is what printed documents embed; the browser makes it, so the server needs no image library.
 */
export function BrandUpload({ fileId, onChange, onPdfCopy, dark, square, label, disabled }: {
  fileId: string;
  onChange: (id: string) => void;
  /** For the main logo: the id of its JPEG copy for documents. */
  onPdfCopy?: (id: string) => void;
  dark?: boolean;
  square?: boolean;
  label: string;
  disabled?: boolean;
}) {
  const { toast } = useApp();
  const url = useFileUrl(fileId || undefined);
  const [busy, setBusy] = useState(false);
  const choose = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const stored = await uploadFile(file, undefined, file.name);
      onChange(stored.id);
      if (onPdfCopy) {
        const jpeg = await asJpegOnWhite(file);
        if (jpeg) onPdfCopy((await uploadFile(jpeg, undefined, "logo-for-documents.jpg")).id);
      }
    } catch (e) {
      toast((e as Error).message || "The image couldn't be uploaded.", "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="brand-upload">
      <span className={`brand-preview${dark ? " dark" : ""}${square ? " square" : ""}`}>
        {url ? <img src={url} alt={label} /> : <span className="muted">None</span>}
      </span>
      {!disabled && (
        <span className="row-actions">
          <label className={`btn btn-secondary btn-sm${busy ? " is-busy" : ""}`}>
            <input type="file" accept="image/png,image/jpeg,image/webp" hidden disabled={busy} onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ""; }} />
            <Upload size={14} /> {fileId ? "Replace" : "Upload"}
          </label>
          {fileId && <Button size="sm" tone="quiet" onClick={() => { onChange(""); onPdfCopy?.(""); }}><X size={14} /> Remove</Button>}
        </span>
      )}
    </div>
  );
}

/** The image drawn on white and saved as a JPEG, at most 600 pixels wide: what PDFs embed. */
async function asJpegOnWhite(file: File): Promise<Blob | null> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return null;
  const scale = Math.min(1, 600 / bitmap.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92));
}
