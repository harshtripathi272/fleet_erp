import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, File as FileIcon, FileText, Image as ImageIcon, RefreshCw, Upload, X } from "lucide-react";
import { ApiError, authorizedFetch, sendWithProgress } from "../api/client";
import { FILE_KINDS, kindOfFile, kindsInWords, kindsOf, refusal, sizeText } from "./fieldTypes";
import { Status } from "../ui/kit";
import { fullDate } from "../ui/format";

/**
 * The upload control for a company's file field (#97), the same on every form, desk and the phone: drag or choose,
 * the progress while it goes, a picture's preview, a document's name and size with Open and Replace, and a plain
 * refusal for the wrong kind or size before anything is sent. The value is what the API keeps on the record:
 * `{ fileId, name, mime, size }` (with `expiresOn` for a document that expires), or a list of them.
 */

export interface FileValue { fileId: string; name: string; mime: string; size: number; expiresOn?: string }
export interface FileFieldSpec { key: string; label?: string; type: string; accept?: unknown; maxSizeMb?: number; maxFiles?: number; withExpiry?: boolean }
/** Where the field is: a master's or record's company field (`entity`), or a custom master's (`master`, its id). */
export interface FileTarget { entity?: string; master?: string }

const isImage = (mime?: string) => Boolean(mime?.startsWith("image/"));

/** The API reminds this many days before a document expires (EXPIRY_WARNING_DAYS in expiryReminders.ts). */
const WARNING_DAYS = 30;
/** Whether a document with an expiry date is still good, due soon or expired, and how many days are left. */
export function expiryOf(expiresOn?: string, now = new Date()) {
  if (!expiresOn) return null;
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((Date.parse(`${expiresOn.slice(0, 10)}T00:00:00Z`) - today) / 86_400_000);
  return { days, state: days < 0 ? "expired" as const : days <= WARNING_DAYS ? "due" as const : "valid" as const };
}
/** "Expired 2 days ago", "Expires today", "Expires in 12 days": shown only once it matters. */
export function ExpiryBadge({ expiresOn }: { expiresOn?: string }) {
  const e = expiryOf(expiresOn);
  if (!e || e.state === "valid") return null;
  const text = e.state === "expired" ? `Expired ${e.days === -1 ? "yesterday" : `${-e.days} days ago`}` : e.days === 0 ? "Expires today" : `Expires in ${e.days} day${e.days === 1 ? "" : "s"}`;
  return <span title={`Expiry date ${fullDate(expiresOn!)}`}><Status tone={e.state === "expired" ? "bad" : "wait"}>{text}</Status></span>;
}
const shownInline = (mime?: string) => isImage(mime) || mime === "application/pdf";

/** A local address for a stored file, fetched with the session once it is on screen (an <img> can't send the token). */
export function useFileUrl(fileId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["file", fileId],
    queryFn: async () => URL.createObjectURL(await (await authorizedFetch(`/files/${fileId}`)).blob()),
    enabled: Boolean(fileId) && enabled,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: false,
  }).data;
}

/** True once the element has come near the screen: a long list fetches only the pictures someone scrolls to. */
function useNearScreen<T extends Element>() {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near || !ref.current) return;
    if (typeof IntersectionObserver === "undefined") { setNear(true); return; }
    const watch = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) setNear(true); }, { rootMargin: "200px" });
    watch.observe(ref.current);
    return () => watch.disconnect();
  }, [near]);
  return [ref, near] as const;
}

/** Opens a stored file in a new tab (a picture or PDF) or saves it (Word, Excel), with the session. */
export async function openFile(file: FileValue) {
  const res = await authorizedFetch(`/files/${file.fileId}${shownInline(file.mime) ? "" : "?download=1"}`);
  const url = URL.createObjectURL(await res.blob());
  if (shownInline(file.mime)) window.open(url, "_blank", "noopener");
  else Object.assign(document.createElement("a"), { href: url, download: file.name }).click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** A file in a list or a history: a small picture loaded when it is on screen, or the file's icon, with its name. */
export function FileChip({ value, thumbnail }: { value: FileValue | FileValue[]; thumbnail?: boolean }) {
  const list = Array.isArray(value) ? value : [value];
  const first = list[0];
  const [ref, near] = useNearScreen<HTMLSpanElement>();
  const url = useFileUrl(thumbnail && isImage(first?.mime) ? first?.fileId : undefined, near);
  if (!first) return <span className="muted">—</span>;
  return (
    <span ref={ref} className="file-chip" title={list.map((f) => f.name).join(", ")}>
      {thumbnail && isImage(first.mime)
        ? (url ? <img src={url} alt="" loading="lazy" width={28} height={28} /> : <span className="file-thumb-wait" aria-hidden />)
        : isImage(first.mime) ? <ImageIcon size={15} aria-hidden /> : <FileText size={15} aria-hidden />}
      <span className="file-chip-name">{list.length > 1 ? `${first.name} and ${list.length - 1} more` : first.name}</span>
      {!Array.isArray(value) && <ExpiryBadge expiresOn={value.expiresOn} />}
    </span>
  );
}

function Preview({ file }: { file: FileValue }) {
  const url = useFileUrl(isImage(file.mime) ? file.fileId : undefined);
  if (isImage(file.mime)) return url ? <img className="file-preview" src={url} alt={file.name} /> : <span className="file-preview file-preview-wait" aria-hidden />;
  return <span className="file-preview file-preview-icon" aria-hidden>{file.mime === "application/pdf" ? <FileText size={22} /> : <FileIcon size={22} />}</span>;
}

/** One stored file: its preview, name and size, and what can be done with it. */
function StoredRow({ file, disabled, onReplace, onRemove, expiry }: { file: FileValue; disabled?: boolean; onReplace?: () => void; onRemove: () => void; expiry?: ReactNode }) {
  return (
    <div className="file-row">
      <Preview file={file} />
      <div className="file-row-text">
        <strong>{file.name}</strong>
        <span className="muted small">{FILE_KINDS.find((k) => (k.mimes as readonly string[]).includes(file.mime))?.label.replace(/s$/, "") ?? "File"} · {sizeText(file.size)}</span>
        {expiry}
      </div>
      <div className="file-row-actions">
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => void openFile(file)}><ExternalLink size={14} /> Open</button>
        {!disabled && onReplace && <button type="button" className="btn btn-quiet btn-sm" onClick={onReplace}><RefreshCw size={14} /> Replace</button>}
        {!disabled && <button type="button" className="icon-btn" aria-label={`Remove ${file.name}`} onClick={onRemove}><X size={15} /></button>}
      </div>
    </div>
  );
}

/** `preview`: drawn as the form will show it, in the field editor, without uploading anything. */
export function FileField({ field, target, value, onChange, disabled, id, preview }: { field: FileFieldSpec; target: FileTarget; value: unknown; onChange: (next: unknown) => void; disabled?: boolean; id?: string; preview?: boolean }) {
  const many = field.type === "files";
  const files = (Array.isArray(value) ? value : value ? [value] : []) as FileValue[];
  const kinds = kindsOf(field);
  const maxMb = field.maxSizeMb ?? 15;
  const maxFiles = many ? field.maxFiles ?? 10 : 1;
  const input = useRef<HTMLInputElement>(null);
  const [going, setGoing] = useState<{ name: string; share: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const replacing = useRef<number | null>(null);
  const accept = kinds.map((k) => FILE_KINDS.find((f) => f.value === k)!.accept).join(",");

  const send = async (picked: File[]) => {
    setProblem(null);
    const room = many ? maxFiles - files.length + (replacing.current !== null ? 1 : 0) : 1;
    if (many && picked.length > room) { setProblem(room > 0 ? `This field holds ${maxFiles} files; ${room === 1 ? "one more fits" : `${room} more fit`}.` : `This field already holds ${maxFiles} files. Remove one first.`); return; }
    for (const file of picked) {
      const kind = kindOfFile(file);
      if (!kind || !kinds.includes(kind)) { setProblem(refusal(kind, kinds)); return; }
      if (file.size > maxMb * 1048576) { setProblem(`${file.name} is ${sizeText(file.size)}; this field takes files up to ${maxMb} MB.`); return; }
    }
    let next = [...files];
    for (const file of picked) {
      setGoing({ name: file.name, share: 0 });
      try {
        const stored = await sendWithProgress<{ id: string; name: string; mime: string; size: number }>(
          "/files", { ...target, field: field.key }, file,
          { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name), "Idempotency-Key": crypto.randomUUID() },
          (share) => setGoing({ name: file.name, share }),
        );
        const entry: FileValue = { fileId: stored.id, name: stored.name, mime: stored.mime, size: stored.size };
        if (replacing.current !== null) {
          const at = replacing.current;
          next = next.map((f, i) => (i === at ? { ...entry, ...(f.expiresOn ? { expiresOn: f.expiresOn } : {}) } : f));
          replacing.current = null;
        } else next = many ? [...next, entry] : [entry];
      } catch (e) {
        setProblem(e instanceof ApiError ? e.message : "The upload didn't go through. Try again.");
        break;
      } finally {
        setGoing(null);
      }
    }
    onChange(many ? (next.length ? next : undefined) : next[0]);
  };
  const choose = (replaceAt: number | null = null) => { if (preview) return; replacing.current = replaceAt; input.current?.click(); };
  const remove = (i: number) => { const next = files.filter((_, j) => j !== i); onChange(many ? (next.length ? next : undefined) : undefined); };
  const setExpiry = (i: number, day: string) => onChange({ ...files[i]!, expiresOn: day || undefined });
  const full = files.length >= maxFiles;
  const takes = `${kindsInWords(kinds).replace(/^./, (c) => c.toUpperCase())}, up to ${maxMb} MB${many ? ` each, ${maxFiles} at most` : ""}`;

  return (
    <div className="file-field">
      <input ref={input} id={id} type="file" hidden accept={accept} multiple={many && replacing.current === null}
        onChange={(e) => { const list = [...(e.target.files ?? [])]; e.target.value = ""; if (list.length) void send(list); }} />
      {files.map((f, i) => (
        <StoredRow key={f.fileId} file={f} disabled={disabled} onReplace={() => choose(i)} onRemove={() => remove(i)}
          expiry={field.withExpiry && !many ? (
            <span className="file-expiry">
              <label>Expires on <input type="date" disabled={disabled} value={f.expiresOn ?? ""} onChange={(e) => setExpiry(i, e.target.value)} /></label>
              <ExpiryBadge expiresOn={f.expiresOn} />
            </span>
          ) : undefined} />
      ))}
      {going && (
        <div className="file-row file-going" aria-live="polite">
          <span className="file-preview file-preview-icon" aria-hidden><Upload size={20} /></span>
          <div className="file-row-text">
            <strong>{going.name}</strong>
            <span className="file-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(going.share * 100)}><span style={{ width: `${Math.round(going.share * 100)}%` }} /></span>
          </div>
        </div>
      )}
      {!disabled && !full && !going && (
        <button type="button" className={`file-drop${over ? " over" : ""}`} onClick={() => choose()}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); if (preview) return; const list = [...e.dataTransfer.files]; if (list.length) void send(many ? list : list.slice(0, 1)); }}>
          <Upload size={16} aria-hidden />
          <span><b>{files.length ? "Add another" : many ? "Drop files here" : "Drop a file here"}</b> or choose {many ? "them" : "one"}</span>
          <span className="muted small">{takes}</span>
        </button>
      )}
      {disabled && !files.length && <span className="muted">None</span>}
      {problem && <p className="file-problem" role="alert">{problem}</p>}
    </div>
  );
}
