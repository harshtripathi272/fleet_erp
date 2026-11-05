# Features

Every feature of the product: what is built, what is being built, what is planned, and what a transporter will need that has no issue yet. Kept current by the orchestrator; each row links to its issue. The goal behind all of it is in the README's founding principle and in #55: **any company switches on, configures and connects what it needs, without code changes.**

**States**

- **Built**: merged on `develop`, tested.
- **Building**: an agent is on it (issue in progress or in review).
- **Planned**: an issue exists, with an owner or ready to take.
- **Proposed**: needed in real use, no issue yet. The orchestrator files it when it comes up.
- **Needs work**: built, but a known gap remains (the note says which).

Owners: LD = lakshya-desktop, LT = lakshya-t3, HD = harsh-desktop, HT = harsh-t3.

## Configuration: the company shapes the product

| Feature | State | Issue | Notes |
| --- | --- | --- | --- |
| Masters engine: every master works the same way (versions, archive and restore, delete only when unused, history) | Built | #12 | 59 masters |
| Custom fields on any master | Built | — | Now edited from Customise (#65) |
| Custom masters with their own records | Built | — | Moves into the master of masters in #68 |
| Simple lists (blood groups, colours…) | Built | — | Choice lists for any field |
| Master of masters: rename, hide, require, default, order and section every field; rename, reorder and retire choices; rename masters | Built | #65 | Phase 1 of `docs/entities.md` |
| Company fields on trips, requests, expenses, loadings and settlements, asked at the right step | Planned | #67 | Phase 2 |
| Custom masters in the same editor; references to any record type; field permissions by role; saved list views | Planned | #68 | Phase 3 |
| Safe field type changes, definition history, copy a company's configuration | Planned | #69 | Phase 4 |
| Areas switch whole features on and off (masters, desks, menus, messages follow) | Building | #56 | LD, PR #66 |
| Company vocabulary: rename Trip, Nomination, Driver… everywhere | Planned | #73 | LD |
| Trip stages from the master: rename, switch off, reorder | Planned | #73 | LD; today the web stage bar is fixed |
| Desks from configuration: names, menus, which roles see them | Planned | #73 | LD |
| Policies instead of hard-coded rules (every business choice is a setting with a default) | Building | #55 | The pattern every issue follows |
| First-run set-up page: what a first trip needs, with counts, Open and Import | Built | #45 | |
| Import any master from a spreadsheet, with a dry run | Built | #41 | Follows the company's field names (#65) |
| Export any master to a spreadsheet | Proposed | — | |
| Company setup kit: configure once, download a deployable package | Building | #76 | Compose and Google Cloud tested; AWS, Azure, Render, Fly and Railway scripted, not yet tested in CI |

## Brand, region and language

| Feature | State | Issue | Notes |
| --- | --- | --- | --- |
| White-label: product name, logo (light and dark), icon, accent colour, e-mail sender, message signature | Building | #71 | LD; server side under way |
| Watermark on trip sheets, statements, invoices and screens; automatic "TEST" on test installations | Building | #71 | LD |
| No "Marichi" anywhere outside sample data | Building | #71 | A test enforces it |
| Regional settings: time zone, date, time and number formats, financial year, phone prefix | Planned | #72 | HT; today date format and financial year change nothing |
| No currency code, locale or country hard-coded in code | Planned | #72 | HT; ZMW appears in 30+ places, `en-GB` in 9 server files |
| Languages: translation layer, English and French first, per user, driver and customer | Planned | #74 | HD |
| Right-to-left languages | Proposed | — | |

## Accounts and access

| Feature | State | Issue | Notes |
| --- | --- | --- | --- |
| E-mail and password sign-in, refresh tokens, sign out everywhere, lockout, rate limits | Built | — | |
| Invitations by e-mail, forgot and reset password by e-mail | Built | — | |
| Roles with access levels per area (None, See, Edit, Manage, Full) and sensitive fields | Built | #51 | Replaced 400 tick boxes |
| Built-in roles: Owner, Administrator, Operations, Finance, Viewer; copy to make your own | Built | — | |
| Nobody grants access they don't have; the last owner can't be removed | Built | — | |
| Driver accounts: phone and password, own work only | Built | #5 | |
| Self sign-up as Viewer (a company setting) | Built | — | |
| Branch access: staff limited to their branches; trips carry a branch | Planned | #57 | LD |
| Sign-in by one-time code (SMS, WhatsApp, e-mail) | Planned | #57 | LD |
| Password reset by phone, for drivers with no e-mail | Planned | #57 | LD |
| Invitations by e-mail, SMS or WhatsApp | Planned | #57 | LD |
| Password and session policy (length, expiry, lockout, idle sign-out) | Planned | #57 | LD |
| Two-step sign-in (authenticator app), required by role | Planned | #58 | LD |
| Customer portal accounts (an area): customers follow their own loads, delivery proof and invoices | Planned | #58 | LD |
| API keys for other systems | Planned | #58 | LD |
| Single sign-on (Google Workspace, Microsoft Entra) through connections | Proposed | — | |
| Audit log screen, filters, CSV download, a record's history | Built | #36 | |

## Trips and operations

| Feature | State | Issue | Notes |
| --- | --- | --- | --- |
| Nominations from customers, accepted into trips | Built | — | |
| Trip from the truck: paired trailer and usual driver fill in | Built | — | A company setting |
| Trip stages: plan, funding, loading, transit, offloading, close, settlement | Built | — | Fixed in the web app until #73 |
| Loading and delivery measured and corrected to 20 °C, with density checks | Built | — | Liquids only until #75 |
| Shortages with allowances by policy or product, and decisions | Built | — | |
| Stop a trip that left but never loaded | Built | — | A company setting |
| A loaded trip that can't deliver: return, transfer or write off, as the company allows | Planned | #64 | LT |
| Cargo in any unit: weighed (weighbridge), counted, volume-corrected | Planned | #75 | LT |
| Every trip edge case tested in the browser | Planned | #16 | |
| Multi-drop and multi-pickup trips | Proposed | — | Stops support it; desks show one load and one delivery |
| Hired (subcontracted) transporters: their trucks, rates and settlement | Proposed | — | The "hired transporter" party role exists |
| Containers: numbers, seals, return of empties | Proposed | — | |
| Border crossings: documents per border post, clearing agents, waiting time | Proposed | — | Border posts master exists |
| Trip profitability: revenue against fuel, cash, tolls and shortages | Proposed | — | Needs Billing (#61) |
| Planning board: trucks and drivers on a calendar | Proposed | — | |
| Route master with legs and distances | Built | #30 | |

## Money

| Feature | State | Issue | Notes |
| --- | --- | --- | --- |
| Fuel and cash requests with budgets, suggestions and approval policies by level | Built | — | |
| Approval by app and WhatsApp buttons | Built | — | Simulated WhatsApp until #10 |
| Escalation after hours, and SMS or e-mail for approvers | Building | #53 | LT, PR #54 |
| Paying out approved requests by payment method | Built | — | |
| Expenses with receipt photos, read from the photo, approved by Finance | Built | — | |
| Driver accounts, statements and settlement | Built | — | |
| Currencies, exchange rates typed in or fetched daily | Built | #22, #26 | |
| Billing area: customer rate cards, invoices from trips, credit notes | Building | #61 | HT |
| Payments received; realised exchange gain or loss | Building | #61 | HT |
| Revaluation of open invoices; customer statements and ageing | Planned | #62 | HT |
| Accounting export with the company's account codes | Planned | #62 | HT |
| Tax (VAT) by rate, per customer or product | Planned | #61 | HT |
| Driver allowances and per diem by route or day | Proposed | — | |
| Fuel card statements matched against fuel issued | Proposed | — | |
| Tolls and road charges per route | Proposed | — | |
| Mobile-money payouts to drivers | Planned | #59 | Simulated until a provider is connected |

## Fleet, maintenance and compliance

| Feature | State | Issue | Notes |
| --- | --- | --- | --- |
| Trucks, trailers, pairings, makes, models, types | Built | — | |
| Truck position and fuel in the tank | Built | — | |
| Compliance documents with expiry, and reminders | Built | — | Driver and vehicle documents |
| Maintenance area: service plans by km, days or hours; due and overdue | Building | #63 | LT |
| Work orders: workshop, labour, parts, cost; trucks held while in the workshop | Building | #63 | LT |
| Parts and tyres | Building | #63 | LT; optional switches inside the area |
| Cost per truck and per km | Building | #63 | LT |
| Accidents and incidents, with insurance claims | Proposed | — | |
| Driver licences, medicals and permits blocking a trip when expired | Proposed | — | Expiry is recorded; trips don't check it yet |
| Driver performance: on time, fuel against norm, shortages | Proposed | — | |

## Driver app

| Feature | State | Issue | Notes |
| --- | --- | --- | --- |
| The driver's trip, receipts by photo, arrivals, balance and statements | Built | #5 | |
| Works on a weak connection; nothing sent is lost | Built | #31 | |
| Delivery proof with the receiver's signature and photo | Proposed | — | Proof types master exists |
| Defects reported from the app open a work order | Planned | #63 | LT |
| Installable on the phone's home screen, with the company's icon | Planned | #71 | LD |
| Push notifications | Proposed | — | |
| In the driver's language | Planned | #74 | HD |

## Tracking and maps

| Feature | State | Issue | Notes |
| --- | --- | --- | --- |
| Positions from the driver's phone; the simulator, labelled | Built | — | |
| Live map and fleet map | Built | — | |
| GPS trackers through connections (generic webhook, Traccar) | Planned | #60 | HD |
| Arrival and departure detected by geofence | Planned | #60 | HD |
| Road routes and distances from a routing provider (OSRM, Mapbox, Google) | Planned | #60 | HD |
| Fuel level sensors from trackers | Proposed | — | |

## Messages and documents

| Feature | State | Issue | Notes |
| --- | --- | --- | --- |
| E-mail, SMS or WhatsApp per action, with templates, rules and an outbox | Built | #19, #29, #43 | |
| Every new company starts with templates and rules | Built | #43 | |
| E-mail through the server's or the company's own SMTP | Built | — | |
| Real WhatsApp (Marichi Talks) | Planned | #10, #59 | Needs credentials |
| SMS providers (Africa's Talking, Twilio) | Planned | #59 | |
| Trip sheet and driver statement as PDF, by print layout | Built | #44 | |
| Logo and watermark on PDFs | Building | #71 | LD |
| Invoices and customer statements as PDF | Planned | #61, #62 | HT |
| A document designer for print layouts | Proposed | — | Layouts choose sections today |

## Connections to outside services

| Feature | State | Issue | Notes |
| --- | --- | --- | --- |
| One registry for every kind of connection, each with a simulated stand-in | Building | #59 | HD |
| E-mail, SMS, WhatsApp, GPS trackers, exchange rates, map routing, file storage, accounting export, fuel cards, mobile money | Building | #59 | HD; adding a provider is one file |
| Inbound webhooks with a signing secret | Building | #59 | HD |
| Files on local disk or Google Cloud Storage | Built | #4 | S3 and Azure Blob in #59 |
| Outbound webhooks: other systems told when a trip or invoice changes | Proposed | — | |

## Reports

| Feature | State | Issue | Notes |
| --- | --- | --- | --- |
| Owner overview: figures line, approvals, fleet map, where trips are | Built | — | |
| Finance and operations queues ("Needs me") | Built | — | |
| Reports: trips, fuel, cash, shortages, utilisation, by period and branch | Proposed | — | |
| Saved list views and exports per role | Planned | #68 | |
| Scheduled reports by e-mail | Proposed | — | |

## Deploying and running a company's copy

| Feature | State | Issue | Notes |
| --- | --- | --- | --- |
| One company per installation; the first owner is created from `OWNER_EMAIL` | Built | #14 | |
| Google Cloud: Cloud Run, Atlas, Secret Manager, Cloud Storage, Cloud Scheduler; runbook and scripts | Built | #14, #26 | Needs a Google Cloud account to go live |
| Docker image built, started and checked in CI | Built | — | |
| Production hardening: headers, rate limits, compression, simulators off in production | Built | #18 | |
| Company setup kit: wizard, configuration file, deployable zip | Building | #76 | Masters → Company kit, or `npm run kit` |
| Guides and scripts for AWS, Azure, any VM with Docker Compose, Render, Fly.io, Railway | Building | #76 | docs/deploy/; Compose tested in CI |
| Upgrades and rollbacks between versions | Building | #76 | docs/deploy/README.md |
| Backups and restore drills | Proposed | — | Atlas does backups on Google Cloud; Compose needs its own |
| Health checks, error alerts and uptime monitoring | Proposed | — | `/health` exists |
| Many companies on one installation (SaaS) | Proposed | — | Today's design is one company per installation, by decision |

## Quality

| Feature | State | Issue | Notes |
| --- | --- | --- | --- |
| API tests on every change (240+ tests) | Built | — | `npm run check` |
| UI rules, a layout audit script, and a check that blocks generated-UI patterns | Built | #51 | `docs/ui-rules.md`, `npm run check:ui` |
| Browser tests that run a trip end to end | Proposed | — | Playwright was a question on #23 |
| Accessibility review (keyboard, screen reader, contrast) | Proposed | — | Contrast checked in #51 |
