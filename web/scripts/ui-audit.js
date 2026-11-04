// Layout audit (docs/ui-rules.md): paste into the browser console, then run __audit(). Lists what breaks on the current screen.
window.__audit = function (label) {
  const out = [];
  const vw = document.documentElement.clientWidth;
  const sel = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    const cls = [...el.classList].slice(0, 3).join(".");
    if (cls) s += "." + cls;
    const p = el.parentElement;
    if (p && p !== document.body) {
      const pc = [...p.classList].slice(0, 2).join(".");
      s = (p.tagName.toLowerCase() + (pc ? "." + pc : "")) + " > " + s;
    }
    return s;
  };
  const text = (el) => (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  };
  // Is el inside a container that scrolls sideways on purpose (table frames, chip rows)?
  const inScroller = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if ((ox === "auto" || ox === "scroll") && p.scrollWidth > p.clientWidth + 1) return p;
    }
    return null;
  };

  // 1. The page itself scrolls sideways.
  const sw = document.documentElement.scrollWidth;
  if (sw > vw + 1) out.push({ kind: "page-scroll-x", detail: `page is ${sw}px wide at ${vw}px` });

  const all = [...document.body.querySelectorAll("*")].filter((el) => !el.closest("svg") && visible(el));
  for (const el of all) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    // 2. Sticks out past the right edge of the screen (and isn't in a sideways scroller).
    if (r.right > vw + 1 && r.left < vw && !inScroller(el) && cs.position !== "fixed") {
      const parentR = el.parentElement?.getBoundingClientRect();
      if (!parentR || parentR.right <= vw + 1) out.push({ kind: "past-right-edge", el: sel(el), detail: `right ${Math.round(r.right)} > ${vw}`, text: text(el) });
    }
    // 3. Content wider than its own box without a scrollbar: clipped or spilling.
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (hasText && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
      const ox = cs.overflowX;
      if (ox !== "auto" && ox !== "scroll") {
        const ell = cs.textOverflow === "ellipsis";
        out.push({ kind: ell ? "truncated" : (ox === "hidden" || ox === "clip" ? "clipped" : "spills"), el: sel(el), detail: `${el.scrollWidth} in ${el.clientWidth}`, text: text(el) });
      }
    }
    // 4. Numbers, codes, dates and amounts broken over lines (digits stacked vertically).
    if (hasText && el.children.length === 0) {
      const t = el.textContent.trim();
      const numeric = /\d/.test(t) && t.length <= 40 && /^[\p{L}]{0,4}[\s\d.,:/%+\-−–×()#]*[\p{L}\d]{0,6}$/u.test(t);
      if (numeric) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const lines = new Set([...range.getClientRects()].map((q) => Math.round(q.top)));
        if (lines.size > 1) out.push({ kind: "number-wraps", el: sel(el), detail: `${lines.size} lines, ${Math.round(r.width)}px wide`, text: t });
      }
    }
    // 5. Button and chip labels wrapping onto two lines.
    // A single run of text inside a control that breaks onto a second line.
    if (el.closest("button, .btn, [role=tab], .chip, .tab, .status, .pill, .badge, th, .num")) {
      for (const n of el.childNodes) {
        if (n.nodeType !== 3 || !n.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const lines = new Set([...range.getClientRects()].filter((q) => q.width > 0).map((q) => Math.round(q.top)));
        if (lines.size > 1) out.push({ kind: "label-wraps", el: sel(el), detail: `${lines.size} lines`, text: n.textContent.trim().slice(0, 50) });
      }
    }
    // Any text run broken mid-word (one word per line: a column too narrow for its content).
    if (hasText && r.width < 90) {
      for (const n of el.childNodes) {
        if (n.nodeType !== 3) continue;
        const t = n.textContent.trim();
        if (t.split(/\s+/).length < 2 && t.length > 6) {
          const range = document.createRange();
          range.selectNodeContents(n);
          const lines = new Set([...range.getClientRects()].filter((q) => q.width > 0).map((q) => Math.round(q.top)));
          if (lines.size > 1) out.push({ kind: "word-broken", el: sel(el), detail: `${lines.size} lines in ${Math.round(r.width)}px`, text: t.slice(0, 40) });
        }
      }
    }
    // 6. Tap targets under 32px tall at phone width.
    if (vw < 500 && el.matches("button, a[href], input, select, [role=tab]") && r.height < 28 && r.width > 0) {
      out.push({ kind: "small-target", el: sel(el), detail: `${Math.round(r.width)}×${Math.round(r.height)}`, text: text(el) });
    }
  }
  // Collapse duplicates (same kind + selector), keep counts.
  const seen = new Map();
  for (const p of out) {
    const k = p.kind + "|" + (p.el || "");
    if (seen.has(k)) seen.get(k).n++;
    else seen.set(k, { ...p, n: 1 });
  }
  return { label, vw, problems: [...seen.values()] };
};
"audit loaded";
