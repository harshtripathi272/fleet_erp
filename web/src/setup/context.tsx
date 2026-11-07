import { createContext, useContext, useRef, useState, type DragEvent, type ReactNode } from "react";
import { FileUp } from "lucide-react";
import type { Rec } from "../api/adapter";
import type { Me } from "../api/session";
import { Button } from "../ui/kit";

/** What every step of "Set up a company" shares: the company file being written, its files, and what is wrong so far. */

export interface Attachment { path: string; data: string }
export interface Problem { path: string; message: string }
export interface TargetField { advanced?: boolean; key: string; label: string; hint?: string; type: "text" | "number" | "choice"; required?: boolean; placeholder?: string; choices?: { value: string; label: string }[]; default?: string | number; min?: number; max?: number }
export interface Target { key: string; label: string; tested: boolean; state?: "tested" | "dry-run" | "script"; needs?: string[]; steps?: string[]; fields?: TargetField[] }
export interface MasterOption { key: string; label: string; group?: string; needs?: string[] }
export interface KitInfo {
  file: Rec;
  attachments: Attachment[];
  targets: Target[];
  masters: MasterOption[];
  lastApplied: { at: string; company: string; purpose?: string; results: { step: string; outcome: string; detail?: string }[] } | null;
  packages: boolean;
  canClear: boolean;
}
export type Finish = "here" | "package";

export interface SetUpContext {
  file: Rec;
  /** Changes one value by its path; empty values are removed, so the company follows the default. */
  set: (path: string, value: unknown) => void;
  replace: (next: Rec) => void;
  info: KitInfo;
  me: Me;
  attachments: Attachment[];
  putFile: (path: string, file: Blob) => Promise<void>;
  removeFile: (path: string) => void;
  /** The problem at a path, once its step has been left, or when Review asks for all of them. */
  err: (path: string) => string | undefined;
  problems: Problem[];
  finish: Finish;
  setFinish: (f: Finish) => void;
  go: (step: string) => void;
}

const Ctx = createContext<SetUpContext | null>(null);
export const SetUpProvider = Ctx.Provider;
export const useSetUp = () => {
  const value = useContext(Ctx);
  if (!value) throw new Error("A set-up step is outside the set-up");
  return value;
};

/** The same change as ctx.set, for building the next file. */
export function withValue(file: Rec, path: string, value: unknown): Rec {
  const next = structuredClone(file) as Rec;
  const keys = path.split(".");
  let at = next;
  for (const k of keys.slice(0, -1)) at = (at[k] ??= {});
  if (value === "" || value === undefined || value === null) delete at[keys.at(-1)!];
  else at[keys.at(-1)!] = value;
  return next;
}

export const toBase64 = async (file: Blob) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

export const saveBlob = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

/** A place to drop or choose a file. What was chosen, and how to change it, are passed in once there is one. */
export function FileDrop({ accept, label, hint, chosen, onFile, onRemove }: { accept: string; label: string; hint?: ReactNode; chosen?: ReactNode; onFile: (file: File) => void; onRemove?: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  };
  return (
    <div className={`su-drop ${over ? "over" : ""} ${chosen ? "has" : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}>
      <input ref={input} type="file" accept={accept} hidden aria-label={label} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
      {chosen ? (
        <>
          <div className="su-drop-chosen">{chosen}</div>
          <span className="su-drop-actions">
            <Button size="sm" onClick={() => input.current?.click()}>Replace</Button>
            {onRemove && <Button size="sm" tone="quiet" onClick={onRemove}>Remove</Button>}
          </span>
        </>
      ) : (
        <button type="button" className="su-drop-empty" onClick={() => input.current?.click()}>
          <FileUp size={18} aria-hidden />
          <span><strong>{label}</strong>{hint && <small>{hint}</small>}</span>
        </button>
      )}
    </div>
  );
}
