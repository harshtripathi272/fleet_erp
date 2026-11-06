import { AlignLeft, AtSign, Binary, Calendar, CheckSquare, Link2, ListChecks, ListOrdered, Phone, ToggleLeft, Type, type LucideIcon } from "lucide-react";

/**
 * The kinds of field a company can add, in words. One list for every place fields are made (the set-up's Masters
 * step, Customise, custom masters), so a new type added here shows up in all of them. `type` is what the server
 * calls it, in FIELD_TYPES (src/core/masters/dynamicFields.ts).
 */
export interface FieldTypeInfo {
  type: string;
  label: string;
  text: string;
  icon: LucideIcon;
  /** What else this type asks for. */
  takes?: ("choices" | "length" | "range" | "master" | "pattern")[];
}

export const FIELD_TYPE_INFO: FieldTypeInfo[] = [
  { type: "text", label: "Text", text: "A name, a number with letters, a short note.", icon: Type, takes: ["length", "pattern"] },
  { type: "long_text", label: "Long text", text: "Several lines of notes.", icon: AlignLeft, takes: ["length"] },
  { type: "number", label: "Number", text: "A quantity or measure.", icon: Binary, takes: ["range"] },
  { type: "date", label: "Date", text: "An expiry or a start date.", icon: Calendar },
  { type: "boolean", label: "Yes or no", text: "Something that's true or not.", icon: ToggleLeft },
  { type: "select", label: "One choice", text: "One pick from your list.", icon: ListOrdered, takes: ["choices"] },
  { type: "multi_select", label: "Several choices", text: "Any number from your list.", icon: ListChecks, takes: ["choices"] },
  { type: "email", label: "E-mail", text: "Checked to be an address.", icon: AtSign },
  { type: "phone", label: "Phone", text: "International format.", icon: Phone },
  { type: "reference", label: "Link to a record", text: "A record of another master.", icon: Link2, takes: ["master"] },
];

export const fieldTypeInfo = (type: unknown) => FIELD_TYPE_INFO.find((t) => t.type === type) ?? { type: String(type), label: String(type), text: "", icon: CheckSquare };

/** A field's key from its name: "Medical certificate" → medicalCertificate. */
export const keyFromLabel = (label: string) => {
  const words = label.normalize("NFKD").replace(/[^A-Za-z0-9 ]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const key = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase())).join("");
  return /^[a-z]/.test(key) ? key : key ? `f${key}` : "";
};
