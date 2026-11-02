# Marichi Fleet

Marichi Fleet is a configurable transport ERP for haulage companies. Its first client is Marichi Connect Logistics, which runs fuel and cargo trucks across Zambia, Tanzania and the DRC. This repository is its **backend API**: Node.js, Express, MongoDB (Mongoose) and Redis.

This README is the one place for setup, context and the API. **The next piece of work is described in [issue #2](https://github.com/harshtripathi272/fleet_erp/issues/2).**

## The founding principle: configurable without limits

Marichi Fleet is built for **one company at a time**: each installation runs one company, with its own database. It is not a system for managing several companies at once. It is multi-tenant only in that sense: many customer companies, each with its own separate copy and database, never sharing one. But it is meant to be sold to many transport companies, each working differently, and we do not know in advance how any of them works. So this codebase is a **base** that becomes whatever a company needs, mostly through configuration and, where needed, easy additions on top:

- **Everything a company might do differently is configuration, not code.** Approvals, policies, workflows, trip steps, fields, lists, record types, roles, numbering, messages, documents, notifications, and whatever comes up next. Each has sensible defaults and no limit on what a company can add or change.
- **A client's rules are that client's settings.** The first client's decisions (below) ship as defaults; another company can change every one of them.
- **Setting up a new company is easy:** a new installation, its own settings and data, and small additions where its way of working needs them, without changing the core.
- **It deploys anywhere with little effort:** GCP, any other cloud or a single server. The API is one container image configured only by environment variables, and MongoDB can be hosted anywhere. See [Deploying a company's copy](#deploying-a-companys-copy).
- **It scales without a ceiling** within a company: any number of branches, records, fields and options.

When building anything, ask: *could another company want this differently?* If yes, make it a setting with a sensible default rather than a value in the code.

## Contents

1. [The founding principle](#the-founding-principle-configurable-without-limits)
2. [Where things stand](#where-things-stand)
3. [Project context](#project-context)
4. [Set up and run](#set-up-and-run)
5. [The console](#the-console)
6. [Using the API from a frontend](#using-the-api-from-a-frontend)
7. [Masters and their endpoints](#masters-and-their-endpoints)
8. [Code layout](#code-layout)
9. [Tests and checks](#tests-and-checks)
10. [Deploying a company's copy](#deploying-a-companys-copy)

## Where things stand

| Piece | Where | State |
| --- | --- | --- |
| Backend: sign-in, roles, every MVP master, console | This repository, branch `main` | Done and tested |
| Clickable mock of the whole trip flow (Owner, Operations and Finance desks, and the driver's WhatsApp) | [laksh-ya/fleet-erp](https://github.com/laksh-ya/fleet-erp), folder [`trip-flow/`](https://github.com/laksh-ya/fleet-erp/tree/main/trip-flow) | Done; the reference for screens and flow |
| Client material: PRD, master sheets, meeting notes with the owner's answers, competitor decks | [laksh-ya/fleet-erp](https://github.com/laksh-ya/fleet-erp), folder [`reference/`](https://github.com/laksh-ya/fleet-erp/tree/main/reference) | Reference |
| **Next: the real frontend, connected to this API, starting with the masters** | [Issue #2](https://github.com/harshtripathi272/fleet_erp/issues/2) | **Current priority** |
| Trips and money (nominations, trips, advances, fuel, loading and offloading, expenses, settlement) | Part of issue #2 | Not started |

Repositories:

| Repository | What it holds |
| --- | --- |
| [harshtripathi272/fleet_erp](https://github.com/harshtripathi272/fleet_erp) (this one) | The backend API, its tests and the console |
| [laksh-ya/fleet-erp](https://github.com/laksh-ya/fleet-erp) | The frontend mock (`trip-flow/`) and the client's material (`reference/`) |

Both are private; ask Lakshya for access. The folder names differ only by `_` and `-`: `fleet_erp` is this backend, `fleet-erp` the mock.

What the backend does today:

- **Sign-in**: e-mail and password sign-up, sign-in, refresh-token rotation, sign-out (one device or all), change password, forgot and reset password by e-mail, account lockout and rate limits.
- **Permissions**: roles with per-master rights (`read`, `create`, `update`, `archive`, `delete`, `sensitive`). Built-in Owner, Admin, Operations, Finance and Viewer roles, plus custom roles. Nobody can grant rights they do not hold.
- **Masters**: every master in the MVP column of the masters specification (MF-SPEC-01), with the same behaviour for all: versioned updates, archive and restore, delete only when unused, audit history, custom fields, branch scope and validity dates.
- **Configuration without code**: lists, custom fields on any master, and custom masters with their own records.
- **A console** at `/console/`: a models reference anyone can read, and a signed-in tool for every endpoint, the records and the audit log.

## Project context

**What is settled:** the founding principle above, the stack and how we work. **What is open:** everything else here (how models are grouped, screen layouts, UI guidance, code suggestions) is the current thinking, to be discussed and improved. When something is unclear, or a task seems to need a different approach, ask.

### The stack

| Layer | Choice |
| --- | --- |
| Frontend | React, TanStack (Query, Router, Table, Form), shadcn/ui |
| Backend | Node.js, Express, TypeScript |
| Database | MongoDB with Mongoose |
| Cache and rate limits | Redis (optional locally) |
| Code structure | Models → Route → Controller → Service, per the Marichi backend coding guide; Zod for validation, Pino for logs |
| WhatsApp and SMS | Marichi Talks, the parent company's messaging service |
| E-mail | SMTP credentials (Mandrill) |
| Deployment | Docker Compose |

How the stack has been used so far, and why:

- **It was agreed as a set.** If something new seems needed (a library, a service, a pattern), propose it and discuss it first, so the team keeps one shared picture.
- **A traditional MERN setup.** MongoDB runs as a plain standalone server, without a replica set or multi-document transactions, to keep hosting simple. Duplicates and races are prevented with unique indexes and a `version` on every record instead.
- **Sign-in is our own** e-mail and password (scrypt hashes and signed tokens from Node's crypto module), so there is no third-party auth dependency for now.

### How we work

- Work happens on `main`. `npm run check` (type-check, tests, build) passes before a push.
- The next requirements are tracked in issues; [issue #2](https://github.com/harshtripathi272/fleet_erp/issues/2) is the current one.
- Secrets live only in `.env`, which is never committed. `.env.example` lists every setting.

### The first client's settings (owner meeting of 20 September 2026)

These are how the first client works. They ship as **defaults**, and every one of them is configurable for other companies.

1. **Trips start from the truck.** Choose the truck first; its trailer and driver follow.
2. **Driver settlement is periodic**, across several trips, not per trip.
3. **Fuel cargo is corrected for temperature and density to 20 °C**, with an allowance of about 3%. Loss beyond the allowance is charged to the driver.
4. **Drivers work over WhatsApp.** They do not sign in to the system.
5. **Approvals can go up to the owner over WhatsApp.**

### How the models are organised

The models are shown in four groups, most important first. The grouping is a presentation choice for discussion; it lives in one list (`TIERS` in `public/console/app.js`), and a model missing from that list appears under Reference lists automatically.

1. **Core records**: what a trip is made of. Vehicles, Trailers, Truck–trailer pairings, Drivers, Parties, Places, Routes, Products, Compliance documents.
2. **Trip rules**: how a trip runs and is paid for. Trip types and stages, stop types, trip budgets, fuel norms, advance policies, expense categories and items, shortage policies, recovery rules, border posts, load types, proof-of-delivery types, cancellation reasons.
3. **Reference lists**: lookups that keep values consistent. Vehicle makes, models and types; trailer types; licence classes; document, permit and insurance types; product groups; fuel types; countries, provinces, cities; units and conversions; currencies and exchange rates; payment methods; order sources.
4. **Company setup**: branches, users, roles, numbering series, approval policies, message templates, notification rules, print layouts, lists, custom fields, custom masters.

Why some models are shaped the way they are:

- **Truck and trailer are separate**, joined by a **pairing** with history. Each has its own plate, insurance and permits, and trailers move between trucks. A truck or trailer can be in only one open pairing at a time.
- **Drivers are not users**, because they work over WhatsApp. Their ID, passport and bank details are masked for roles without permission.
- **Parties is one model with roles** (customer, consignor, consignee, supplier, broker, clearing agent, hired transporter, financier, dealer), because one company is often several of these. Links check the role: a vehicle's owner must be a hired transporter, financier or dealer.
- **Places and routes:** a place is any point a truck stops at; a route is an ordered list of places with leg distances, from which budgets and fuel figures are worked out.
- **Products carry density and a reference temperature** for the fuel correction rule.
- **Compliance documents** hold every document actually held, by a truck, trailer, driver, party or the company, so expiry is checked in one place.
- **Border posts are separate from places** because they carry fees, waiting times and clearing agents.
- **Lists, custom fields and custom masters** let a company add its own data without code changes.

What every master does the same way:

- Archive instead of delete; delete only when nothing refers to the record.
- Every update carries the `version` it was based on; a stale one is refused (409), so two people cannot overwrite each other.
- Every change goes into the audit log, with who made it and what changed.
- Linked records must exist and be active when a record is saved.
- Money is stored in whole minor units (ngwee, cents) with its currency, so amounts never round.
- Every record can be limited to branches and has validity dates, tags, notes, attachments and custom fields.

### UI guidance

What earlier feedback on the mock and the console liked and rejected. Treat it as guidance; when a screen needs something different, discuss it.

Liked so far:

- Important things first: core records and required fields at the top, supporting items lower, tools and documentation on their own pages.
- A formal, calm look: paper-coloured canvas, pine-green sidebar, Instrument Sans, framed tables. Realistic where it matters (printed documents, receipts, the WhatsApp phone). The mock and `public/console` show it.
- Screens that also work on a phone, with labelled buttons.

Rejected so far, usually as cluttered or "AI-looking":

- Small all-caps labels above headings; explanatory subtitles or developer notes in the interface.
- Two controls for the same thing on one screen.
- "Live" badges, pulsing dots, emojis, decorative illustrations.
- Effects that only appear on hover, such as link lines drawn on hover. A plain toggle went down better.

### Words used in this project

| Word | Meaning |
| --- | --- |
| Master | A model holding reference data (vehicles, drivers, routes), as opposed to transactions (trips) |
| Horse, prime mover | The truck that pulls a trailer |
| Pairing | Which trailer is hitched to which truck, and since when |
| Party | Any company or person the business deals with |
| Nomination | A customer's order naming trucks for a load |
| Advance | Cash given to a driver for a trip |
| Settlement | Squaring a driver's advances, expenses and recoveries, periodically |
| Shortage | Cargo lost between loading and offloading, beyond the allowance |
| POD | Proof of delivery |
| Ngwee | 1/100 of a Zambian kwacha (ZMW) |

## Set up and run

You need Node.js 22 or newer, Git and MongoDB 7 or newer. Redis is optional. Nothing from another machine is needed.

### Quick start (any system)

With MongoDB running on `127.0.0.1:27017`:

```sh
git clone https://github.com/harshtripathi272/fleet_erp.git
cd fleet_erp
npm ci
cp .env.example .env      # PowerShell: Copy-Item .env.example .env
npm run seed              # optional: loads the sample data
npm run dev
```

Open **http://127.0.0.1:3000/console/**. In the console, **Test the API → Create account**. On a fresh database the **first account becomes the Owner**. Later sign-ups get the read-only Viewer role, or are refused if the company turns self sign-up off.

Or run the API, MongoDB and Redis together with Docker Compose:

```sh
cp .env.example .env
docker compose up --build
```

### Step by step on Windows

Commands are for **PowerShell** (Start menu → "Windows PowerShell" or "Terminal").

**1. Install the tools.** `winget` comes with Windows 10 (since 2021) and Windows 11:

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id MongoDB.Server -e
winget install --id MongoDB.Compass.Full -e
```

If `winget` is missing, use the installers: [Git](https://git-scm.com/download/win), [Node.js LTS](https://nodejs.org/en/download), [MongoDB Community Server](https://www.mongodb.com/try/download/community) (keep **Install MongoDB as a Service** ticked, and tick **Install MongoDB Compass**).

Close PowerShell, open a new one, and check `git --version`, `node --version` (22 or newer) and `npm --version`. If `npm` says *running scripts is disabled on this system*, run this once and open a new PowerShell:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

**2. Get the code** (Git asks you to sign in to GitHub the first time):

```powershell
cd $HOME\Documents
git clone https://github.com/harshtripathi272/fleet_erp.git
git clone https://github.com/laksh-ya/fleet-erp.git
cd fleet_erp
```

**3. Install and configure:**

```powershell
npm ci
Copy-Item .env.example .env
```

**4. Check MongoDB is running.** It installs as a Windows service that starts with Windows. In **Services**, **MongoDB Server** should show *Running*; if not, start it there, or run `net start MongoDB` in an administrator PowerShell.

Instead of installing MongoDB, Docker Desktop works too: `docker compose up -d mongo` runs only the database, and `npm run dev` stays the same. Use one or the other; both want port 27017.

**5. Load the sample data and run:**

```powershell
npm run seed
npm run dev
```

Leave that window open; the API restarts when you save a file. Open **http://127.0.0.1:3000/console/**.

**6. Look at the data.** MongoDB Compass → **Add new connection** → keep `mongodb://localhost:27017` → **Connect** (no login). The `fleet_erp` database has one collection per model.

**7. Run the checks:** `npm run check`. The tests use their own temporary MongoDB, not `fleet_erp`; the first run downloads it (about 100 MB).

**Run the mock as well** (it keeps demo data in the browser and does not use the API yet):

```powershell
cd $HOME\Documents\fleet-erp\trip-flow
npm install
npm run dev
```

### Environment variables

**For local development, nothing has to be set.** Copy `.env.example` to `.env` and the defaults work: MongoDB on `127.0.0.1:27017`, the API on port 3000, a development sign-in secret, and e-mails written to the log instead of sent. `.env` is git-ignored; `.env.example` explains every setting.

Settings you may change:

| Setting | Default | Change it to |
| --- | --- | --- |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/fleet_erp` | Another database, or MongoDB Atlas |
| `PORT` | `3000` | Another port |
| `CORS_ORIGINS` | empty | A browser app's address, e.g. `http://localhost:5173`, when it calls the API directly |
| `EXPOSE_RESET_TOKEN` | `false` | `true` to test "Forgot password" without e-mail; the token comes back in the response (refused in production) |
| `REDIS_URL` | empty | A Redis address, to keep rate limits in Redis instead of memory |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` | empty | Real SMTP credentials, to send e-mail |

In production the API refuses to start without the settings in [Deploying a company's copy](#deploying-a-companys-copy).

### Sample data

`npm run seed`, or **Load sample data** in the console, creates a small, made-up operation through the same validation as the API. Nothing in it is real or confidential:

- Zambia, Tanzania and DR Congo with provinces and cities; places such as the Lusaka fuel depot, Dar es Salaam port, the Ndola yard and the Nakonde and Kasumbalesa borders; a route from Dar es Salaam port to the Lusaka depot.
- Kwacha, US dollar and Tanzanian shilling with exchange rates; cash, mobile-money and depot-fuel payment methods.
- A Lusaka head office and an Ndola branch; numbering series for drivers, parties and trips.
- Customers and partners such as Zambezi Energy Ltd, Copperbelt Minerals plc, Tunduma Clearing & Forwarding and Afri Asset Leasing.
- A Scania and a Volvo truck, a tanker and a flatbed trailer, a pairing, two drivers and compliance documents.
- Fuel and copper products, trip types and stages, a budget, fuel norms, advance, shortage and recovery rules, message templates and a print layout.

It loads once into an empty database. To start again, delete the `fleet_erp` database in Compass and seed again.

### When something goes wrong

| What you see | What to do |
| --- | --- |
| `MongooseServerSelectionError` or `ECONNREFUSED 127.0.0.1:27017` | MongoDB is not running; start it |
| `EADDRINUSE` on port 3000 | Another `npm run dev` is running; close it, or set `PORT` in `.env` |
| `running scripts is disabled on this system` | Run the `Set-ExecutionPolicy` line above |
| `'node' is not recognized` | Open a new PowerShell after installing Node |
| A new sign-up is only a Viewer | The first account already exists in this database; sign in as it, or start over with an empty database |
| The browser blocks the frontend's requests (CORS) | Use the Vite proxy in [Connecting](#connecting), or set `CORS_ORIGINS` and restart the API |

## The console

`/console/` is plain HTML, CSS and JavaScript served by the API (`public/console`). It builds itself from `/api/v1/meta/*`, so new masters and fields appear without changes to it.

- **Models** (no sign-in): every model in the four groups, with its fields (required first), what it links to, what uses it, its rules in plain words, and folded endpoints and indexes. It reads `GET /api/v1/meta/models`, which returns structure only, no records, and exists only while `CONSOLE_ENABLED` is on.
- **Test the API** (after sign-in):

| Page | What it is for |
| --- | --- |
| API testing | Every endpoint, grouped by sign-in, company, health and model, each ready to send with real ids filled in; response format, limits and error codes. On an empty database, **Load sample data**. |
| Each model | **Records**: search, filter, sort and page; open a record to read it with linked records shown by name, see its JSON, where it is used and its history; create, edit, archive, restore or delete. **API**: the model's endpoints. |
| Account | Profile, password, signed-in devices, what your roles allow, the password-reset flow, the access token |
| Company | The single company record: legal details, base currency, time zone, fiscal year, modules, self sign-up |
| Audit log | Every create, update, archive, restore and delete, with who and what changed |
| Request log | Every request the console made, with the body sent and the full response; passwords and tokens masked |

## Using the API from a frontend

How the API behaves is set by the backend as it is today. How the frontend is organised (proxy, wrappers, folders) is up to the person building it; the code below is a suggestion.

### Connecting

The Vite dev proxy lets the browser talk to one address, so CORS needs no setup:

```ts
// vite.config.ts
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
});
```

The app calls `/api/v1/...` and Vite forwards it to the API. To call the API directly instead, set `CORS_ORIGINS=http://localhost:5173` in the API's `.env` and restart it.

### Describing the models

`GET /api/v1/meta/models` (no sign-in) returns every master: fields with type, required, choices, defaults, the master each link points to, unique fields, list filters and endpoints. Every master also shares the same endpoints. Together these allow one generic list, detail and form screen to serve every master, including custom fields and custom masters added later. Signed in, `GET /api/v1/meta/masters` returns the same with the caller's own permissions per master.

### Sign-in

| Call | Body | Returns |
| --- | --- | --- |
| `POST /api/v1/auth/register` | `{ name, email, password }` | tokens, plus `firstOwner: true` for the first account |
| `POST /api/v1/auth/login` | `{ email, password }` | tokens |
| `POST /api/v1/auth/refresh` | `{ refreshToken }` | new tokens; the old refresh token stops working |
| `GET /api/v1/auth/me` | | the user, their roles and permissions |
| `PATCH /api/v1/auth/me` | `{ name?, phone? }` | the updated profile |
| `POST /api/v1/auth/change-password` | `{ currentPassword, newPassword }` | new tokens; other devices are signed out |
| `POST /api/v1/auth/logout` and `/logout-all` | | ends this session, or every session |
| `POST /api/v1/auth/forgot-password` | `{ email }` | always succeeds, so it cannot be used to probe e-mails |
| `POST /api/v1/auth/reset-password` | `{ token, password }` | |

Tokens come back as `{ accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt }`. Passwords are 8–128 characters with at least one letter and one digit.

- Send `Authorization: Bearer <accessToken>` on every call except `/health`, `register`, `login`, `refresh`, `forgot-password`, `reset-password` and `/meta/models`.
- The access token lasts 15 minutes. On a `401`, call `/auth/refresh` once, store the new pair, and retry. If the refresh fails, return to sign-in.
- Refresh tokens are single use. Reusing an old one ends that device's session, as a stolen-token defence, so parallel requests should share one refresh rather than each refreshing.
- A password reset or "sign out everywhere" ends every session of that user.
- `GET /auth/me` permissions tell the screen what to hide; the API checks again either way.

### Records

Every master has the same endpoints:

| Call | Notes |
| --- | --- |
| `GET /api/v1/<master>` | `page`, `limit` (1–100), `search`, `status` (`active`, `inactive`, `archived`, `all`; archived hidden by default), `sort` (`field` or `-field`), `updatedSince`, and the master's own filters. Unknown parameters are rejected. |
| `GET /api/v1/<master>/:id` | one record |
| `POST /api/v1/<master>` | create |
| `PATCH /api/v1/<master>/:id` | only what changed, plus the `version` you loaded; `null` clears an optional field |
| `POST /api/v1/<master>/:id/archive` and `/restore` | archive (optional `{ reason }`) and restore |
| `DELETE /api/v1/<master>/:id` | only when nothing refers to the record |
| `GET /api/v1/<master>/:id/usage` | what refers to it |
| `GET /api/v1/<master>/:id/history` | every change: who, when, from and to |

Responses:

```json
{ "success": true, "data": [], "meta": { "page": 1, "limit": 20, "total": 54, "totalPages": 3, "hasNextPage": true, "hasPrevPage": false } }
```

```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Validation failed", "details": {} }, "requestId": "…" }
```

What a screen has to handle:

| Status | Code | When |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | Malformed JSON, keys starting with `$` or containing `.` |
| 401 | `UNAUTHORIZED` | Missing, expired or revoked token; wrong e-mail or password |
| 403 | `FORBIDDEN` | The role lacks the permission; account deactivated |
| 404 | `NOT_FOUND` | Record or route does not exist |
| 409 | `CONFLICT` | Stale `version` (someone saved first), a duplicate unique value, or a record still in use |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 1 MB |
| 422 | `VALIDATION_ERROR` | A field or business rule failed; `details` names each field |
| 429 | `TOO_MANY_REQUESTS` | Rate limit, or the account is temporarily locked after failed sign-ins |

Formats:

- **Money** is `{ amountMinor, currencyId }` in whole minor units: K 1,250.50 is `amountMinor: 125050` with the ZMW currency's id. Divide by `10^minorUnits` of the currency to show it.
- **Dates** are `YYYY-MM-DD` for calendar dates (expiry, birthday) or ISO 8601 date-times with a time zone.
- **Links** are record ids. A dropdown loads the linked master's list, e.g. `GET /api/v1/parties?search=zam&status=active`.
- **Bodies are strict:** unknown fields are rejected with 422.

A possible fetch wrapper with TanStack Query:

```ts
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getAccessToken()}`, ...init.headers },
  });
  const body = await res.json();
  if (!res.ok) throw Object.assign(new Error(body.error?.message ?? res.statusText), { status: res.status, ...body.error });
  return body as T;
}

const vehicles = useQuery({
  queryKey: ['vehicles', { page, search }],
  queryFn: () => api<{ data: Vehicle[]; meta: PageMeta }>(`/vehicles?page=${page}&search=${encodeURIComponent(search)}`),
});
```

The 401 → refresh → retry step belongs inside `api()`.

## Masters and their endpoints

| Area | Masters (URL path under `/api/v1`) |
| --- | --- |
| Organisation and access | `branches`, `numbering-series` (+ `/:id/preview`, `/:id/next`), `approval-policies`, `users` (+ `/:id/revoke-sessions`, `/:id/unlock`), `roles`, plus `/company` |
| Geography and routes | `countries`, `provinces`, `cities`, `places` (+ `/near`), `border-posts`, `routes`, `units`, `unit-conversions` (+ `/convert`) |
| Money and tax | `currencies`, `exchange-rates` (+ `/convert`), `payment-methods` |
| Customers and partners | `parties`, `order-sources` |
| Vehicles and equipment | `vehicle-makes`, `vehicle-models`, `vehicle-types`, `vehicles`, `trailer-types`, `trailers`, `pairings` (pair with `POST`, end with `/:id/end`) |
| Drivers | `licence-classes`, `drivers`, `recovery-rules` |
| Compliance and documents | `document-types`, `permit-types`, `insurance-types`, `compliance-documents` (+ `/expiring`, `/check`) |
| Cargo | `product-groups`, `products`, `load-types`, `shortage-policies`, `pod-types` |
| Trip operations | `trip-types`, `trip-stages`, `stop-types`, `expense-categories`, `expense-items`, `fuel-types`, `fuel-norms`, `trip-budgets` (+ `/estimate`), `advance-policies`, `cancellation-reasons` |
| Messages and layouts | `message-templates` (+ `/:id/preview`), `notification-rules`, `print-layouts` |
| Configuration | `lists` (+ `/by-code/:code`), `field-definitions`, `custom-masters` (+ `/:masterId/records`) |
| Other | `/health`, `/auth/*`, `/audit-logs`, `/meta/models`, `/meta/masters`, `/meta/overview`, `/meta/stats`, `/meta/sample-data` |

The models reference in the console lists each master's fields and rules; `/meta/models` returns them as JSON.

## Code layout

```
src/
  app.ts, server.ts           Express app; start-up and graceful shutdown
  config/env.ts               every setting, validated (production refuses unsafe values)
  core/
    masters/                  the shared master engine: base fields, registry, reference
                              checks, custom fields, audit, generic service/controller/router
    security/                 scrypt password hashing and HS256 tokens (Node's crypto module)
    rateLimit/                fixed-window limits in Redis, or in memory without Redis
    mail/, cache/, db/, errors/, logger/, response/
  middleware/                 authenticate, authorize, validate, CORS, security headers, ...
  modules/<area>/
    models/*.model.ts         Mongoose models
    <area>.schema.ts          Zod request schemas
    <area>.service.ts         master definitions and business rules
    <area>.controller.ts      handlers for custom endpoints
    <area>.router.ts          routes
  modules/meta/sampleData.ts  the sample data
scripts/seed.ts               npm run seed
public/console/               the console
tests/                        node:test + supertest on a temporary in-memory MongoDB
```

The generic engine gives every master the same routes and checks. A new master is a Mongoose model, a Zod schema and a master definition in its module's service, mounted with `createMasterRouter` in the module's router. It then appears in the API, the console and `/meta/models` without other changes.

## Tests and checks

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs the API on port 3000 and restarts on save |
| `npm run seed` | Loads the sample data into the database in `MONGODB_URI` |
| `npm test` | Runs the tests |
| `npm run check` | Type-check, tests and production build; run before every push |

The tests run on their own temporary MongoDB and cover:

- sign-in and permissions, including attempts to grant yourself more rights;
- a contract run against every master;
- the business rules of every area;
- races: duplicate codes, numbering, versions, pairings;
- load, size limits and hostile input;
- a fuzzer that sends random input to every endpoint and fails on any server error.

## Deploying a company's copy

Each company gets its own copy: its own API and its own MongoDB database. Nothing in the code is tied to a cloud provider.

**What the API needs anywhere:**

- The container image built from the `Dockerfile` (or Node.js 22 running `npm ci && npm run build && npm start`).
- A MongoDB database for that company: [MongoDB Atlas](https://www.mongodb.com/atlas) on any cloud, or MongoDB on a server.
- Environment variables, at least: `MONGODB_URI`, a random `JWT_SECRET` of 32+ characters (e.g. `openssl rand -base64 48`), `APP_URL` (the public address, used in reset links), `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` and `SMTP_FROM`. The image already sets `NODE_ENV=production` and listens on `0.0.0.0` and the `PORT` the platform provides. Keep secrets in the platform's secret store rather than in plain settings.
- Behind the platform's load balancer or reverse proxy, set `TRUST_PROXY=1`. Set `CORS_ORIGINS` to the frontend's address if it is served from a different one.
- With more than one API instance, set `REDIS_URL` so rate limits are shared.
- The platform's health check can use `GET /api/v1/health/ready`, which fails while the database is unreachable.
- Logs are JSON on standard output, so the platform's log viewer picks them up.

**Example: Google Cloud.** Two common ways, as examples rather than the only options:

- **Cloud Run with MongoDB Atlas.** From the repository folder, deploy one service per company. Cloud Build builds the image from the `Dockerfile`:

  ```sh
  gcloud run deploy fleet-<company> --source . --region <region> \
    --set-env-vars "TRUST_PROXY=1,APP_URL=https://<address>,SMTP_HOST=smtp.mandrillapp.com,SMTP_FROM=<from address>" \
    --set-secrets "MONGODB_URI=<company>-mongodb-uri:latest,JWT_SECRET=<company>-jwt-secret:latest,SMTP_USER=<company>-smtp-user:latest,SMTP_PASS=<company>-smtp-pass:latest"
  ```

  The secrets live in Secret Manager. Add `REDIS_URL` (Memorystore) if the service scales past one instance.
- **One VM (Compute Engine) with Docker Compose.** Install Docker, copy the repository and a filled-in `.env`, and run `docker compose up -d --build`. That runs the API, MongoDB and Redis together on one machine, the same way as locally. Back up the `mongo-data` volume.

The same pieces work on AWS, Azure, DigitalOcean or any server that runs containers.

**Settings for production:**

- Set `NODE_ENV=production`, a random `JWT_SECRET` of 32+ characters (e.g. `openssl rand -base64 48`) and the SMTP settings. The API refuses to start without them, and refuses `EXPOSE_RESET_TOKEN=true`.
- Set `REDIS_URL` when running more than one API instance, so rate limits are shared.
- Set `CORS_ORIGINS` to the frontend's address, and `TRUST_PROXY` when behind a reverse proxy.
- Consider `CONSOLE_ENABLED=false` in production; it also removes the public `/meta/models` route.
- MongoDB runs as an ordinary standalone server; no replica set is needed.
