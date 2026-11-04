# How the web app looks and behaves

The app is used mostly on a laptop or desktop: by the owner, the dispatchers and finance at their desks. Drivers, and sometimes the office, use it on a phone. The screens should read like a well-kept ledger: calm, dense where the work is dense, and never in the way. These rules say what that means in practice. Each one has a reason. If a rule gets in the way of a real need, raise it on the issue, don't quietly break it.

## Words

- **Labels say what the thing is, in sentence case.** Write "Registration number" and "Tank capacity (L)", not "Registration Number" or "Tank Capacity L".
  - Field labels come from the server (`label` on each field in `/meta/masters`), so the form, the list, the import template and the audit log all use the same words.
  - A master whose field key doesn't read well names it with `labels`, for example `levels.minAmountMinor` → "Applies from".
- **Choices read as words, not codes.** Write "Active", not `active`, and "A truck is loaded", not `trip.loaded`. A master names its choices with `choiceLabels`. Values without a name are turned into words from the value, with known spellings kept ("WhatsApp", "SMS", "e-mail").
- **Descriptions are content; don't remove them to tidy a screen.** A master's description under its heading, a set-up step's reason, and a setting's line on what it changes all help someone who has never seen the screen. Write them for that person, in plain words. What doesn't belong on screen: notes for developers ("owner policy pending"), filler, and the same sentence repeated on every row. If something is cluttered, present it better; don't delete the information.
- **Say what a setting really does.** If it is stored but not acted on yet, the screen says so ("Not built yet", "Kept for escalation, which is not built yet"). A switch that does nothing is never shown as if it works.
- **The same thing has the same name everywhere.** The navigation item, the page heading and the button that opens it all match.

## Numbers, codes and dates

- **They never break across lines.** Plates, codes (`ADV-ZMW`, `TRIP/26/0006`), amounts with their currency, dates and times, and phone numbers each stay on one line. The formatters in `ui/format.ts` join their parts with non-breaking spaces; use them rather than building strings by hand. A column that is too narrow scrolls; it never stacks digits.
- **Money is typed in the currency, never in minor units.** A field stored as `…Minor` shows "10,000.00 ZMW" and saves 1000000. Where a level is measured in litres, the same field shows litres.
- **Figures line up.** Use tabular figures (already on by default in `body`), and right-align amounts in tables.
- **Big figures fit their box.** A stat tile must hold its largest realistic value, for example "1,250,000 ZMW", without touching the edge.

## Settings and forms

Every choice the company can make is a setting. Most settings are changed once, by someone careful, so each one should explain itself. Use the kit components in `ui/kit.tsx`, not raw inputs:

| The setting is | Use | Not |
|---|---|---|
| On or off | `Switch` in a `SettingRow` (settings pages) or `SwitchField` (forms): its name, a line on what changes, then the switch | a bare tick box |
| Several picks from a short list (channels, currencies) | `ChoiceChips` in a `FieldGroup`: labelled buttons you toggle | a row of tick boxes |
| One pick from 2–5 options | `Segmented choice`: every option in view | a dropdown that hides them |
| One pick from many | a `select` | — |
| A number with a unit | `UnitInput`, with the unit inside the box | a unit floating beside it |
| A list of entries (approval levels, recipients) | numbered cards with Remove in each card's header and "Add level" below. An entry's position is its number; nobody types it | unnumbered rows with Remove at the bottom |
| Access for a role | one level per area (None, See, Edit, Manage, Full), a switch for sensitive fields, "Set all" per group, and Custom for anything else | a tick box for every action on every area |

- **A settings page is titled sections of rows.** Each row has the setting and what it changes on the left, and its control on the right, so the controls line up in one column.
- **Saving.** A long settings page shows one save bar, only when something has changed, with Discard and Save. There's no Save at the top as well.
- **Never put a group of controls inside a `<label>`.** A label names one control. Use `FieldGroup` for chips and other groups.
- **Field hints come from the master** (`hints`), for fields whose name doesn't say what to type, such as a numbering pattern or an approval threshold.

## Layout

- **The page never scrolls sideways at any width.** Only a table, a code block or a strip of chips may, and only inside its own frame.
- **Every grid or flex child that holds text gets `min-width: 0`.** Without it, one long word or nowrap row widens the whole page.
- **Tables keep each cell on one line.** A table frame scrolls sideways when the columns don't fit, with the first column pinned. Long free text, such as descriptions or notes, is cut with an ellipsis at a sensible width, and the full text is in the drawer.
- **Reading width.** Running text is at most about 70 characters wide. Settings pages and forms stop at about 920 px, so on a wide screen the eye doesn't travel from one edge to the other.
- **Three breakpoints:**
  - 560 px: one column for phone layouts.
  - 900 px: the sidebar becomes the bottom tab bar.
  - 1100 px: narrow-desktop adjustments.

  New CSS uses these. Check every change at 1440 and 1366 first, then 1920, 768 and 375.
- **On phones, lists come before details.** A list of choices such as the masters is a page of its own. Picking one opens it full width with a way back, never as a small scrolling box above the content.
- **Controls in a row stay in a row while they fit.** A search box and its filters sit on one line on a desktop. They wrap only when the width runs out, not because a control is set to `width: 100%`.

## Controls

- **Every button has a visible label.** An icon on its own is allowed only for the standard close button, and even then with words when there's room.
- **One way to do each thing per screen.** Don't put two "Track" buttons on the same trip, or a person card that is secretly a desk switcher next to a separate switcher.
- **Tap targets are at least 40 px tall on a phone.**
- **Primary action on the right of a footer, cancel to its left. Destructive actions are separate and need a second click.**

## Look

- **The approved look** is the one in the original mock: a paper canvas, a pine sidebar, Instrument Sans for text, Source Serif for page headings, and framed tables. Page and drawer headings use the serif face; section headings inside a page use the sans face.
- **Text contrast** is at least 4.5:1 against its background. `--ink-3` is the lightest grey allowed for text; `--ink-4` is for borders and disabled text only.
- **Corners:** cards 12 px or less, buttons and inputs 8–10 px. No pill-shaped buttons, except for small status chips.
- **Spacing** comes from the 4 / 8 / 12 / 16 / 24 / 32 scale.
- **Colours** come from the tokens in `styles/base.css`. Don't write a new hex value in a component.

### What reads as generated UI, and is not used

These are the defaults AI tools produce. Lakshya rejects them on sight. The list comes from Impeccable's "craft floor" and the no-slop-ui skill, both in his shelf. `npm run check:ui` (`web/scripts/check-ui.mjs`, run in CI) fails on the ones a stylesheet can show.

| Don't | Do |
|---|---|
| A coloured bar on one edge of a selected item, card or callout (`border-left: 3px`, `inset 2px 0 0`, a `::before` stripe) | A flat tint and heavier text for the selected item. Callouts use a tinted background or a full 1px border. |
| A hovered row that becomes a floating white card | A slight darkening of the row's background |
| Gradients on buttons, panels, cards, progress bars or backgrounds | Solid colours from the tokens |
| Glass, blur, or a coloured halo ring around a card | A solid background and a 1px border; the border colour carries the state |
| Pill buttons and bubbles (corners above 12px) | 8–10px on controls, 12px on cards; small status badges 6px |
| Tabs with a raised pill in a grey track | An underline under the selected tab |
| A dot in front of a status word | The word in a tinted badge |
| An icon in a tinted tile beside every title | The icon alone, in its colour; a person's avatar is fine |
| A row of metric cards at the top of a dashboard | The figures in one framed line divided by rules |
| A small label or number above a heading (an eyebrow) | The heading first, with its identifiers on the line below |
| Cards inside cards | One level of framing; entries inside a drawer are cards, but their list is not boxed again |
| Pulsing, breathing or endlessly moving decoration ("live" dots, halos, animated art) | Still marks; only spinners and loading placeholders move |
| Movement on hover or press (lift, tilt, slide) | A change of colour |
| Decorative drawings or empty panels to fill space | Nothing; the content sets the layout |
| A Unicode glyph standing in for an icon (✓) | The icon from lucide-react |

**Exceptions.** Things that imitate a real object keep their look: the simulated phone and WhatsApp, the printed trip sheet and statement, a fuel ticket, number plates and the dashcam. In CSS, each such rule says so in a comment directly above it: `/* ui-allow: a paper fuel ticket with punched edges */`. Without that comment, the check fails.

## Checking a change

- Run the screen at 1440 and 1366, then 1920, 768 and 375 px.
- Fill it with the worst realistic data: the longest customer name, a seven-figure amount, a route with three borders, and an empty list.
- Run the layout audit:
  1. Paste `web/scripts/ui-audit.js` into the browser console.
  2. Run `__audit()`. It lists the page scrolling sideways, anything past the screen's edge, clipped or spilling text, and numbers, codes or labels that wrap.

  An empty list means the screen passes. Small tap targets are listed too; judge those case by case.
- Then look at the screen yourself: the script finds broken layouts, not ugly ones. Read every setting as someone new to it would, and check that it says what it changes.
