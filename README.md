# Marichi Fleet ERP backend

The API for Marichi Fleet, a transport ERP for a fuel and cargo haulier working across Zambia, Tanzania and the DRC. Node.js + Express + MongoDB (Mongoose) + Redis, following the Marichi Backend Development Guide (router → controller → service → schema, typed errors, `ApiResponse`, Pino, Zod).

## Repositories

| Repository | What it holds |
| --- | --- |
| [harshtripathi272/fleet_erp](https://github.com/harshtripathi272/fleet_erp) (this one) | The backend API, its tests and the console |
| [laksh-ya/fleet-erp](https://github.com/laksh-ya/fleet-erp) | The clickable frontend mock in [`trip-flow/`](https://github.com/laksh-ya/fleet-erp/tree/main/trip-flow), and the client's material in [`reference/`](https://github.com/laksh-ya/fleet-erp/tree/main/reference) |

Both are private; ask Lakshya for access. **Current priority:** turn the mock into the real frontend, connected to this API: [issue #2](https://github.com/harshtripathi272/fleet_erp/issues/2).

## Contents

**Guides**

- [Setting up on Windows](docs/SETUP-WINDOWS.md): Node, MongoDB, the code, sample data and the console, step by step.
- [Building the React app against this API](docs/FRONTEND.md): connecting a Vite app, sign-in and token refresh, lists, saving, errors.
- [Project context](docs/PROJECT-CONTEXT.md): what we are building, the agreed stack, how we work, the owner's decisions, how the models are organised, UI guidance.
- [Notes for AI assistants](CLAUDE.md): the short version of the rules, for coding assistants working in this repository.

**This page**

- [Repositories](#repositories)
- [What is in it](#what-is-in-it)
- [Run it](#run-it)
- [Environment variables](#environment-variables)
- [Sample data](#sample-data)
- [Test console](#test-console)
- [API conventions](#api-conventions)
- [Masters](#masters)
- [Code layout](#code-layout)
- [Checks](#checks)
- [Production notes](#production-notes)

## What is in it

- **Authentication**: e-mail and password sign-up, sign-in, refresh-token rotation, sign-out (one device or all), change password, forgot/reset password by e-mail (SMTP), account lockout and rate limits.
- **Authorization**: roles with per-master permissions (`read`, `create`, `update`, `archive`, `delete`, `sensitive`). Built-in Owner, Admin, Operations, Finance and Viewer roles, plus custom roles. Nobody can grant permissions they do not hold.
- **The masters** from the MVP column of the masters specification (MF-SPEC-01), plus users and roles. Every master has the same standard behaviour: versioned updates, archive/restore, delete only when unused, audit history, custom fields, branch scope and validity dates.
- **Configuration without code**: simple lists, custom fields on any master, and custom masters with their own records.
- **A console** at `/console/`: a models reference anyone can read, and a signed-in tool for trying every endpoint, browsing records and reading the audit log.

## Run it

Needs Node.js 22 or newer and MongoDB 7 or newer. Redis is optional. On Windows, follow [Setting up on Windows](docs/SETUP-WINDOWS.md); the steps below are the short version.

### Without Docker

Start MongoDB on `127.0.0.1:27017`, then:

```sh
npm ci
cp .env.example .env      # PowerShell: Copy-Item .env.example .env
npm run seed              # optional: loads the sample data
npm run dev               # http://127.0.0.1:3000/console/
```

### With Docker Compose (API + MongoDB + Redis)

```sh
cp .env.example .env
docker compose up --build
```

Either way, the API listens on http://127.0.0.1:3000 and the console is at http://127.0.0.1:3000/console/. **MongoDB Compass** connects to `mongodb://127.0.0.1:27017` with no login and shows the `fleet_erp` database.

On a fresh database, the **first account you create becomes the Owner**. Later sign-ups get the read-only Viewer role, or are refused if the company turns self sign-up off.

## Environment variables

**For local development, nothing has to be set.** Copy `.env.example` to `.env` and the defaults work: MongoDB on `127.0.0.1:27017`, the API on port 3000, a development sign-in secret, and e-mails written to the log instead of sent. `.env` is git-ignored; `.env.example` lists and explains every setting.

Settings you may change locally:

| Setting | Default | Change it to |
| --- | --- | --- |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/fleet_erp` | Use another database, or MongoDB Atlas |
| `PORT` | `3000` | Run on another port |
| `CORS_ORIGINS` | empty | A browser app's address, e.g. `http://localhost:5173`, when it calls the API directly |
| `EXPOSE_RESET_TOKEN` | `false` | `true` to test "Forgot password" without e-mail (refused in production) |
| `REDIS_URL` | empty | A Redis address, to keep rate limits in Redis instead of memory |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` | empty | Real SMTP credentials, to actually send e-mail |

In production the API refuses to start unless `NODE_ENV=production`, a unique `JWT_SECRET` of 32+ characters and `SMTP_HOST` are set; see [Production notes](#production-notes).

## Sample data

`npm run seed`, or **Load sample data** in the console, creates a small, made-up operation through the same validation as the API. Nothing in it is real or confidential:

- Zambia, Tanzania and DR Congo with provinces and cities; places such as the Lusaka fuel depot, Dar es Salaam port, the Ndola yard and the Nakonde and Kasumbalesa borders; a route from Dar es Salaam port to the Lusaka depot.
- Kwacha, US dollar and Tanzanian shilling with exchange rates; cash and mobile-money payment methods.
- A Lusaka head office and an Ndola branch; numbering series for drivers, parties and trips.
- Customers and partners such as Zambezi Energy Ltd and Copperbelt Minerals plc, a leasing financier and a clearing agent.
- A Scania and a Volvo truck, two trailers (a tanker and a flatbed) and a pairing; two drivers; compliance documents.
- Fuel and copper products, trip types and stages, budgets, fuel norms, advance, shortage and recovery rules, message templates and a print layout.

It loads once into an empty database. To start again, delete the `fleet_erp` database in Compass and seed again.

## Test console

`/console/` opens on the **models reference**, which needs no sign-in. It lists every model in four groups, most important first: **Core records** (vehicles, trailers, pairings, drivers, parties, places, routes, products, compliance documents), **Trip rules**, **Reference lists** and **Company setup**. Each model page shows its fields (required first, nested fields indented), what it links to, what uses it, and its rules in plain words; endpoints, indexes, list filters and JSON Schemas are folded underneath. The reference reads `GET /api/v1/meta/models`, which returns structure only (no records) and exists only while `CONSOLE_ENABLED` is on.

**Test the API** leads to sign-in and the testing console:

| Page | What it is for |
| --- | --- |
| API testing | Every endpoint, grouped by sign-in, company, health and model, each ready to send with real ids filled in; response format, limits and error codes. On an empty database, **Load sample data** loads the [sample data](#sample-data). |
| Each model | **Records**: search, filter, sort and page; open a record to read it with linked records shown by name, see its JSON, where it is used and its history; create, edit, archive, restore or delete it. **API**: the model's endpoints. |
| Account | Profile, password, signed-in devices, what your roles allow, the password-reset flow, the access token. |
| Company | The single company record (legal details, base currency, time zone, fiscal year, modules, self sign-up). |
| Audit log | Every create, update, archive, restore and delete, with who did it and what changed. |
| Request log | Every request the console made, with the body sent and the full response. Passwords and tokens are masked. |

The console is plain HTML/CSS/JS served by the API (`public/console`). It builds everything from `/api/v1/meta/*`, so new masters and fields appear without changes to the console.

## API conventions

- Base path `/api/v1`. Every route except `/health` and `/auth/*` needs `Authorization: Bearer <access token>`.
- Responses: `{ success: true, data, meta?, message? }` or `{ success: false, error: { code, message, details? }, requestId }`.
- **Lists** (`GET /api/v1/<master>`): `page`, `limit` (1–100), `search`, `status` (`active`, `inactive`, `archived`, `all`; default hides archived), `sort` (`field` or `-field`), `updatedSince`, and master-specific filters. Unknown parameters are rejected.
- **Create** (`POST`), **update** (`PATCH /:id`, must include the current `version`; a stale version returns 409; `null` clears optional fields), **archive** / **restore** (`POST /:id/archive`, `/:id/restore`), **delete** (`DELETE /:id`, only when nothing references the record), **usage** (`GET /:id/usage`), **history** (`GET /:id/history`).
- Money is `{ amountMinor, currencyId }` in minor units (ngwee, cents). Dates are `YYYY-MM-DD` or ISO 8601 with a time zone.
- Bodies are strict: unknown fields return 422, and keys that start with `$` or contain `.` return 400. Body size is limited to 1 MB.

## Masters

| Area | Masters (URL path) |
| --- | --- |
| Organisation and access | `branches`, `numbering-series`, `approval-policies`, `users`, `roles`, plus `/company` |
| Geography and routes | `countries`, `provinces`, `cities`, `places` (+ `/near`), `border-posts`, `routes`, `units`, `unit-conversions` (+ `/convert`) |
| Money and tax | `currencies`, `exchange-rates` (+ `/convert`), `payment-methods` |
| Customers and partners | `parties`, `order-sources` |
| Vehicles and equipment | `vehicle-makes`, `vehicle-models`, `vehicle-types`, `vehicles`, `trailer-types`, `trailers`, `pairings` (+ pair / end) |
| Drivers | `licence-classes`, `drivers`, `recovery-rules` |
| Compliance and documents | `document-types`, `permit-types`, `insurance-types`, `compliance-documents` (+ `/expiring`, `/check`) |
| Cargo | `product-groups`, `products`, `load-types`, `shortage-policies`, `pod-types` |
| Trip operations | `trip-types`, `trip-stages`, `stop-types`, `expense-categories`, `expense-items`, `fuel-types`, `fuel-norms`, `trip-budgets` (+ `/estimate`), `advance-policies`, `cancellation-reasons` |
| Messages and layouts | `message-templates` (+ `/:id/preview`; WhatsApp and SMS through Marichi Talks, e-mail through SMTP), `notification-rules`, `print-layouts` |
| Configuration | `lists` (+ `/by-code/:code`), `field-definitions`, `custom-masters` (+ `/:masterId/records`) |

## Code layout

```
src/
  app.ts, server.ts           Express app; start-up, graceful shutdown
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
public/console/               the test console
tests/                        node:test + supertest on an in-memory MongoDB
```

The generic engine gives every master the same routes and checks. Each module adds its own model, request schema and business rules (`prepare` hooks), plus any custom endpoints.

## Checks

```sh
npm run check     # typecheck, all tests, production build
npm test
```

The tests run on their own temporary MongoDB (not your `fleet_erp` database) and cover:

- authentication and authorization, including privilege escalation;
- a contract run against every master;
- business rules for every area;
- concurrency races (duplicate codes, numbering, versions, pairings);
- load, size limits and hostile input;
- a fuzzer that sends random input to every endpoint and fails on any 500.

## Production notes

- Set `NODE_ENV=production`, a random `JWT_SECRET` of 32+ characters, and the SMTP credentials. The API refuses to start without them, and refuses `EXPOSE_RESET_TOKEN=true`.
- Set `REDIS_URL` when running more than one API instance, so rate limits are shared.
- Set `CORS_ORIGINS` to the React app's origin, and `TRUST_PROXY` when behind a reverse proxy.
- MongoDB runs as an ordinary standalone server; no replica set is needed. Writes are single-document; concurrency is enforced with unique and partial indexes and optimistic versioning.
