import { useId } from "react";

/** Marichi mark: a road bending into a compass needle. */
export function BrandMark({ size = 30 }: { size?: number }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="brand-mark">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3b8e73" />
          <stop offset="1" stopColor="#1d4d3f" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${id})`} />
      <rect x="1.5" y="1.5" width="29" height="29" rx="7.5" fill="none" stroke="rgba(255,255,255,.18)" />
      <path d="M8 23c3-6 6-8 9-8s5-2 7-7" fill="none" stroke="#f3e1b8" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M8 23c3-6 6-8 9-8s5-2 7-7" fill="none" stroke="#1d4d3f" strokeWidth="0.8" strokeDasharray="1.6 2.2" strokeLinecap="round" />
      <circle cx="24" cy="8" r="2.3" fill="#fff" />
    </svg>
  );
}

/** The branded screen shown while signing in or while a part of the app loads. */
export function Waiting({ text }: { text: string }) {
  return (
    <div className="picker">
      <aside className="picker-side">
        <Wordmark />
      </aside>
      <main className="picker-main">
        <p className="muted">{text}</p>
      </main>
    </div>
  );
}

export function Wordmark({ light = true }: { light?: boolean }) {
  return (
    <span className={`wordmark ${light ? "light" : ""}`}>
      <BrandMark />
      <span>
        <b>Marichi</b> Fleet
      </span>
    </span>
  );
}
