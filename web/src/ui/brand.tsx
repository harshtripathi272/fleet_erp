import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/**
 * The company's brand (#71): its product name, logo, icon, accent colour and watermark, from the public
 * /api/v1/brand, so the sign-in page already looks like the company's product. Nothing here names any company.
 */

export interface Brand {
  productName: string;
  shortName: string;
  companyName: string | null;
  logo: string | null;
  logoDark: string | null;
  icon: string | null;
  accent: string | null;
  watermark: { mode: "off" | "text" | "logo"; text: string | null; opacity: number; angle: number; screens: boolean };
  testMark: boolean;
}

const NEUTRAL: Brand = { productName: "Fleet", shortName: "Fleet", companyName: null, logo: null, logoDark: null, icon: null, accent: null, watermark: { mode: "off", text: null, opacity: 0.08, angle: 35, screens: false }, testMark: false };
const BrandContext = createContext<{ brand: Brand; reload: () => void }>({ brand: NEUTRAL, reload: () => {} });
export const useBrand = () => useContext(BrandContext).brand;
/** After the brand settings are saved, so every screen picks up the change at once. */
export const useReloadBrand = () => useContext(BrandContext).reload;

/** Mixes a hex colour towards black (amount < 0) or white (amount > 0). */
function shade(hex: string, amount: number) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(amount < 0 ? c * (1 + amount) : c + (255 - c) * amount);
  const [r, g, b] = [mix(n >> 16), mix((n >> 8) & 255), mix(n & 255)];
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

export function BrandProvider({ children }: { children: ReactNode }) {
  const [brand, setBrand] = useState<Brand>(NEUTRAL);
  const [stamp, setStamp] = useState(0);
  useEffect(() => {
    let live = true;
    fetch("/api/v1/brand")
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => { if (live && body?.data) setBrand({ ...NEUTRAL, ...body.data }); })
      .catch(() => {});
    return () => { live = false; };
  }, [stamp]);

  // The tab, the icon and the accent follow the brand.
  useEffect(() => {
    document.title = brand.productName;
    const link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (link && (brand.icon || brand.logo)) { link.href = (brand.icon ?? brand.logo)!; link.type = ""; }
    const root = document.documentElement.style;
    if (brand.accent) {
      // The primary colour and its darker and lighter steps; everything built on the pine tokens follows.
      root.setProperty("--pine-700", brand.accent);
      root.setProperty("--pine-600", shade(brand.accent, 0.12));
      root.setProperty("--pine-500", shade(brand.accent, 0.25));
      root.setProperty("--pine-800", shade(brand.accent, -0.2));
      root.setProperty("--pine-900", shade(brand.accent, -0.4));
      root.setProperty("--pine-950", shade(brand.accent, -0.55));
      root.setProperty("--pine-50", shade(brand.accent, 0.92));
      root.setProperty("--pine-100", shade(brand.accent, 0.84));
      root.setProperty("--pine-200", shade(brand.accent, 0.68));
    } else {
      for (const k of ["--pine-700", "--pine-600", "--pine-500", "--pine-800", "--pine-900", "--pine-950", "--pine-50", "--pine-100", "--pine-200"]) root.removeProperty(k);
    }
  }, [brand]);

  return <BrandContext.Provider value={{ brand, reload: () => setStamp((s) => s + 1) }}>{children}</BrandContext.Provider>;
}

/** Contrast of white text on a colour (WCAG), to refuse an accent that would make buttons unreadable. */
export function contrastWithWhite(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const l = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return 1.05 / (l + 0.05);
}

/** The default mark, for a company that hasn't uploaded an icon: a road bending into a compass needle. */
export function BrandMark({ size = 30 }: { size?: number }) {
  const brand = useBrand();
  if (brand.icon) return <img src={brand.icon} width={size} height={size} alt="" className="brand-mark brand-mark-img" />;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="brand-mark">
      <rect x="1" y="1" width="30" height="30" rx="8" fill="var(--pine-600)" />
      <path d="M8 23c3-6 6-8 9-8s5-2 7-7" fill="none" stroke="#f3e1b8" strokeWidth="2.4" strokeLinecap="round" />
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

/** The company's logo, or its mark and product name. `light` is for dark backgrounds (the sidebar). */
export function Wordmark({ light = true }: { light?: boolean }) {
  const brand = useBrand();
  const logo = light ? brand.logoDark ?? brand.logo : brand.logo;
  if (logo) return <span className={`wordmark ${light ? "light" : ""}`}><img src={logo} alt={brand.productName} className="wordmark-logo" /></span>;
  return (
    <span className={`wordmark ${light ? "light" : ""}`}>
      <BrandMark />
      <span>{brand.productName}</span>
    </span>
  );
}

/**
 * The company's watermark over a document preview or a screen, when it chose one for screens; "TEST COPY" on a
 * test installation. Purely visual: it never blocks clicks.
 */
export function Watermark({ forDocument = false }: { forDocument?: boolean }) {
  const brand = useBrand();
  const mark = brand.watermark;
  const show = (forDocument || mark.screens) && mark.mode !== "off";
  if (!show && !brand.testMark) return null;
  return (
    <div className="watermark" aria-hidden>
      {show && mark.mode === "text" && mark.text && <span style={{ opacity: mark.opacity, transform: `rotate(${-mark.angle}deg)` }}>{mark.text}</span>}
      {show && mark.mode === "logo" && brand.logo && <img src={brand.logo} alt="" style={{ opacity: mark.opacity, transform: `rotate(${-mark.angle}deg)` }} />}
      {brand.testMark && <span className="watermark-test">TEST COPY</span>}
    </div>
  );
}
