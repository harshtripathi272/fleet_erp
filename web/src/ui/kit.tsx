import { useEffect } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
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
}: {
  value: T;
  options: { value: T; label: ReactNode; count?: number }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          role="tab"
          type="button"
          aria-selected={value === option.value}
          className={value === option.value ? "on" : ""}
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
      <i />
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
