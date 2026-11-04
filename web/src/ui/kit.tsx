import { useEffect } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { Check, X } from "lucide-react";
import { initials } from "./format";

type Tone = "primary" | "secondary" | "quiet" | "danger" | "brass";

export function Button({
  tone = "secondary",
  size,
  busy,
  children,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; size?: "sm" | "lg"; busy?: boolean }) {
  return (
    <button
      type="button"
      className={`btn btn-${tone} ${size ? `btn-${size}` : ""} ${busy ? "is-busy" : ""} ${className}`}
      {...rest}
    >
      {busy && <span className="spinner" aria-hidden />}
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
  wide,
  className = "",
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  wide?: boolean;
  className?: string;
}) {
  // The wrapping <label> names the control inside it; no htmlFor, which would point it elsewhere.
  return (
    <label className={`field ${wide ? "field-wide" : ""} ${className}`}>
      <span className="field-label">{label}</span>
      <span className="field-control">
        {children}
      </span>
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  choice,
  disabled,
}: {
  value: T;
  options: { value: T; label: ReactNode; count?: number; disabled?: boolean }[];
  onChange: (value: T) => void;
  label: string;
  /** A setting's value rather than a view: radio semantics instead of tabs. */
  choice?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className={choice ? "segmented segmented-choice" : "segmented"} role={choice ? "radiogroup" : "tablist"} aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          role={choice ? "radio" : "tab"}
          type="button"
          {...(choice ? { "aria-checked": value === option.value } : { "aria-selected": value === option.value })}
          className={value === option.value ? "on" : ""}
          disabled={disabled || option.disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {option.count ? <span className="count">{option.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Avatar({ name, tone = "pine", size = 32 }: { name: string; tone?: string; size?: number }) {
  return (
    <span className={`avatar avatar-${tone}`} style={{ width: size, height: size, fontSize: size * 0.38 }} aria-hidden>
      {initials(name)}
    </span>
  );
}

export function Status({ tone, children }: { tone: "ok" | "wait" | "bad" | "info" | "mute" | "you"; children: ReactNode }) {
  return (
    <span className={`status status-${tone}`}>
      {children}
    </span>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <svg viewBox="0 0 64 40" aria-hidden className="empty-mark">
        <path d="M2 30h60" />
        <path d="M8 30V18h22v12M30 22h12l6 8" />
        <circle cx="16" cy="31" r="4" />
        <circle cx="42" cy="31" r="4" />
      </svg>
      <strong>{title}</strong>
      {children}
    </div>
  );
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);
}

export function Drawer({
  open,
  title,
  onClose,
  children,
  footer,
  width = 520,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  return createPortal(
    <AnimatePresence>
      {open && <DrawerBody title={title} onClose={onClose} footer={footer} width={width}>{children}</DrawerBody>}
    </AnimatePresence>,
    document.body,
  );
}

function DrawerBody({
  title,
  onClose,
  children,
  footer,
  width,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width: number;
}) {
  useEscape(onClose);
  return (
    <div className="layer" role="presentation">
      <motion.div
        className="scrim"
        onClick={onClose}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
      />
      <motion.section
        className="drawer"
        role="dialog"
        aria-modal="true"
        style={{ width: `min(${width}px, 100vw)` }}
        initial={{ x: 40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 30, opacity: 0 }}
        transition={{ type: "spring", stiffness: 420, damping: 38 }}
      >
        <header className="drawer-head">
          <h2>{title}</h2>
          <button className="icon-btn with-label" onClick={onClose}>
            <X size={18} />
            <span>Close</span>
          </button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer && <footer className="drawer-foot">{footer}</footer>}
      </motion.section>
    </div>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width = 460,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  return createPortal(
    <AnimatePresence>
      {open && (
        <ModalBody title={title} onClose={onClose} footer={footer} width={width}>
          {children}
        </ModalBody>
      )}
    </AnimatePresence>,
    document.body,
  );
}

function ModalBody({
  title,
  onClose,
  children,
  footer,
  width,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width: number;
}) {
  useEscape(onClose);
  return (
    <div className="layer layer-center" role="presentation">
      <motion.div className="scrim" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
      <motion.section
        className="modal"
        role="dialog"
        aria-modal="true"
        style={{ width: `min(${width}px, calc(100vw - 32px))` }}
        initial={{ y: 14, opacity: 0, scale: 0.98 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        exit={{ y: 8, opacity: 0, scale: 0.98 }}
        transition={{ type: "spring", stiffness: 480, damping: 36 }}
      >
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn with-label" onClick={onClose}>
            <X size={18} />
            <span>Close</span>
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </motion.section>
    </div>
  );
}

export function Rows({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="rows">
      {rows.map(([k, v], index) => (
        <div key={index}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Horizontal budget bar: filled parts against a total. */
export function Meter({
  total,
  parts,
}: {
  total: number;
  parts: { value: number; tone: string; label: string }[];
}) {
  const sum = parts.reduce((s, p) => s + Math.max(0, p.value), 0);
  const scale = Math.max(total, sum, 1);
  return (
    <div className="meter" role="img" aria-label={parts.map((p) => `${p.label} ${Math.round(p.value)}`).join(", ")}>
      {parts.map((part) =>
        part.value > 0 ? (
          <motion.span
            key={part.label}
            className={`meter-part meter-${part.tone}`}
            initial={{ width: 0 }}
            animate={{ width: `${(part.value / scale) * 100}%` }}
            transition={{ type: "spring", stiffness: 160, damping: 26 }}
          />
        ) : null,
      )}
      {sum > total && total > 0 && <span className="meter-limit" style={{ left: `${(total / scale) * 100}%` }} />}
    </div>
  );
}

/* ---------- Settings: how people change how the company works ---------- */

/** An on/off setting. A button with role="switch", so a wrapping <label> or the row it sits in can name it. */
export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (on: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="switch-knob" aria-hidden />
    </button>
  );
}

/** A yes/no field inside a form grid: its name, an optional line on what it does, and the switch. */
export function SwitchField({ label, hint, checked, onChange, disabled }: { label: string; hint?: ReactNode; checked: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <label className="switch-field">
      <span className="switch-text">
        <span className="field-label">{label}</span>
        {hint && <span className="field-hint">{hint}</span>}
      </span>
      <Switch checked={checked} onChange={onChange} disabled={disabled} />
    </label>
  );
}

/** Several choices from a short list, each a labelled button that is on or off. */
export function ChoiceChips<T extends string>({ options, value, onChange, disabled, label }: { options: { value: T; label: ReactNode }[]; value: T[]; onChange: (next: T[]) => void; disabled?: boolean; label: string }) {
  return (
    <div className="choice-chips" role="group" aria-label={label}>
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button key={o.value} type="button" aria-pressed={on} className={on ? "on" : ""} disabled={disabled}
            onClick={() => onChange(on ? value.filter((v) => v !== o.value) : [...value, o.value])}>
            {on && <Check size={14} aria-hidden />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A field whose control is a group of buttons: named by a heading, not a <label>, which can hold one control only. */
export function FieldGroup({ label, hint, children, wide }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`field ${wide ? "field-wide" : ""}`} role="group" aria-label={label}>
      <span className="field-label">{label}</span>
      <div className="field-control">{children}</div>
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

/** A number with its unit inside the box ("62 km/h"), so a row of them lines up. */
export function UnitInput({ value, onChange, unit, step, disabled, label }: { value: number | string | undefined; onChange: (v: string) => void; unit: string; step?: number; disabled?: boolean; label?: string }) {
  return (
    <span className="unit-box">
      <input className="input" type="number" inputMode="decimal" step={step ?? "any"} aria-label={label} disabled={disabled} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />
      <span className="unit-box-unit" aria-hidden>{unit}</span>
    </span>
  );
}

/** A titled group of settings on a settings page. */
export function SettingsSection({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="settings-section">
      <header>
        <h3>{title}</h3>
        {description && <p>{description}</p>}
      </header>
      <div className="settings-rows">{children}</div>
    </section>
  );
}

/** One setting: what it is and what it changes on the left, its control on the right. */
export function SettingRow({ title, description, children, htmlFor }: { title: ReactNode; description?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        {htmlFor ? <label htmlFor={htmlFor} className="setting-title">{title}</label> : <span className="setting-title">{title}</span>}
        {description && <p>{description}</p>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

/** Shown while a settings page has changes that aren't saved: the one place to save or throw them away. */
export function SaveBar({ dirty, busy, onSave, onDiscard }: { dirty: boolean; busy?: boolean; onSave: () => void; onDiscard: () => void }) {
  if (!dirty) return null;
  return (
    <div className="save-bar" role="region" aria-label="Unsaved changes">
      <span>You have changes that aren't saved.</span>
      <Button tone="quiet" disabled={busy} onClick={onDiscard}>Discard</Button>
      <Button tone="primary" busy={busy} onClick={onSave}>Save changes</Button>
    </div>
  );
}
