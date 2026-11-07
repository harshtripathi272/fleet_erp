import { AlignLeft, AtSign, Calendar, File, FileText, Hash, Image, Link2, List, ListChecks, Phone, ToggleLeft, Type, type LucideIcon } from "lucide-react";

/**
 * The kinds of field a company can add, in the words people choose them by (#97). The field editor shows them as
 * pictures; the guided set-up (#96) lists them the same way. The API's list is FIELD_TYPES in
 * src/core/masters/dynamicFields.ts: a type added there is added here, with its options.
 */
export interface FieldType {
  value: string;
  label: string;
  /** What it holds, as an example a person recognises. */
  holds: string;
  icon: LucideIcon;
  /** The settings that belong to this type, beyond name, help text and required. */
  options: Array<"maxLength" | "pattern" | "min" | "max" | "choices" | "referenceMaster" | "maxSizeMb" | "maxFiles" | "accept" | "withExpiry">;
}

export const FIELD_TYPES: FieldType[] = [
  { value: "text", label: "Text", holds: "A short line: a badge number, a union name", icon: Type, options: ["maxLength", "pattern"] },
  { value: "long_text", label: "Long text", holds: "Sentences: notes, an address, instructions", icon: AlignLeft, options: ["maxLength"] },
  { value: "number", label: "Number", holds: "A count or a measure: seats, axle load", icon: Hash, options: ["min", "max"] },
  { value: "date", label: "Date", holds: "A day: a test date, an expiry", icon: Calendar, options: [] },
  { value: "boolean", label: "Yes or no", holds: "Something that is or isn't: has a fridge", icon: ToggleLeft, options: [] },
  { value: "select", label: "One choice", holds: "One of a list you give: a shirt size", icon: List, options: ["choices"] },
  { value: "multi_select", label: "Several choices", holds: "Any of a list you give: languages spoken", icon: ListChecks, options: ["choices"] },
  { value: "email", label: "E-mail", holds: "An e-mail address", icon: AtSign, options: [] },
  { value: "phone", label: "Phone", holds: "A phone number with its country code", icon: Phone, options: [] },
  { value: "reference", label: "A link", holds: "A record of another master: a truck, a customer", icon: Link2, options: ["referenceMaster"] },
  { value: "image", label: "Picture", holds: "One photo: a driver's photo, a truck's side", icon: Image, options: ["maxSizeMb"] },
  { value: "document", label: "Document", holds: "One PDF or photo, with its expiry date if it has one", icon: FileText, options: ["withExpiry", "accept", "maxSizeMb"] },
  { value: "files", label: "Several files", holds: "A few photos or PDFs together: inspection photos", icon: File, options: ["maxFiles", "accept", "maxSizeMb"] },
];

/** The kinds most fields are; the rest wait behind "More kinds". */
export const COMMON_FIELD_TYPES = ["text", "number", "date", "select", "boolean", "document", "image"];

/**
 * The likely kind from a field's name, so most fields need only their name. "Number" says nothing: a card number is
 * text. Only clear words count; anything else stays as it is, and the person's own pick always wins.
 */
export function guessFieldType(label: string): { type: string; withExpiry?: boolean } | undefined {
  const name = label.toLowerCase();
  if (!name.trim()) return undefined;
  if (/\b(date|expiry|expires|dob|birthday|valid (until|from)|issued on)\b/.test(name)) return { type: "date" };
  if (/\b(number|no|id|code|class|type|name)\b/.test(name)) return { type: "text" };
  if (/\b(photos|pictures|images|attachments|files)\b/.test(name)) return { type: "files" };
  if (/\b(photo|picture|image|selfie)\b/.test(name)) return { type: "image" };
  if (/\b(certificate|licen[cs]e|permit|passport|insurance|visa)\b/.test(name)) return { type: "document", withExpiry: true };
  if (/\b(contract|document|pdf|scan|agreement)\b/.test(name)) return { type: "document" };
  if (/\b(phone|mobile|cell|whatsapp)\b/.test(name)) return { type: "phone" };
  if (/\be-?mail\b/.test(name)) return { type: "email" };
  if (/^(is|has|can|needs|does)\b/.test(name)) return { type: "boolean" };
  if (/\b(count|quantity|qty|weight|litres|liters|km|years|age|capacity|amount|seats)\b/.test(name)) return { type: "number" };
  if (/\b(notes?|remarks?|comments?|description|address)\b/.test(name)) return { type: "long_text" };
  return { type: "text" };
}

export const fieldType = (value: unknown) => FIELD_TYPES.find((t) => t.value === value);
export const FILE_TYPES = new Set(["image", "document", "files"]);
export const isFileType = (value: unknown) => FILE_TYPES.has(String(value));

/** Kinds of file a document or files field can take. The API checks the bytes; these say what to offer. */
export const FILE_KINDS = [
  { value: "images", label: "Pictures", many: "pictures", mimes: ["image/jpeg", "image/png", "image/webp", "image/heic"], accept: "image/jpeg,image/png,image/webp,image/heic" },
  { value: "pdf", label: "PDFs", many: "PDFs", mimes: ["application/pdf"], accept: "application/pdf" },
  { value: "word", label: "Word", many: "Word files", mimes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/msword"], accept: ".docx,.doc" },
  { value: "excel", label: "Excel", many: "Excel files", mimes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel"], accept: ".xlsx,.xls" },
] as const;
export type FileKind = (typeof FILE_KINDS)[number]["value"];

/** What a file field takes: pictures only for a picture field, otherwise the company's choice (pictures and PDFs). */
export const kindsOf = (field: { type?: unknown; accept?: unknown }): FileKind[] =>
  field.type === "image" ? ["images"] : Array.isArray(field.accept) && field.accept.length ? (field.accept as FileKind[]) : ["images", "pdf"];
/** "PDFs and pictures". */
export function kindsInWords(kinds: FileKind[]) {
  const names = [...kinds].sort((a, b) => (a === "pdf" ? -1 : b === "pdf" ? 1 : 0)).map((k) => FILE_KINDS.find((f) => f.value === k)!.many);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "files";
}
const ONE: Record<FileKind, string> = { images: "a picture", pdf: "a PDF", word: "a Word file", excel: "an Excel file" };
/** The kind a picked file is, from what the browser says about it (the API checks the bytes again). */
export function kindOfFile(file: { type: string; name: string }): FileKind | undefined {
  const byMime = FILE_KINDS.find((k) => (k.mimes as readonly string[]).includes(file.type))?.value;
  if (byMime) return byMime;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return ({ jpg: "images", jpeg: "images", png: "images", webp: "images", heic: "images", pdf: "pdf", doc: "word", docx: "word", xls: "excel", xlsx: "excel" } as Record<string, FileKind>)[ext];
}
/** "That's a Word file; this field takes PDFs and pictures." */
export const refusal = (kind: FileKind | undefined, kinds: FileKind[]) => `${kind ? `That's ${ONE[kind]}` : "That kind of file isn't accepted"}; this field takes ${kindsInWords(kinds)}.`;
export const sizeText = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`);
