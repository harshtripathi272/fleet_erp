# How the web app looks and behaves

The people using this app are dispatchers, finance clerks and owners at a desk, and the same people on a phone in a yard. The screens should read like a well-kept ledger: calm, dense where the work is dense, and never in the way. These rules say what that means in practice. Each one has a reason. If a rule gets in the way of a real need, raise it on the issue, don't quietly break it.

## Words

- **Labels say what the thing is, in sentence case.** Write "Registration number" and "Tank capacity (L)", not "Registration Number" or "Tank Capacity L". Field labels come from the server (`label` on each field in `/meta/masters`), so the form, the list, the import template and the audit log all use the same words.
- **No explanatory subtext under headings, and no notes for developers on screen.** A heading and its controls should be enough. If a screen needs a paragraph to explain it, fix the screen. Real warnings that change what someone does, like "Simulated, not sent", stay, as short as possible.
- **Status values read as words, not codes.** Write "Active", not `active`. Write "Mobile money", not `mobile_money`.
- **The same thing has the same name everywhere.** The navigation item, the page heading and the button that opens it all match.

## Numbers, codes and dates

- **They never break across lines.** Plates, codes (`ADV-ZMW`, `TRIP/26/0006`), amounts with their currency, dates and times, and phone numbers are each kept on one line (`.num` / `white-space: nowrap`). A column that is too narrow scrolls; it never stacks digits.
- **Figures line up.** Use tabular figures (already on by default in `body`), and right-align amounts in tables.
- **Big figures fit their box.** A stat tile must hold its largest realistic value at 375 px (for example "1,250,000 ZMW") without touching the edge.

## Layout

- **The page never scrolls sideways at any width.** Only a table, a code block or a strip of chips may, and only inside its own frame.
- **Every grid or flex child that holds text gets `min-width: 0`.** Without it, one long word or nowrap row widens the whole page.
- **Tables keep each cell on one line.** A table frame scrolls sideways when the columns don't fit. Long free text such as descriptions or notes is cut with an ellipsis at a sensible width, and the full text is in the drawer.
- **Three widths, and only three breakpoints:**
  - 560 px: one column for phone layouts.
  - 900 px: the sidebar becomes the bottom tab bar.
  - 1100 px: narrow-desktop adjustments.

  New CSS uses these. Check every change at 375, 768 and 1280.
- **Phone screens follow a list, then detail pattern.** On a phone, a list of choices such as the masters is a page of its own. Picking one opens it full width with a way back, never as a small scrolling box above the content.
- **Controls in a row stay in a row while they fit.** A search box and its filters sit on one line on a desktop. They wrap only when the width runs out, not because a control is set to `width: 100%`.

## Controls

- **Every button has a visible label.** An icon on its own is allowed only for close, the standard ones, and even then with words when there's room.
- **One way to do each thing per screen.** Don't put two "Track" buttons on the same trip, or a person card that is secretly a desk switcher next to a separate switcher.
- **Tap targets are at least 40 px tall on a phone.**
- **Primary action on the right of a footer, cancel to its left. Destructive actions are separate and need a second click.**

## Look

- The approved look is the one in the original mock: a paper canvas, a pine sidebar, Instrument Sans for text, Source Serif for page headings, and framed tables. Page and drawer headings use the serif face. Section headings inside a page use the sans face.
- Corners: cards 12 px or less, buttons and inputs 8–10 px. No pill-shaped buttons, except for small status chips.
- Spacing comes from the 4 / 8 / 12 / 16 / 24 / 32 scale.
- No gradients, glass or blur, glow, pulsing "live" dots, emojis or decorative illustration on working screens. No movement on hover, only a change of colour.
- Colours come from the tokens in `styles/base.css`. Don't write a new hex value in a component.

## Checking a change

- Run the screen at 375, 768 and 1280 px.
- Fill it with the worst realistic data: the longest customer name, a seven-figure amount, a route with three borders, and an empty list.
- Run the layout audit. Paste `web/scripts/ui-audit.js` into the browser console, then run `__audit()`. The audit lists four kinds of problem: the page scrolling sideways, anything past the screen's edge, clipped or spilling text, and numbers, codes or labels that wrap. An empty list means the screen passes. Small tap targets are listed too; judge those case by case.
- Then look at the screen yourself. The script finds broken layouts, not ugly ones.
