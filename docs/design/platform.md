# Marichi Fleet: how a company is configured, demonstrated, deployed and kept editable

*Product-architecture analysis and design, 10 November 2026. Read against the `lakshya-t3/121-real-life`, which is ahead of `develop`. Nothing in the repository was changed.*

---

## 0. The recommendation in one page

**Restructure, but inside the same codebase: a vendor tool ("Fleet Studio") as a separate entry point and build, a slimmer company app ("the Runtime"), and one shared "profile" library between them.** This is option (c) below, chosen over "two separate programs" (b) because the Studio needs the Runtime's own schemas (masters registry, connection providers, areas, workspace defaults, the company-file schema) to configure anything, and over "keep and clarify" (a) because the confusion Lakshya hit is structural, not cosmetic: the factory that makes companies lives inside each company it makes.

What changes, in short:

| Today | Proposed |
| --- | --- |
| One program. Every company copy carries the full set-up wizard, the packager and the deploy guides. Whether it may make packages or be cleared is a flag in its own database (`purpose`, `SETUP_PACKAGES`). | **Runtime** (each company's copy): no wizard, no packager. It applies a profile on start, lets its owner export and apply a profile from one honest page ("This installation"), and knows what kind of copy it is from its environment (`COPY_PURPOSE=demo\|trial\|production`), not from a file someone can edit. |
| The wizard's draft, the "purpose", and the last applied file all live in the live company database (`SystemState`). | **Studio** (the vendor's tool, run on the vendor's laptop or a vendor VM): holds many company profiles as files in a private git folder, edits them with the same steps the wizard has today, runs a demo copy locally with Docker, deploys an environment to Google Cloud using the operator's own `gcloud` login, pulls a live copy's export back and shows drift. It has no database and holds no secrets. |
| `company.json` mixes the company (portable) with where it runs (`deploy`, environment-specific). | **Profile** (`profile.json`, format 2): the company only. **Environments** (`environments/<name>.json`): where one copy of it runs: demo-local, trial, production. Same profile, three environments: that is demo → trial → production. |
| "A demonstration" on a real copy silently does nothing; clearing depends on `mayClear`. | A demo copy has a **Reset** that drops everything and re-applies its profile and sample. A production copy has no such button, and the choice is not on any screen of a company's copy. |
| Deploy from Cloud Shell with a zip (`deploy.sh`), or from scripts in the repo. | **`fleet` CLI** (`fleet check`, `fleet kit`, `fleet deploy <company> <env>`, `fleet pull`, `fleet backup`) wraps the existing `deploy/*.sh`. Studio's Deploy button runs it and streams the log. The Cloud Shell kit path stays for customer-hosted copies. |

Phase 1 alone (section 9) removes the immediate confusion in the Runtime and is a one-PR change.

---

## 1. What exists today, and why it confuses

### 1.1 Inventory

| Piece | Where | What it does |
| --- | --- | --- |
| Company-file schema (format 1) | `src/modules/setup/companyFile.ts` | Zod schema of everything that makes one installation this company: details, regional, brand (+ files), areas, operations, maintenance, workspace (vocabulary, stages, desks), masters (layouts, lists, fields, custom masters), roles, owner, staff, connections (secrets named, never valued), `connectionRules` (locks), data (`sample`, CSV files, snapshot), `purpose: demo\|real`, **and `deploy` (target, project, region, domain, CPU…)**. |
| Apply on start | `src/modules/setup/apply.ts` | `COMPANY_CONFIG` names the file; applied before requests. Idempotent by hash; three-way "only what the file changed since last applied" per section (`changed()`, `upsert()`); creates by code/key/e-mail, never deletes. Stores `Applied {file, hash, hashes, at, results}` in `SystemState['company-file']`. Also `inviteOwner` and the `rulesStep` lock. |
| Kit (zip) | `src/modules/setup/kit.ts` | `company.json`, `.env.example` with secrets blank, `deploy/kit.env`, target scripts, README for that company, **the app's source tarball (`git archive HEAD`)**, Dockerfile. `TARGET_STATE` says honestly what has been run. |
| Deploy guide text | `src/modules/setup/guide.ts` | Per-target fields, needs, env variable explanations, steps with the company's values. |
| Set-up service and router | `src/modules/setup/setup.service.ts`, `setup.router.ts` | `fromInstallation()` (this copy as a file: an export), `check`, `kit`, draft (saved in `SystemState['setup-draft']` + one record per file), `setupStatus`, `mayClear`, `clearCopy`, `applyHere` (streams NDJSON), `demoLogins`, `packageCurrent` (with snapshot), `ratesPreview`, `checkSheet`. Mounted at `/api/v1/setup-kit`. |
| Snapshot | `src/modules/setup/snapshot.ts` | EJSON dump/restore of records (never users, sessions, audit, messages). |
| CLI | `src/jobs/kit.ts` (`npm run kit`) | Builds a kit from a file with **no database**, by importing `src/app.ts` for the registries. Proof that a DB-less profile toolchain works. |
| Wizard | `web/src/setup/SetUp.tsx`, `StepsCompany.tsx`, `StepMasters.tsx`, `StepsWork.tsx`, `StepsLive.tsx`, `StepGuide.tsx`, `context.tsx`, `countries.ts`, `setup.css` | 13 steps at `#set-up/<step>`; finish "here" (applies to the copy you stand in) or "package" (download). Start step: "A demonstration" / "A real company", start blank / from this copy / from a file. |
| Package page | `web/src/setup/PackagePage.tsx` | `#package`: this copy as it stands, with records none/masters/everything and files, a purpose toggle, where it runs, the guide. |
| Entry points | `web/src/App.tsx` (opens `#set-up` when no company), `web/src/Office.tsx:427-436, 493-502` (two sidebar buttons for anyone with `company:update`), `web/src/desks/Overview.tsx:25`, `web/src/masters/CompanySetup.tsx` (the first-trip checklist, a different thing with a similar name). |
| Environment | `src/config/env.ts` | `COMPANY_CONFIG`, `SETUP_PACKAGES` (default true), `OWNER_EMAIL`, `OWNER_PASSWORD`, production refusals. |
| Deploy scripts | `deploy/new-company.sh` (GCP: APIs, SA, bucket, secrets, NAT, Cloud Run, jobs, LB/mapping, alerts, budget), `deploy/update-company.sh`, `deploy/build-image.sh`, `deploy/targets/*` (gcp-all.sh = `deploy.sh` in the kit, compose, local, aws, azure, render, fly, railway), `deploy/company.env.example`. | GCP has had a dry run only. Compose and local are tested in CI (`.github/workflows/check.yml` job `kit`). |
| Docs | `docs/deploy/README.md`, `docs/deploy/gcp.md`, `docs/deploy-gcp.md` (runbook), `docs/FEATURES.md` | |
| Tests | `tests/setup-kit.test.ts`, `tests/setup-guided.test.ts`, `tests/platforms.test.ts` | ~35 tests covering schema, kit, apply, drafts, demo logins, clearing, locks, GCP sizing. |

What is good and must survive: the company-file schema and its validation messages; the three-way, never-deleting apply; the kit that carries its own source; honest `TARGET_STATE`; the wizard steps themselves (they are well made); the test coverage.

### 1.2 The three bugs, and their root causes

**Bug 1: "Set up a company" on a copy that is already a real company.** The sidebar offers *Set up a company* and *Package this company* to anyone with `company:update` on every copy, forever (`web/src/Office.tsx:427-436`). The wizard then shows "What are you setting up? A demonstration / A real company", "Start from: this copy's settings", and at the end "Set up this copy: its settings change to what's above; its records stay." On a live company that reads like an invitation to re-create the company. Root cause: the wizard has three jobs (first-run set-up, editing settings, making a package for *another* company) and one entry.

**Bug 2: choosing "A demonstration" on a real copy does nothing useful.** Three guards combine:
- `apply.ts:504`: `if (file.data.sample === 'none' || file.data.sample === 'starter' || (last && last.file.data.sample !== 'none')) return;` — once any sample was ever applied, the sample step is skipped for good, and a real company that applied with `starter` is `!== 'none'`, so it is skipped too.
- `setup.service.ts:634-637` `mayClear`: in production only when the *last applied* file said `demo`; in development always. So on a developer copy the clear works, on a deployed one it doesn't, and the screen's "Clear it first" row appears or vanishes on that basis.
- `setup.service.ts:667`: "once real, always real" refuses `purpose: demo` in production.

Each guard is right on its own; together they make the Start step a choice that often has no effect, with no message saying so. Root cause: *purpose* is modelled as a property of a mutable file inside the copy, when it is really a property of the **environment** the copy runs in.

**Bug 3: "too integrated to use reliably".** The packager reads the copy you stand in (`fromInstallation()`), so to package company B you must first turn your demo copy into company B, which rewrites your demo. Drafts live in the company's own `SystemState`, so two prospects cannot be in progress at once. `SETUP_PACKAGES=false` is a per-copy switch that pretends to separate roles. The deploy guide and target fields are screens inside a product the customer uses. And the GCP path has three different front doors (Cloud Shell `deploy.sh` from a zip, `deploy/new-company.sh` from a `.env`-style file, the README's `gcloud run deploy --source`).

### 1.3 The structural diagnosis

Three personas share one program and one database:

1. **The vendor** needs *many* companies, drafts in parallel, templates, a place to keep profiles, a way to run demos and deploys, and a record of what was deployed where.
2. **The company's owner/admin** needs their own settings screens, a way to export their configuration, and never to see another company's machinery.
3. **The deploy operator** needs a reliable, repeatable command with a preflight and a log.

The code already contains the right seams: a DB-free kit CLI, an export (`fromInstallation`), an idempotent apply, per-target scripts. What is missing is a *home* for persona 1 that is not a company's database.

---

## 2. Actors and their jobs

| Job | Vendor (Lakshya's team) | Implementer / onboarding person | Transporter owner & admin | Sales demo |
| --- | --- | --- | --- | --- |
| Show the product to a prospect | Keep 2–3 demo profiles (fuel tanker Zambia, part-load India, mixed); start one in a minute; reset after. | — | — | A copy with made-up data, every area on, sign-ins per role, "Demonstration" visible, resettable. |
| Run a 14-day trial (the business lead has 3–4 transporters waiting) | Create the profile from the demo template, change name, region, areas; deploy a cheap cloud copy; hand over the owner sign-in. | Fill masters from spreadsheets with the transporter; adjust words and stages. | Enter their trucks, drivers, places, customers; run real trips. | — |
| Onboard a real company | Promote the trial copy to production (bigger DB tier, domain, alerts, budget) *without losing what they entered*; or deploy fresh from the profile. | Final data load, roles and people, connections (WhatsApp, e-mail). | First owner signs in; invites staff. | — |
| Change configuration later | Vendor-only parts: locks, areas allowed, environment sizing, version. | Bigger reshaping (new custom master, new stages) either in the app or in Studio, then applied. | Day to day: masters, fields, lists, roles, templates, brand, regional, connections within what's allowed. In the app. | — |
| Upgrade the version | Build an image, roll it to each environment, watch the health check, roll back if needed. | — | Is told when; sees the version on "This installation". | — |
| Back up and restore | Know where backups are per environment (Atlas, bucket versioning); run a restore drill. | — | May download an export of configuration; data backups are the vendor's. | — |
| Move a trial to production | One action: change environment settings (tier, domain, alerts), keep the database, flip `COPY_PURPOSE`. | — | Nothing changes for them except the address. | — |
| Clone or reset a demo | Duplicate a profile; reset a running demo to its profile. | — | — | Reset between demos. |
| Host at the customer's own cloud (raised on the 8 Nov call) | Hand over a kit (zip) with a Cloud Shell guide, as today. | Runs `deploy.sh` in the customer's project. | Their IT holds the project. | — |

Observations that drive the design:

- Jobs in column 1 are *across companies*; jobs in column 3 are *within one company*. Nothing in column 3 needs the wizard or the packager; everything in column 1 needs a place that is not a company's copy.
- Demo → trial → production is **one company, three environments**. Today the file mixes both, so a promotion means editing `deploy` inside the company file and re-packaging.
- The trial copy *is* the production copy's beginning for a real transporter (they will have typed their trucks in). Promotion must keep the database.

---

## 3. How comparable products do it (research)

| Product | Pattern | What to borrow | What to avoid |
| --- | --- | --- | --- |
| **Odoo** | One codebase; a *database manager* creates/duplicates databases (master password); Odoo.sh gives each project production + staging branches, where staging is a **neutralised duplicate** of production (outgoing mail and IAP disabled, mail caught) and can be rebuilt on demand; code merges carry no data. Studio customisations export as a module (`studio_customization`) and import only into the same version with the same modules. ([Odoo.sh branches](https://www.odoo.com/documentation/18.0/administration/odoo_sh/getting_started/branches.html), [Neutralized database](https://www.odoo.com/documentation/master/administration/neutralized_database.html), [Studio export/import](https://www.odoo.com/documentation/14.0/ro/applications/productivity/studio/how_to/export_import.html)) | "Neutralised" as a *mode of the environment* (our `COPY_PURPOSE=demo`: simulators on, mail caught, resettable). Config exported as a versioned artefact tied to an app version. Rebuild-from-production as a first-class action. | The database manager as a page of the product itself, protected by a master password: exactly what we have now and what confuses. |
| **ERPNext / Frappe** | `bench` (a CLI) manages many *sites* on one *bench* (one code version); `common_site_config.json` (shared) + `site_config.json` (per site, wins). Customisations made in the UI (Custom Field, Property Setter) are **exported as fixtures** into an app and re-applied on migrate; the docs warn to export with filters, never everything. Frappe Cloud is the hosted control plane. ([Sites](https://docs.frappe.io/framework/user/en/basics/sites), [Site config](https://docs.frappe.io/framework-git/administration/site-config), [Fixtures](https://docs.frappe.io/framework/user/en/guides/app-development/how-to-create-custom-fields-during-app-installation), [export-fixtures discussion](https://discuss.frappe.io/t/solved-whats-the-right-way-to-version-control-my-customizations/61661/2)) | A CLI as the operator's tool; per-site config file layered over shared defaults; UI customisations round-trip to files by *key*, not id (our `fromInstallation` already does this). | Un-filtered export ("everything the site has"), which drags other apps' customisations along; our snapshot "everything" has the same smell and should stay demo-only. |
| **Salesforce / Dynamics 365** | Sandboxes of several sizes; promotion to production moves **metadata** (Salesforce) or **solutions**, managed vs unmanaged (Dynamics). Environment-specific values are the chronic pain. ([comparison](https://devops.com/salesforce-vs-dynamics-365-ce-devops-a-practical-comparison-for-enterprise-teams/), [sandbox vs production](https://syvantis.com/blog/dynamics-365-crm-sandbox-versus-production-environments), [environment strategy](https://learn.microsoft.com/en-ie/Dynamics365/guidance/implementation-guide/environment-strategy-key-factors-affected)) | Configuration as a *solution* that moves between environments; "managed" = the vendor's part the customer can't edit (our `connectionRules`, areas allowed). | Letting environment values (URLs, project ids) live in the solution. |
| **GitLab / Sentry / Metabase (self-managed)** | Two layers: install-time file config (`gitlab.rb`, `config.yml`, `.env`) owned by the operator, and runtime **Admin settings in the database** owned by the admin, exposed by an API. A value set in the file is **read-only in the UI**. ([GitLab Admin Area settings](https://archives.docs.gitlab.com/16.2/ee/administration/settings), [application settings API](https://archives.docs.gitlab.com/16.1/ee/api/settings.html), [Omnibus config](https://docs.gitlab.com/omnibus/settings/configuration.html), [Sentry layers](https://www.mintlify.com/getsentry/sentry/self-hosted/configuration), [config.yml vs UI](https://forum.sentry.io/t/config-yml-vs-manage-settings/10025)) | The split we already have (env vs company record), made explicit: anything the profile *locks* shows as locked in the app with "set by your installation's profile". | Settings that silently come from two places. |
| **Replicated (vendor portal + KOTS)** | **The two-program pattern for self-hosted software.** The vendor portal (vendor side) holds releases, *customers*, *licences* with built-in and custom fields; the customer runs an admin console in their cluster that uploads the licence, shows a **config screen** generated from the release, and can sync licence changes. Headless installs pass a licence file and a `ConfigValues` file. ([licences](https://docs.replicated.com/vendor/licenses-about), [config screen](https://docs.replicated.com/vendor/config-screen-about), [ConfigValues](https://docs.replicated.com/vendor/releases-configvalues), [custom licence fields](https://docs.replicated.com/vendor/licenses-adding-custom-fields)) | Exactly our Studio/Runtime split: Studio = vendor portal (customers, profiles, releases, what each customer is entitled to); Runtime "This installation" = admin console (shows the profile applied, lets the admin edit what the config screen allows, pulls updates). The *entitlement* (areas, locks, purpose) is the vendor's; the *config values* are the customer's. | Building a licence server. We don't need online entitlement; the profile travels in the kit. |
| **keycloak-config-cli** | A CLI that applies a declared realm (JSON/YAML) to a **running** server through its admin API, idempotently, no restart. ([keycloak-config-cli](https://github.com/adorsys/keycloak-config-cli), [intro](https://adorsys.github.io/keycloak-config-cli/intro/)) | Our `apply.ts` is this. Keep it, and expose it as "Apply a profile" on the running copy, with a dry run. | Keycloak's own whole-realm export, which is unusable across environments because client secrets and URLs are inside it ([mailing list](https://lists.jboss.org/pipermail/keycloak-user/2017-March/009750.html), [Red Hat docs](https://docs.redhat.com/en/documentation/red_hat_build_of_keycloak/24.0/html/server_guide/importexport-)). Hence: **profile ≠ environment**. |
| **AWS SaaS Lens** | *Silo* model: one stack per tenant; a **control plane** (shared, the vendor's) onboards and operates tenants; the *application/data plane* is per tenant and can even live in the customer's account ("remote application plane"). ([Silo isolation](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/silo-isolation.html), [tenant onboarding, silo](https://docs.aws.amazon.com/prescriptive-guidance/latest/patterns/tenant-onboarding-in-saas-architecture-for-the-silo-model-using-c-and-aws-cdk.html), [remote environments](https://aws.amazon.com/blogs/apn/patterns-for-deploying-saas-in-remote-environments)) | The founding principle *is* the silo model. Studio is the control plane; it must not become a shared data plane. | Multi-tenant pooling. |
| **GCP mechanics** | *Cloud Run Button*: clones a repo into Cloud Shell, reads `app.json` for env prompts and hooks; needs a public repo ([cloud-run-button](https://github.com/GoogleCloudPlatform/cloud-run-button)). *Cloud Build triggers* from GitHub with per-trigger `_SUBSTITUTIONS` ([continuous deployment](https://cloud.google.com/run/docs/continuous-deployment-with-cloud-build?hl=vi), [substitutions](https://docs.cloud.google.com/build/docs/configuring-builds/use-bash-and-bindings-in-substitutions)). *GitHub Actions* deploy with **Workload Identity Federation**: short-lived tokens, no JSON key ([deploy-cloudrun](https://docsearch.algolia.com/mcp/docs/repo/google-github-actions/deploy-cloudrun), [keyless auth](https://cloud.google.com/blog/products/identity-security/enabling-keyless-authentication-from-github-actions)). *Atlas*: Admin API / `atlas` CLI create projects and clusters; **Flex** tier is capped at $30/month and M2/M5 were migrated to it on 22 Jan 2026 ([Admin API](https://www.mongodb.com/docs/atlas/api/atlas-admin-api/), [createCluster](https://www.mongodb.com/docs/atlas/cli/current/command/atlas-api-clusters-createcluster/), [Flex costs](https://mongodb.com/docs/atlas/billing/atlas-flex-costs)). *Terraform*: good for drift of infrastructure, but a new image is not "drift" and `google_cloud_run_service` → `v2` migrations recreate services ([Terraform on Cloud Run](https://cloud.google.com/blog/ja/products/devops-sre/migrating-terraform-resources-stablely-to-cloud-run-api-version-2), [drift](https://revolgy.com/insights/blog/keep-your-infrastructure-in-check-with-terraform-drift-detection)). *Cloud Run pricing*: request-based billing charges nothing while idle; free tier per billing account ([pricing](https://cloud.google.com/run/pricing?hl=nl)). | Scale-to-zero Cloud Run + Atlas Flex makes a trial copy cost very little while idle. WIF is the right answer *if* deploys ever move to CI. `gcloud` scripts, which exist and are idempotent, are enough for one operator; Terraform would be a second system to learn with its own state to protect. | The Cloud Run Button (public repo; prompts for secrets in a browser). Terraform now. |

Lessons applied in the design:

1. **Separate the company (profile) from where it runs (environment).** Every product that mixes them (Keycloak realm exports, Salesforce metadata with URLs) suffers at promotion time.
2. **Two surfaces, one codebase.** Replicated's vendor portal and admin console are two UIs over one release; Frappe's bench and the site UI are two tools over one code tree. Nobody ships the factory inside the product.
3. **Config lives in the running copy's database, and round-trips to a file by key.** GitLab/Sentry/Metabase/Frappe all do it; we already do (`fromInstallation` ↔ `applyFile`). The file is for *moving and seeding*; the database is for *running*.
4. **File-set values lock the UI.** What the profile decides for a company (locks, entitlements) shows as locked in the app, with the reason.
5. **A neutralised, resettable demo is an environment mode**, not a flag in the data.
6. **Idempotent apply to a running server** (keycloak-config-cli) is the mechanism for "later edits" without redeploying.
7. **The operator's tool is a CLI with a GUI over it**, using the operator's own cloud login; the product never holds cloud credentials.

---

## 4. Options

Evaluated on: how config flows; how "editable after deploy" works; versions and upgrades; secrets; the GCP path; effort; fit with the founding principle; whether one careful non-expert can run it.

### (a) Keep one program, fix and clarify the set-up inside it

- **Config flow:** unchanged. The copy you stand in is both factory and product.
- **Editable after deploy:** yes, in the app; export via "Package this company".
- **Fixes:** hide the wizard once a company exists; rename; make demo reset work; split purpose from file.
- **Trade-offs:** cheapest. But the vendor still has no place for many profiles; drafts still live in one company's DB; packaging another company still means overwriting your demo; the customer's product still ships the deploy guides for seven clouds. The bugs come back in new clothes.
- **Verdict:** do its *good* parts as Phase 1 (they are needed anyway), but not as the basis.

### (b) Two programs in two repositories: Studio and Runtime

- **Config flow:** Studio owns profiles; Runtime applies them. Studio deploys.
- **Editable after deploy:** Runtime admin screens; export back to Studio.
- **Trade-offs:** cleanest story, but Studio must validate against the Runtime's registries (masters, providers, areas, layouts). Either duplicate them (they will drift) or publish the Runtime's core as a package and version-match it (`companyFile.ts` imports `saveCompanySchema`, `providerFor`, `layoutInputSchema`, `AREA_KEYS`…: half the server). The "demo them" job needs a Runtime running anyway. Two repos, two CIs, two release trains for a team of one orchestrator and three agents.
- **Verdict:** right shape, wrong packaging.

### (c) Studio as a separate entry point and build of the same codebase  **(recommended)**

- **Config flow:** `src/profile/` (schema, kit, guide, csv, zip) is shared, DB-free (as `npm run kit` proves today). Studio server imports it plus `src/app.ts` for the registries, exactly like `src/jobs/kit.ts`. Runtime imports it for apply/export.
- **Editable after deploy:** in the Runtime's own screens for company-editable sections; Studio pulls the export, shows drift, and pushes vendor-only changes by redeploy or "Apply a profile".
- **Versions:** one repo, one version. A profile records the app version it was last applied with. The kit still carries its source.
- **Secrets:** Studio holds none; it runs `gcloud`/`atlas` under the operator's login and passes secret values it is given straight to Secret Manager via stdin.
- **GCP path:** the existing idempotent scripts, behind a `fleet` CLI, behind a Studio button. The Cloud Shell zip stays for customer-hosted projects.
- **Trade-offs:** the Runtime image must *not* include Studio (separate Vite entry, separate server entry, `WEB_DIR` unchanged). Studio needs Node + Docker Desktop (+ gcloud for deploys) on the vendor's machine: three tools to install once, each checked on Studio's Tools panel.
- **Verdict:** it is (b)'s architecture without (b)'s duplication, and the repo already leans this way.

### (d) Multi-tenant SaaS

- A shared Runtime, tenant id on every record. Rejected: the founding principle, data isolation as the selling point (the business side wants to hand over source and host at the customer's), per-company custom masters and layouts, and a rewrite of every query. What *is* kept from this model is the **control plane**: Studio.

### Side question: GitHub Actions per company, Terraform, "Deploy to Cloud Run" button

- **GitHub Actions + WIF** is the credential-free way to deploy from CI and is a good *later* option for the vendor's own project (push a profile → deploy). It needs a one-time WIF set-up per GCP project and git fluency; not the primary path for one non-expert person. Designed as Phase 7, optional.
- **Terraform**: adds state to protect and a second language; drift detection would still miss the thing that changes most (the image). Not now.
- **Cloud Run Button**: public repo and browser prompts for env values. No.
- **Cloud Shell + kit** (today's `deploy.sh`): keep as the path for a customer's own GCP project, because it needs nothing installed and the customer's IT stays in control.

---

## 5. The recommended basis, specified

### 5.1 Components

```
┌──────────────────────── vendor's laptop (or a vendor VM) ─────────────────────────┐
│  Fleet Studio  (npm run studio → http://localhost:4000)                            │
│   studio/server   Express, NO database. Workspace = a folder under git:            │
│                   ~/fleet-companies/<key>/profile.json, environments/*.json,       │
│                   files/, data/, runs/ (deploy logs)                               │
│   web/studio      React, the wizard's steps as a long settings page per company    │
│   fleet CLI       check · kit · up/down (local demo) · deploy · pull · diff ·       │
│                   backup · restore · promote · version                             │
│   uses: docker (local demos), gcloud (+ atlas, optional) under the operator's login │
└───────────────┬───────────────────────────────────────────────┬───────────────────┘
                │ kit.zip / profile.json (files)                 │ gcloud … (scripts in deploy/)
                ▼                                                ▼
   Customer-hosted GCP (Cloud Shell, deploy.sh)        Vendor's GCP project(s): Cloud Run per
                                                       environment, Atlas, Secret Manager, GCS
                                 ┌──────────────────────────────────────────────────────┐
                                 │  Runtime (one per company environment)               │
                                 │   src/ + web/ as today, minus wizard and packager    │
                                 │   applies /mnt/bucket/kit/profile.json on start      │
                                 │   "This installation": facts · export · apply · reset │
                                 │   COPY_PURPOSE=demo|trial|production from env        │
                                 └──────────────────────────────────────────────────────┘
```

**Shared library:** `src/profile/` (schema, migrations between formats, kit, guide, csv, zip, diff). No Mongoose, no `env`. Importable by Studio, the CLI and the Runtime.

### 5.2 Repository layout and what moves where

| Today | New home | Notes |
| --- | --- | --- |
| `src/modules/setup/companyFile.ts` | `src/profile/schema.ts` (+ `src/profile/environment.ts`) | Format 2: `deploy` and `purpose` leave the profile and become an environment file. `src/profile/migrate.ts` turns a format-1 file into a profile + one environment. |
| `src/modules/setup/kit.ts` | `src/profile/kit.ts` | Signature becomes `buildKit(profile, environment, attachments)`. `appSource()` stays (it only needs git). |
| `src/modules/setup/guide.ts` | `src/profile/guide.ts` | Unchanged logic; reads the environment for target fields. |
| `src/modules/setup/csv.ts`, `zip.ts` | `src/profile/csv.ts`, `src/profile/zip.ts` | |
| `src/modules/setup/apply.ts` | `src/modules/installation/apply.ts` | Add `dryRun` (returns the plan without writing), accept `(profile, environment)`, record `appliedRevision` and `appVersion` in `Applied`. |
| `src/modules/setup/snapshot.ts` | `src/modules/installation/snapshot.ts` | Unchanged. |
| `src/modules/setup/setup.service.ts` | split: `src/modules/installation/installation.service.ts` (status, export = `fromInstallation`, apply-with-preview, reset-demo, demo logins) and `studio/server/profiles.ts` (drafts, check, kit, package: everything that was per-draft) | `clearCopy`/`mayClear`/`purpose` logic is replaced by `resetDemo` gated on `env.COPY_PURPOSE === 'demo'`. |
| `src/modules/setup/setup.router.ts` (`/setup-kit`) | `src/modules/installation/installation.router.ts` (`/installation`): `GET /status`, `GET /export` (owner), `POST /apply/preview`, `POST /apply` (owner, NDJSON), `POST /reset` (owner, demo only), `GET /about` (version, purpose, applied) | `/draft*`, `/kit`, `/package`, `/guide`, `/check-sheet`, `/rates-preview` move to Studio's server. Keep `/setup-kit/status` as an alias for one release. |
| `src/jobs/kit.ts` | `src/cli/fleet.ts` → `bin/fleet` (`npm run fleet -- …`) | Subcommands in `src/cli/commands/*.ts`. |
| `src/config/env.ts` `SETUP_PACKAGES` | removed; add `COPY_PURPOSE: z.enum(['demo','trial','production']).default(NODE_ENV==='production' ? 'production' : 'demo')` and `TRIAL_ENDS` (date, optional). Production refuses `COPY_PURPOSE=demo` unless `DEMO_IN_PRODUCTION=true` (so a cloud demo is possible and explicit). | `COMPANY_CONFIG` stays; it now points at `profile.json`; the environment file sits beside it as `environment.json` (the kit writes both). |
| `web/src/setup/SetUp.tsx`, `Steps*.tsx`, `StepGuide.tsx`, `context.tsx`, `countries.ts`, `setup.css` | `web/src/studio/*` (second Vite entry `web/studio.html` → `web/src/studio/main.tsx`) | Steps reused nearly as-is as sections of a long page with the rail. `PackagePage.tsx` becomes Studio's "Package" panel. |
| `web/src/App.tsx` `#set-up`/`#package` routing, `web/src/Office.tsx:427-436, 493-502` sidebar buttons, `web/src/desks/Overview.tsx:25` | replaced by one item **"This installation"** under Masters → Organisation (`web/src/masters/Installation.tsx`), and a first-run page `web/src/firstRun/FirstRun.tsx` shown only when no company exists | |
| `deploy/*.sh`, `deploy/targets/*` | unchanged location; called by `src/cli/commands/deploy.ts` with the kit directory as cwd | The scripts are the contract; the CLI only prepares inputs and streams output. |
| `docs/deploy/*`, `docs/deploy-gcp.md` | `docs/deploy/*` (Cloud Shell path), new `docs/studio.md`, `docs/profile.md` (format 2) | |
| `tests/setup-*.test.ts`, `tests/platforms.test.ts` | `tests/profile.test.ts`, `tests/installation.test.ts`, `tests/studio.test.ts`, `tests/cli.test.ts` | Same assertions, new routes. |
| (new) | `studio/server/*` (`index.ts`, `workspace.ts`, `profiles.ts`, `local.ts` (docker compose up/down/status), `deploys.ts` (spawn + stream), `tools.ts` (detect node/docker/gcloud/atlas and logins)), `studio/package.json` scripts, `studio.command` / `studio.bat` double-click starters | Studio listens on 127.0.0.1 only. |
| `Dockerfile` | unchanged for the Runtime image; `.dockerignore` adds `studio/` and `web/studio.html`; `npm run build:web` builds only the Runtime entry (`vite build` with `--config web/vite.runtime.ts`), `npm run build:studio` the Studio entry | CI asserts the Runtime image has no Studio route or chunk. |

### 5.3 The profile format (format 2) and its versioning

**`profile.json`** (the company; portable; no environment values; no secret values):

```jsonc
{
  "format": 2,
  "revision": 14,                       // bumped by Studio on every save; monotonic per company
  "appVersion": "fa4f303",              // the app commit this profile was last checked against
  "company":   { "key": "acme-haulage", "legalName": "…", "tradingName": "…", … },
  "regional":  { … }, "brand": { …, "files": { "logo": "files/logo.png" } }, "watermark": …,
  "areas": [...], "operations": {...}, "maintenance": {...}, "workspace": {...},
  "masters": { "layouts": [...], "lists": [...], "fields": [...], "customMasters": [...] },
  "roles": [...], "owner": {...}, "staff": [...], "selfSignUp": false,
  "connections": [...], "connectionRules": {...},
  "data": { "sample": "none|starter|small|full", "files": [...], "snapshot": "data/snapshot.json" },
  "vendor": {                           // the vendor's entitlement; locked in the app
    "lockedSections": ["areas", "connectionRules"],
    "notes": "Trial agreed 8 Nov; fuel only."
  }
}
```

Differences from format 1: `deploy` and `purpose` are gone (they are environment); `revision`, `appVersion`, `vendor` added. Everything else keeps its name, so `migrate.ts` is mechanical: `{...rest, format: 2, revision: 1}` plus `environments/<name>.json` written from `deploy` and `purpose`.

**`environments/<name>.json`** (where one copy runs; one per copy):

```jsonc
{
  "format": 2,
  "name": "trial",                      // demo-local | demo-cloud | trial | production | <custom>
  "purpose": "trial",                   // demo | trial | production  → COPY_PURPOSE
  "trialEnds": "2026-11-26",            // optional; the Runtime shows "Trial: 9 days left"
  "target": "gcp", "projectId": "marichi-fleet", "region": "africa-south1",
  "domain": "fleet.acme.example", "domainMode": "lb", "egress": "static",
  "minInstances": 0, "maxInstances": 1, "cpu": "1", "memory": "512Mi",
  "alertEmail": "…", "monthlyBudget": 50, "schedulerRegion": "europe-west1",
  "smtp": { "host": "…", "port": 587, "user": "…", "from": "…" },
  "image": null,                        // built from source unless named
  "database": { "kind": "atlas", "tier": "FLEX|M10", "note": "cluster acme-trial" },  // documentation only
  "deployed": { "version": "fa4f303", "at": "2026-11-12T09:10:00Z", "revision": 14, "url": "https://…run.app" }  // written by fleet deploy
}
```

The existing per-target `deploy` schemas in `companyFile.ts:228-258` move here verbatim. `environments/demo-local.json` is `{ target: "local", purpose: "demo", port: 8080 }`.

**Versioning rules**

- `format` changes only when the schema is incompatible; `src/profile/migrate.ts` has one function per step (1→2, later 2→3). Studio migrates on open and says so; the Runtime migrates on start (so an old kit still applies). Tests: every fixture in `tests/fixtures/profiles/format-1/` migrates and validates.
- `revision` is the profile's own counter. The Runtime records the applied `revision` in `SystemState['company-file']`; export carries it back. Comparing revisions is how Studio knows a copy is behind.
- `appVersion` is informational; a profile that names fields a newer app renamed is caught by validation, as now.
- Git in the workspace folder is the history: Studio commits on every save ("acme-haulage: revision 14 — areas: billing on") and on every deploy run.

### 5.4 Who edits what

| Section | Transporter's owner/admin, in their app | Vendor, in Studio | How a Studio change reaches a running copy |
| --- | --- | --- | --- |
| Company details, regional, brand, watermark | Yes (Masters → Company) | Yes (initial) | Apply (three-way: only what Studio changed since last applied) |
| Masters: layouts, lists, fields, custom masters | Yes (master of masters) | Yes | Apply; by code/key; never deletes |
| Workspace: vocabulary, stages, desks | Yes | Yes | Apply |
| Operations, maintenance rules | Yes | Yes | Apply |
| Roles, staff, self sign-up | Yes (Users, Roles) | Yes (initial) | Apply creates missing; never removes people |
| Connections (within the rules) | Yes (Masters → Connections) | Yes | Apply |
| `areas` (which parts the company bought) | **Locked** when in `vendor.lockedSections`; shown greyed with "Set by your installation's profile. Ask your provider." | Yes | Apply or redeploy; the lock is enforced server-side (`rulesStep`-style, extended to areas) |
| `connectionRules` (which providers offered, locks) | Never (today's rule, kept) | Yes | Apply from the installation's own kit only (today's `rulesStep` guard, re-keyed on `COPY_PURPOSE !== 'demo'` instead of `SETUP_PACKAGES`) |
| `data.sample`, snapshot | No | Yes | First start, or Reset (demo only) |
| Environment (purpose, sizing, domain, version) | No; they see it on "This installation" | Yes | `fleet deploy` |
| Secrets | Never in any app | Never stored; passed through to Secret Manager / `.env` | `fleet deploy` or `fleet secret set` |

Locks are the GitLab/Sentry rule made visible: a locked section's controls render disabled with a one-line reason, never hidden.

### 5.5 Lifecycle flows

**New prospect, demo (5 minutes).** Studio → Companies → *New from template* ("Fuel tankers, Southern Africa" / "Part-load, India" / "Empty") → name it → *Run locally*. Studio writes `environments/demo-local.json`, builds the kit, runs the existing `deploy/targets/local` compose project (`fleet up acme-haulage demo-local`), waits for `/api/v1/health/ready`, opens `http://localhost:8080`, shows the demo sign-ins (today's `demoLogins`). Sign-in page shows "Demonstration copy". *Reset* at any time: `POST /api/v1/installation/reset` drops every collection and re-applies profile + sample (Runtime side, demo only). *Stop* / *Remove* via compose down (-v).

**Cloud demo for a sales call.** Same profile, `environments/demo-cloud.json` (`target: gcp`, `purpose: demo`, `domainMode: none`, `minInstances: 0`, Atlas Flex). `fleet deploy acme-haulage demo-cloud`. Runtime starts with `COPY_PURPOSE=demo DEMO_IN_PRODUCTION=true`, so simulators and reset are allowed, and the banner shows. Cost while idle: Cloud Run request-based billing charges nothing idle; Flex is capped at $30/month ([Flex costs](https://mongodb.com/docs/atlas/billing/atlas-flex-costs)); the load balancer is avoided by `domainMode: none`.

**14-day trial.** Duplicate the demo profile or start from the template; set `data.sample: "starter"`, the transporter's region, areas; add owner e-mail. `environments/trial.json`: `purpose: trial`, `trialEnds`, Flex, no domain, `minInstances: 0`. `fleet deploy acme-haulage trial`. The Runtime shows "Trial copy · 14 days left" in the sidebar footer and on sign-in (words from the environment, not from data). Simulators are off (production refusals apply). The owner is invited by e-mail (or `OWNER_PASSWORD` if no mail yet). The implementer loads spreadsheets in the app's import screens or through Studio's Data step + Apply.

**Trial → production (promote).** `fleet promote acme-haulage trial production` = copy `trial.json` → `production.json` with `purpose: production`, `trialEnds` removed, `domain` + `domainMode: lb`, `monthlyBudget`, `alertEmail` set in Studio's form; **same Cloud Run service, same Atlas database** (the service is named `fleet-<key>` either way; the environment file's `serviceName` defaults to `fleet-<key>` and both environments point at it). Studio warns: "This changes the running copy's purpose and address; its data stays." Steps the CLI runs: Atlas tier change is manual (printed as a step: Atlas → cluster → Edit → M10, backups on), then `new-company.sh` re-run with the new env (idempotent: adds LB, alerts, budget, sets `COPY_PURPOSE=production`). If the vendor prefers a fresh production copy, *Deploy fresh with a snapshot* builds the kit with `data.snapshot` from `fleet pull --records everything`.

**Later edits.**
- By the company: in their app, as today. Nothing else to do.
- By the vendor: edit in Studio → *Apply to trial* → Studio shows the **preview** (`POST /installation/apply/preview` with the profile: a list of `created / updated / unchanged / skipped` per step and section, computed by `applyFile(..., {dryRun: true})`) → confirm → Studio uploads the profile to the bucket (`gs://<bucket>/kit/`) and calls `POST /installation/apply` with an owner token the operator signs in with in Studio (Studio asks for the owner's e-mail and password for that copy, uses the token for the call, discards it). Alternative without a sign-in: `fleet deploy` again, which re-copies the kit and restarts; the Runtime applies on start as today. Both paths end in the same three-way apply.

**Upgrade.** `fleet deploy acme-haulage production --version <sha>` (default: current HEAD). Cloud Build builds the image once per version; `update-company.sh` rolls the revision; the startup probe on `/health/ready` guards it; `environments/production.json.deployed` is updated. Studio's *Running* tab shows each environment's version and the latest available. Before upgrading production, Studio's preflight prints "Take an Atlas snapshot first" with the link, and `fleet backup` (below) as the alternative.

**Rollback.** `fleet rollback acme-haulage production` lists revisions (`gcloud run revisions list`) and moves traffic (`update-traffic`), as `docs/deploy/gcp.md` describes; warns if the database may have moved forward (compare `Migration` records via `/installation/about`).

**Backup and restore.** `fleet backup acme-haulage production` runs `mongodump --uri "$(gcloud secrets versions access latest --secret <key>-mongodb-uri)" --gzip --archive=…` locally (the URI never touches disk) and `gcloud storage cp` to `gs://<bucket>/backups/<date>.gz`; `fleet restore … <date> --to <env>` does the reverse into another environment (the standard way to clone production into a demo-local copy for investigation; drivers' phone numbers and e-mails are then neutralised by the Runtime's demo mode: outgoing messages go to the log when `COPY_PURPOSE=demo`). Atlas snapshots and bucket versioning remain the primary backups, documented per tier as now.

**Clone a demo.** Studio *Duplicate* copies `profile.json`, `files/`, `data/` to a new key; optionally `fleet pull --records everything` from a running demo first, so the clone carries its trips.

**Reset a demo.** Runtime `POST /installation/reset` (owner, `COPY_PURPOSE=demo` only, confirm by typing the name): drop all collections except the acting owner's user and sessions, clear `SystemState['company-file']`, re-apply the profile at `COMPANY_CONFIG` (sample included, because `last` is now empty: this is the fix for `apply.ts:504`), re-create demo logins. Also on Studio as a button for local and cloud demos.

**Customer-hosted GCP.** Studio → *Download kit for Cloud Shell* (today's zip, now carrying `profile.json` + `environment.json`). The customer's IT runs `./deploy.sh` as documented in `docs/deploy/gcp.md`. Later edits: the owner exports from "This installation", sends the file; Studio diffs and returns a new kit, or the owner applies a profile file on "This installation" directly.

### 5.6 The GCP deployment path, step by step (vendor-hosted)

One-time, per vendor GCP project (documented on Studio's Tools panel with the commands, run by the operator once):
1. Install Node 22, Docker Desktop, Google Cloud CLI; `gcloud auth login`; `gcloud config set project marichi-fleet`. Optionally `atlas` CLI and `atlas auth login`.
2. Create (by hand or `atlas` CLI) one Atlas project per company, or one project with one cluster per company; the CLI prints the exact `atlas clusters create` command for Flex or M10 from the environment file, since the Admin API supports it ([createCluster](https://www.mongodb.com/docs/atlas/cli/current/command/atlas-api-clusters-createcluster/)).

Per company environment, from Studio's **Deploy** panel (or `fleet deploy <key> <env>`):
1. **Preflight** (`src/cli/commands/preflight.ts`): tools present and logged in; project reachable; billing on; `company.key` ≤ 24 chars; environment file valid; image for `--version` exists or source present; secrets present in Secret Manager (`<key>-mongodb-uri`, `<key>-jwt-secret`, `<key>-smtp-pass`, each `CONNECTION_*` the profile names) and, for each missing one, a prompt: "Paste the MongoDB connection string" (password field; written straight to `gcloud secrets versions add --data-file=-`; never logged, never saved). Any failure stops here with a one-line reason and the fix.
2. **Kit**: `src/profile/kit.ts` writes `<workspace>/<key>/.build/<env>/` with `profile.json`, `environment.json`, `files/`, `data/`, `deploy/kit.env`, and `app-source.tar.gz` for the chosen version.
3. **Image**: `gcloud builds submit app-source.tar.gz --tag <region>-docker.pkg.dev/<project>/fleet/fleet-erp:<version>` if not already built (today's `gcp-all.sh` logic).
4. **Infrastructure and service**: `deploy/new-company.sh deploy/kit.env <version>` with `KIT_DIR` set: service account, bucket (versioned), secrets mounted, NAT (if `egress: static`), Cloud Run service with `COMPANY_CONFIG=/mnt/bucket/kit/profile.json`, `COPY_PURPOSE`, `TRIAL_ENDS`, jobs + Scheduler, LB or mapping, uptime check, error alert, budget. All idempotent, as today.
5. **Wait and verify**: poll `https://<url>/api/v1/health/ready` for `"mongo":"connected"`; read `GET /api/v1/installation/about` (public facts only: product name, purpose, version, `appliedRevision`) and compare with the profile's `revision`; show the log lines `Company file applied` with any `failed` steps.
6. **Record**: write `deployed {version, at, revision, url}` into the environment file; commit to the workspace repo; append the full log to `runs/<date>-<env>.log`.
7. **Hand-over sheet** (shown and saveable as `.md`): the URL, the owner's e-mail and how they get in, the DNS record if a domain, the Atlas address to allow, what to check tomorrow.

Everything in steps 3–4 is the scripts that exist; the CLI adds preflight, prompting for secrets without storing them, waiting, verification and record-keeping, which is what makes it runnable by one non-expert.

### 5.7 Drift: detection and reconciliation

Three artefacts exist for every copy: **P** the profile in Studio (revision *r*), **A** the last applied profile stored in the copy (`SystemState['company-file'].value.file`, revision *a*), and **L** the live export (`fromInstallation()` now, including `appliedRevision: a`).

- `fleet pull <key> <env>` (or Studio *Pull*) fetches `GET /installation/export` as the owner (token obtained for the call and discarded), or accepts a file the owner downloaded from "This installation".
- `src/profile/diff.ts` computes, per section and per keyed item (same keys `upsert()` uses: `code`, `key`, `entity.key`, e-mail): `same`, `app-changed` (L ≠ A, P = A), `studio-changed` (P ≠ A, L = A), `conflict` (both differ, and differ from each other), plus `only-in-app` and `only-in-profile` items. Items never deleted by apply show as `only-in-app` and are simply adopted.
- Studio shows the report as a table by section with counts and a drawer per item (before / after). Defaults: **adopt** app changes into P (the app is the source of truth for company-editable sections); **keep Studio's** for `vendor.lockedSections`; conflicts need a click each, with "Take the app's" / "Keep Studio's". Adopting bumps the revision and commits.
- Apply (push) is always previewed by the Runtime's own dry run (`POST /installation/apply/preview`), so what Studio predicts and what the copy will do are the same code path.
- Scheduled check: Studio's *Running* tab calls `GET /installation/about` (public) for each cloud environment on open: version, purpose, `appliedRevision`, health. `appliedRevision < revision` → "Behind: 2 revisions not applied"; `appliedRevision === revision` but `lastExportHash` differs from the last pull → "Changed in the app since last pull" (the Runtime stores a hash of its own export, recomputed by a nightly job or on demand, so the public endpoint reveals only a hash).

This keeps the rule from §3: the database runs the company; the profile moves and seeds it; neither silently overwrites the other.

---

## 6. UI and UX

### 6.1 Studio

Desktop first; the same kit components (`web/src/ui/kit.tsx`), tokens and rules (`docs/ui-rules.md`). No marketing look: it is a workbench.

**Companies** (home). A framed table, not cards: Company · Key · Environments (each a small badge: "demo-local · running", "trial · 9 days left · v fa4f303", "production · behind by 2") · Last changed · Notes. Buttons above the table on one line: *New company*, *From template*, *Import a file* (format 1 or 2), *Open workspace folder*. A **Tools** line at the bottom of the sidebar: Node ✓ · Docker ✓ running · gcloud ✓ signed in as … · atlas – not installed (link). Each a word and a state, no icons in tiles.

**Company page.** Left rail = today's wizard rail (Company, Region, Brand, Areas, Masters, How it works, People, Connections, Data, **Environments**, **Running**, **History**). Main = the step's content, exactly today's `Steps*.tsx`, as a long settings page with one save bar ("Discard · Save as revision 15"). Problems appear on the rail as today. The *Start* step is gone: "demo or real" is no longer a property of the company.

- **Environments** step: numbered cards (demo-local, trial, production…), *Add environment* below, each with the target's fields from `TARGET_FIELDS` (today's `WhereStep`), purpose as a Segmented choice (Demonstration / Trial / Production), trial end date when Trial, and the "deployed" facts read-only. Buttons per card: *Run locally* (local target) or *Deploy*, *Download kit for Cloud Shell*, *Open*, *Pull*, *Reset* (demo only), *Promote…* (trial only).
- **Deploy panel** (opens from a card): a checklist that fills in live (preflight items with ✓ / ✗ and the fix), a log pane streaming the script's `== step` lines, the final hand-over sheet. Secrets are asked for in password fields *inside the preflight item that needs them*, with the sentence "Sent straight to Secret Manager. Studio keeps nothing." A *Show the commands instead* link prints what it would run, for anyone who prefers a terminal.
- **Running** tab: one framed line per environment with version, purpose, health, applied revision, last pull, and the drift verdict; a *Pull and compare* button opens the drift report (table by section; conflicts need a choice).
- **History**: the git log of the company's folder, each line a revision or a deploy run; clicking shows the diff in words (reuses the drift renderer).

**Templates**: `studio/templates/<name>/profile.json` in the repo (made-up companies only: the sample operation as "Fuel tankers, Southern Africa", a part-load "Courier, India" using counted cargo and many consignments once that work lands, and "Empty").

### 6.2 Runtime

**First run** (`web/src/firstRun/FirstRun.tsx`), shown only when no company exists and no `COMPANY_CONFIG` applied: one short page: legal name, country (fills currency, time zone, formats), your e-mail is the owner; two buttons: *Start* (starter lists) and, when `COPY_PURPOSE=demo`, *Start with the sample operation*. A line underneath: "Setting up a company for someone else? That is done in Fleet Studio, not here." Developers running `npm run dev` get this instead of the 13-step wizard.

**"This installation"** (`web/src/masters/Installation.tsx`, under Masters → Organisation, for `company:update`; owner-only actions marked):
- Facts in one framed line: Product name · Purpose (Demonstration / Trial until 26 Nov / Production) · Version `fa4f303` · Profile revision 14 applied 12 Nov · Database: connected · Files: Google Cloud Storage.
- *Export configuration* (owner): downloads `<key>-profile.json` plus a zip with logos; text: "Your company's configuration, without passwords or keys, for your provider or for your records."
- *Apply a configuration file* (owner): choose a file → preview table (what would be created / updated / left alone) → *Apply*. Text: "Only what the file changes is applied. Settings you have changed in the app keep their values unless the file changes that same setting. Nothing is ever deleted."
- *Reset this demonstration* (owner; **only rendered when `COPY_PURPOSE=demo`**; confirm by typing the name): "Removes everything and loads the demonstration again. Not possible on a trial or production copy." On trial/production copies the section does not exist, so the question never arises.
- *Locked by your provider*: the list of locked sections with the reason, and a line "Ask your provider to change these."

**Banners from the environment**: sign-in page and sidebar footer say "Demonstration copy: made-up data" or "Trial copy · 9 days left" (today's `signin-demo` note, driven by `COPY_PURPOSE`/`TRIAL_ENDS` from `GET /meta/overview`-style public facts instead of `SystemState['sample-data']`). Production shows nothing.

### 6.3 How today's confusing cases go away

- **"Set up a company" on a real copy**: the item no longer exists on a copy with a company. There is "This installation", which describes the copy and offers export/apply. Setting up *another* company happens in Studio, which the owner never sees.
- **"A demonstration" on a real copy**: there is no such choice anywhere in the Runtime. Purpose comes from the environment the vendor deployed. A trial or production copy has no Reset; a demo copy's Reset works every time because it clears the applied state before re-applying.
- **Packaging another company from your demo**: Studio holds many profiles; your demo copy is untouched.
- **`SETUP_PACKAGES`**: gone. Export is harmless and owner-only; kits are made by Studio and the CLI.
- **Three GCP front doors**: one (`fleet deploy`, with Studio's button over it) for vendor-hosted, one kit for customer-hosted, both running the same scripts.

---

## 7. Secrets, versions and the rules that bind

- **The app never holds secrets.** Runtime: unchanged (names in connections, values in env/Secret Manager). Studio: holds none on disk or in its workspace; secret values typed into a preflight prompt go to `gcloud secrets versions add --data-file=-` via stdin and out of memory. The kit's `.env.example` stays blank. If the owner decides Studio must not even *handle* a value, the "Show the commands instead" mode prints the `gcloud secrets` command for the operator to run in a terminal; both modes exist, one is default (decision 1 in §10).
- **Cloud credentials.** Studio uses the operator's `gcloud` login on the operator's machine, like `git` uses the operator's SSH key. It stores no token. Lakshya's earlier ruling (#103) was that *the company's app* gives instructions and does not deploy; Studio is a different program running on the vendor's machine, and this is the thing to confirm (decision 1).
- **Versions.** The image tag is the git short SHA (as today); never `latest`. `environments/*.json.deployed.version` records what runs where; `GET /installation/about` confirms it. DB migrations stay forward-only on start (`Migration` model); the preflight for a production upgrade insists on a snapshot step.
- **No new libraries** in the Runtime. Studio's server is Express (already a dependency); spawning `docker`, `gcloud`, `atlas`, `mongodump` is `node:child_process`. `simple-git` would be convenient for the workspace history but `git` via `execFile` is enough; proposing none.
- **Founding principle.** Nothing multi-company enters the Runtime. Studio is the only place that knows more than one company, and it is not a product the transporter runs.

---

## 8. What this does *not* change

- The company app's screens, desks, masters, connections and how the admin edits them.
- `apply.ts`'s three-way semantics (extended with dry run and the environment split, not replaced).
- The deploy scripts and their idempotency; the Cloud Shell path; `docs/deploy/*` guides per platform (updated for two files instead of one).
- The founding principle, the stack, the UI rules.

---

## 9. Phasing: PR-sized steps

Each PR: one issue, branch `<agent>/<issue>-<slug>`, CI green, tests named. Order matters; 1 is useful alone.

### Phase 1: "This installation", purpose from the environment, a demo that resets (area: masters + deploy)

Fixes the three bugs without moving the wizard yet.

- `src/config/env.ts`: add `COPY_PURPOSE`, `TRIAL_ENDS`, `DEMO_IN_PRODUCTION`; production refuses `COPY_PURPOSE=demo` unless `DEMO_IN_PRODUCTION=true`. Deprecate `SETUP_PACKAGES` (read, warned, ignored).
- `src/modules/setup/setup.service.ts`: replace `mayClear`/`clearCopy`/purpose checks with `resetDemo()` (drop collections except acting owner + sessions + `owner-claimed`; delete `SystemState['company-file']`; re-apply `COMPANY_CONFIG` if set, else re-load the sample at the size last used; re-make demo logins). `applyHere` loses `clear`. `setupStatus` returns `purpose`, `trialEnds`, `version`, `appliedRevision`.
- `src/modules/setup/apply.ts:504`: sample runs when `!last` (the reset makes that true); no more `last.file.data.sample !== 'none'` skip.
- Kit (`src/modules/setup/kit.ts`): `.env.example` and `deploy/kit.env` write `COPY_PURPOSE` from `purpose` (`demo` → `demo` + `DEMO_IN_PRODUCTION=true` on cloud targets; `real` → `production`). `deploy/new-company.sh` passes both env vars.
- Web: new `web/src/masters/Installation.tsx` ("This installation": facts, Export, Apply a file with preview *in Phase 3*, Reset when demo). `web/src/Office.tsx`: remove the two sidebar buttons; the wizard opens only from `App.tsx` when `!hasCompany` and from Installation → "Set up again" **only when demo**. `web/src/setup/StepsCompany.tsx` `StartStep`: when a company exists, the purpose choice is not shown (purpose is read from status and displayed as a fact). Sign-in banner reads purpose from status.
- Acceptance: on a copy with a company, the sidebar has "This installation" and no "Set up a company"; on `COPY_PURPOSE=production` there is no Reset anywhere and `POST /setup-kit/reset` is 403; on a demo copy Reset twice in a row both reload the sample (test asserts vehicle count after each); a format-1 kit with `purpose: demo` deploys with `COPY_PURPOSE=demo`; production start with `COPY_PURPOSE=demo` and no `DEMO_IN_PRODUCTION` is refused (hardening test).
- Tests: `tests/setup-guided.test.ts` (reset twice; no reset on production; purpose in status), `tests/hardening.test.ts` (env refusal), `tests/setup-kit.test.ts` (env template lines).

### Phase 2: `src/profile/` and format 2 (area: deploy)

- Move `companyFile.ts`, `kit.ts`, `guide.ts`, `csv.ts`, `zip.ts` to `src/profile/` with no `env`/Mongoose imports; split `deploy`+`purpose` into `src/profile/environment.ts`; `src/profile/migrate.ts` 1→2; `src/profile/index.ts`.
- `src/jobs/kit.ts` → `src/cli/fleet.ts` with `check`, `kit`, `migrate` (keeps `npm run kit` as an alias).
- Runtime reads `COMPANY_CONFIG` as format 1 or 2 (migrating in memory) and `environment.json` beside it if present.
- Acceptance: `fleet migrate tests/fixtures/kit/company.json` writes `profile.json` + `environments/compose.json` that validate; `fleet kit` from them reproduces today's zip contents (test compares entry lists); CI `kit` job unchanged and green; `tests/no-hardcoded-brand.test.ts` still passes.
- Tests: `tests/profile.test.ts` (schema, migration fixtures, kit entries), `tests/cli.test.ts`.

### Phase 3: dry-run apply and the installation API (area: masters)

- `apply.ts`: `applyFile(..., {dryRun: true})` returns the plan (same `Result[]` shape with `would` outcomes) without writing; records `appliedRevision`, `appVersion`.
- New router `/api/v1/installation`: `GET /about` (public facts), `GET /status`, `GET /export` (owner), `POST /apply/preview`, `POST /apply` (owner, NDJSON), `POST /reset` (owner, demo). `/setup-kit/*` kept as aliases for one release.
- Installation page gains *Apply a configuration file* with the preview table.
- Acceptance: preview of a changed profile lists exactly the steps the real apply then performs (test runs both and compares); export carries `appliedRevision`; `/about` exposes no e-mails or settings.
- Tests: `tests/installation.test.ts`.

### Phase 4: Studio, local (area: web desks + tooling)

- `studio/server/*`: workspace folder (`FLEET_WORKSPACE`, default `~/fleet-companies`), profiles CRUD as files with git commits, `check`/`kit` via `src/profile`, `tools.ts` detection, `local.ts` (compose up/down/status/logs for the `local` target), demo logins passthrough.
- `web/studio.html` + `web/src/studio/*`: move `web/src/setup/*` steps; Companies table; company page with rail; Environments step with demo-local; Tools line. `npm run studio` builds and serves on 127.0.0.1:4000; `studio.command`/`studio.bat`.
- Runtime: remove the wizard beyond first run (`web/src/firstRun/FirstRun.tsx`); `PackagePage.tsx` removed; Office sidebar unchanged from Phase 1.
- Acceptance: from an empty workspace, make a company from the template, run it locally, sign in with the demo logins, reset it, stop it, without a terminal; the Runtime image contains no `studio` chunk (CI greps `web/dist`); two companies can be drafted at once.
- Tests: `tests/studio.test.ts` (server API with a temp workspace; git commit per save; kit built), `web/scripts/check-ui.mjs` on the Studio stylesheet; CI job runs `fleet up` on the fixture profile (replaces part of the `kit` job).

### Phase 5: `fleet deploy` and Studio's Deploy panel (area: deploy)

- `src/cli/commands/{preflight,deploy,secret,rollback,backup,restore}.ts` wrapping `deploy/*.sh`; streaming to the terminal and, through `studio/server/deploys.ts`, to the browser; writes `deployed` into the environment file; `runs/*.log`.
- Studio Deploy panel, hand-over sheet, "Show the commands instead".
- `docs/studio.md`; `docs/deploy/gcp.md` updated for `profile.json` + `environment.json`.
- Acceptance: `DRY_RUN=1 fleet deploy acme trial` prints every command with no gcloud login (CI); preflight fails clearly with no gcloud, with no login, with a 25-char key, with a missing secret; a run against a real project (owner-provided) reaches `health/ready` and records `deployed` (manual, reported in the PR as not CI).
- Tests: `tests/cli.test.ts` (dry run output, preflight failures via stubbed `which`), `tests/profile.test.ts` (environment schema per target).

### Phase 6: Pull, diff and drift (area: deploy + masters)

- `src/profile/diff.ts`; `fleet pull`, `fleet diff`; Studio *Running* tab and drift report with adopt / keep / per-conflict choice; Runtime stores an export hash for `/about`.
- Acceptance: change brand in the app and areas in Studio → report shows `app-changed: brand`, `studio-changed: areas`; change the same list in both → `conflict`, needs a choice; after adopt, revision bumps and the next preview is empty.
- Tests: `tests/profile.test.ts` (diff cases), `tests/installation.test.ts` (export hash), `tests/studio.test.ts`.

### Phase 7: lifecycle extras (area: deploy)

- `fleet promote trial production`; trial banner and `TRIAL_ENDS` behaviour (what happens at expiry is a setting: nothing / read-only / sign-in notice; default: notice only); templates folder; *Duplicate*; `fleet backup/restore` drills documented with a run that was actually done; optional GitHub Actions workflow template with WIF (`deploy/github/deploy.yml`) for the vendor's project, marked "not run in CI" until it has been.
- Acceptance: promote keeps the database (test on compose: same records after); expiry notice shows at `TRIAL_ENDS - 3d`; restore into demo-local works from a backup made by the CLI.

### Phase 8: retire and document

- Remove `/setup-kit/*` aliases, `SETUP_PACKAGES`, `web/src/setup/*`; update `README.md` (Deploying a company's copy → Studio and the kit), `docs/FEATURES.md`, `AGENTS.md` area table (`area: studio` → `studio/*`, `web/src/studio/*`, `src/profile/*`, `src/cli/*`).

---

## 10. Decisions that need the owner

1. **May Studio run `gcloud` for the operator?** It runs on the vendor's machine under the operator's own login and stores nothing; the alternative is instructions-only (print the commands). The design offers both, with "run it" as the default. Your #103 ruling covered the company's app; this is the vendor's tool.
2. **Trial → production: same copy (keep the database) or a fresh deploy?** The design defaults to the same copy, because the transporter will have entered real trucks and trips during the trial. Confirm.
3. **What happens when a trial ends?** Default proposed: a notice from three days before, nothing enforced. Alternatives: read-only, or sign-in blocked with a message. It is a setting either way.
4. **Where does the vendor's workspace live?** A private git repository (`fleet-companies`) on the vendor's GitHub is proposed; it will hold company names, e-mails, phone numbers and logos (no secrets). Confirm that is acceptable, and who may read it.
5. **Cloud demos for sales (a demo copy on Cloud Run with `DEMO_IN_PRODUCTION=true`)**: wanted now, or local demos only until a real company is live?

---

## 11. Decided (lakshya-desktop for Lakshya, 10 Nov 2026)

Lakshya left the basis to the orchestrator ("that's your call, you decide"). Option (c) is adopted: one codebase, a vendor tool (Studio) as its own entry point and build, a slimmer company app (Runtime), and a shared profile library.

| # | Decision |
|---|---|
| 1 | Studio runs `gcloud` for the operator by default, under the operator's own login and storing nothing; "Show the commands instead" stays. |
| 2 | Trial → production keeps the same copy and its database (`fleet promote`). |
| 3 | When a trial ends: a notice from three days before, nothing enforced. A setting allows read-only or a sign-in notice. |
| 4 | Company profiles live in a private `fleet-companies` repository readable by the team only; never secrets. |
| 5 | Cloud demos for sales are wanted now: a demo copy on Cloud Run with `DEMO_IN_PRODUCTION=true` that resets itself. |

**Built as three large pieces, one agent and one PR each** (the team works in big pieces since 5 Nov):

| Piece | Phases | What ships |
|---|---|---|
| A. The company app knows what it is | 1 + 3 | "This installation" page; purpose from the environment; a demo that resets (fixes the 8 Nov demo bug); preview-then-apply of a configuration file; the installation API |
| B. Studio, local | 2 + 4 | The profile library and format 2; the `fleet` CLI; Studio on the vendor's laptop: many companies, run a demo locally, no terminal needed; the wizard leaves the company app |
| C. Deploy and keep in step | 5 + 6 + 7 + 8 | `fleet deploy` and Studio's Deploy panel for Google Cloud; pull, diff and drift; promote trial → production; trial notice; backups; retire the old set-up paths |

A first, then B, then C. A can run alongside the consignment work.
