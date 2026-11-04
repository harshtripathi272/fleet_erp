#!/usr/bin/env node
/**
 * Fails when the app's own stylesheets use a pattern that reads as AI-generated UI (docs/ui-rules.md, "Look"):
 * side stripes, decorative gradients, glass and blur, oversized corners, movement on hover, endless animation and
 * glyphs standing in for icons. The simulated phone and the printed documents (phone.css, paper.css) imitate real
 * objects and are not checked. A rule that imitates a real object too says why in a comment just above it:
 *   /* ui-allow: a paper fuel ticket with punched edges *\/
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("../src/", import.meta.url).pathname;
const SKIP = new Set(["phone.css", "paper.css"]);
const files = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(join(dir, e.name));
    else if (e.name.endsWith(".css") && !SKIP.has(e.name)) files.push(join(dir, e.name));
  }
};
walk(root);

const CHECKS = [
  { name: "side stripe (a coloured bar on one edge of a card or list item)", test: (d) => /border-(left|right)(-width)?\s*:\s*[2-9]px/.test(d) || /inset\s+-?[2-9]px\s+0\s+0/.test(d) },
  { name: "decorative gradient", test: (d) => /gradient\(/.test(d) },
  { name: "glass or blur", test: (d) => /backdrop-filter|filter:\s*blur/.test(d) },
  { name: "corner radius above 12px (pills and bubbles)", test: (d) => [...d.matchAll(/border-radius\s*:\s*([^;]+)/g)].some((m) => m[1].split(/\s+/).some((v) => /^(\d+)px$/.test(v) && Number(v.slice(0, -2)) > 12 && !/50%/.test(m[1]))) },
  { name: "endless animation", test: (d) => /animation[^;]*infinite/.test(d) },
  { name: "glyph standing in for an icon", test: (d) => /content\s*:\s*"[^"]*[^\x00-\x7F ][^"]*"/.test(d) },
];
const HOVER_MOVE = { name: "movement on hover or press", test: (sel, d) => /:(hover|active)/.test(sel) && /transform\s*:/.test(d) };

const problems = [];
for (const file of files) {
  const css = readFileSync(file, "utf8");
  // Innermost rules: selector { declarations }.
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of css.matchAll(rule)) {
    // The text before "{" holds the selector and any comment written just above it.
    const head = m[1];
    const selector = head.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    const body = m[2];
    if (selector.startsWith("@keyframes") || /^\d|^(from|to)$/.test(selector)) continue;
    const comments = [...head.matchAll(/\/\*([\s\S]*?)\*\//g)];
    if (/ui-allow:\s*\S/.test(comments.at(-1)?.[1] ?? "")) continue;
    // The line of the "{" that opens the rule.
    const line = css.slice(0, m.index + head.length).split("\n").length;
    for (const c of CHECKS) if (c.test(body)) problems.push(`${relative(root, file)}:${line}  ${selector.split("\n").pop()}  — ${c.name}`);
    if (HOVER_MOVE.test(selector, body)) problems.push(`${relative(root, file)}:${line}  ${selector.split("\n").pop()}  — ${HOVER_MOVE.name}`);
  }
}
if (problems.length) {
  console.error(`UI check: ${problems.length} pattern(s) that read as generated UI (see docs/ui-rules.md, "Look"):\n${problems.map((p) => `  ${p}`).join("\n")}`);
  console.error('If a rule imitates a real object, say so just above it: /* ui-allow: <why> */');
  process.exit(1);
}
console.log(`UI check: ${files.length} stylesheets clean.`);
