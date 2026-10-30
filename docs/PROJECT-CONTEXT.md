# Project context

What this project is, what has been decided, and how we work on it.

**Settled:** the stack, the owner's decisions and the working rules below. **Open:** everything else here (how models are grouped and ordered, screen layouts, UI guidance) is the current thinking, to be discussed and improved, not a fixed specification.

## What we are building

**Marichi Fleet** is a transport ERP for a haulier running fuel and cargo trucks across Zambia, Tanzania and the DRC. It covers the fleet, drivers, customers, routes, trips, trip money (budgets, advances, fuel, expenses) and driver settlement.

Work so far:

| Piece | Where | State |
| --- | --- | --- |
| Clickable mock of the trip flow (Owner, Operations, Finance and Driver desks) | `trip-flow/` in the separate repository `laksh-ya/fleet-erp` | Done; it is the reference for screens and flow |
| Masters specification (MF-SPEC-01) | Shared page; ask Lakshya for access | Done; this backend implements its MVP column |
| **This repository: the backend for the masters** | `feature/mvp-masters-backend`, pull request #1 | Done and tested; under review, not merged yet |
| Models reference page (the console's model list, as a shareable page) | Shared page; ask Lakshya for access | Snapshot of 22 Oct 2026 |
| Trips and money transactions (trip, advance, fuel, loading and offloading, settlement) | Not started | Next, after the models are agreed |
| React frontend | Not started | See [Building the React app](FRONTEND.md) |

The legacy system screenshots (GoFleet: trip, waypoints, advance request, disbursement, loading and offloading, fuel shortage, driver settlement, trip sheet) and the master catalogue spreadsheet are with Lakshya, outside the repositories.

## The stack (decided; use exactly this)

| Layer | Choice |
| --- | --- |
| Frontend | React, TanStack (Query, Router, Table, Form), shadcn/ui |
| Backend | Node.js, Express |
| Database | MongoDB with Mongoose |
| Cache and rate limits | Redis (optional locally) |
| Code structure | Models → Route → Controller → Service, per the Marichi backend coding guide |
| WhatsApp and SMS | **Marichi Talks**, the parent company's messaging service |
| E-mail | SMTP credentials (Mandrill) |
| Deployment | Docker Compose |

Inside that, the backend uses TypeScript, Zod for validation, Pino for logs and Node's built-in test runner.

How the stack has been used so far, and why:

- **Agreed as a set.** If something new seems needed (a library, a service, a pattern), it is worth proposing and discussing first, so the team keeps one shared picture.
- **A traditional MERN setup.** MongoDB runs as a plain standalone server, without a replica set or multi-document transactions, to keep hosting simple. Duplicates and races are prevented with unique indexes and a `version` on every record instead.
- **Sign-in is our own** e-mail and password (scrypt hashes, signed tokens from Node's crypto module), so there is no third-party auth dependency for now.

## How we work

- Changes go on a branch and into a pull request, so they can be reviewed; `main` is not pushed to directly.
- `npm run check` (type-check, tests, build) passes before a push.
- Secrets live only in `.env`, which is never committed. `.env.example` lists every setting.
- When something is unclear or seems to need a different approach, ask. These notes describe where we are, not everything that is allowed.

## Decisions from the owner (meeting of 20 September 2026)

1. **Trips start from the truck.** Choose the truck first; its trailer and driver follow.
2. **Driver settlement is periodic**, across several trips, not per trip.
3. **Fuel cargo is corrected for temperature and density to 20 °C**, with an allowance of about 3%. Loss beyond the allowance is charged to the driver.
4. **Drivers work over WhatsApp.** They do not sign in to the system.
5. **Approvals can go up to the owner over WhatsApp.**

## How the models are organised

The models are grouped in four tiers, most important first. This grouping is a presentation choice for discussion; it lives in one list (`TIERS` in `public/console/app.js`), and any model not in that list appears under Reference lists automatically.

1. **Core records**: what a trip is made of. Vehicles, Trailers, Truck–trailer pairings, Drivers, Parties, Places, Routes, Products, Compliance documents.
2. **Trip rules**: how a trip runs and is paid for. Trip types and stages, stop types, trip budgets, fuel norms, advance policies, expense categories and items, shortage policies, recovery rules, border posts, load types, proof-of-delivery types, cancellation reasons.
3. **Reference lists**: lookups that keep values consistent. Vehicle makes, models and types; trailer types; licence classes; document, permit and insurance types; product groups; fuel types; countries, provinces, cities; units and conversions; currencies and exchange rates; payment methods; order sources.
4. **Company setup**: branches, users, roles, numbering series, approval policies, message templates, notification rules, print layouts, lists, custom fields, custom masters.

Why some models are shaped the way they are:

- **Truck and trailer are separate**, joined by a **pairing** with history: each has its own plate, insurance and permits, and trailers move between trucks.
- **Drivers are not users**, because they work over WhatsApp. Their ID, passport and bank details are masked for roles without permission.
- **Parties is one model with roles** (customer, consignor, consignee, supplier, broker, clearing agent, hired transporter, financier, dealer), because one company is often several of these.
- **Products carry density and reference temperature** for the fuel correction rule.
- **Border posts are separate from places** because they carry fees, waiting times and clearing agents.

Rules every model follows:

- Archive instead of delete; delete only when nothing refers to the record.
- Every update carries the `version` it was based on; a stale one is refused (409).
- Every change is written to the audit log.
- Linked records must exist and be active when a record is saved.
- Money is stored in whole minor units (ngwee, cents) with a currency.
- Every model can be limited to branches, has validity dates, tags, notes, attachments and custom fields.

## UI guidance

What earlier rounds of feedback on the mock and the console liked and rejected. Treat it as guidance; when a screen needs something different, discuss it.

Liked so far:

- Important things first: core models and required fields at the top, supporting items lower, tools and documentation on their own pages.
- A formal, calm look: paper-coloured canvas, pine-green sidebar, Instrument Sans, framed tables. Realistic where it matters (printed documents, receipts, the WhatsApp phone).
- Screens that also work on a phone, with labelled buttons.

Rejected so far, usually as cluttered or "AI-looking":

- Small all-caps labels above headings; explanatory subtitles or developer notes in the interface.
- Two controls for the same thing on one screen.
- "Live" badges, pulsing dots, emojis, decorative illustrations.
- Effects that only appear on hover, such as link lines drawn on hover. A plain toggle went down better.

## Words used in this project

| Word | Meaning |
| --- | --- |
| Horse, prime mover | The truck that pulls a trailer |
| Pairing | Which trailer is hitched to which truck, and since when |
| Party | Any company or person the business deals with |
| Advance | Cash given to a driver for a trip |
| Settlement | Squaring a driver's advances, expenses and recoveries, periodically |
| Shortage | Cargo lost between loading and offloading, beyond the allowance |
| POD | Proof of delivery |
| Ngwee | 1/100 of a Zambian kwacha (ZMW) |
| Master | A model holding reference data (vehicles, drivers, routes), as opposed to transactions (trips) |
