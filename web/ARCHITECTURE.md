# Frontend architecture

## Layout

| Path | What it holds |
| --- | --- |
| `src/api/client.ts` | `api(path, options)`: bearer token, one shared refresh on a 401 (refresh tokens are single use), one retry, then sign-out. Errors come back as `ApiError` with the API's message. |
| `src/api/session.tsx` | The signed-in person (`/auth/me`), `can()`, which desks to offer, and the sign-in screen. |
| `src/api/adapter.ts` | `toAppData(reference, operations)`: turns API records into the shapes the screens use. Amounts arrive in minor units and leave in major units of the company's base currency. |
| `src/api/commands.ts` | `runCommand(action)`: one API call for each `Action` a screen takes. Amounts go back to minor units and currency codes to ids. |
| `src/store.tsx` | TanStack Query: masters and settings reloaded every minute, trip-side records read incrementally from `/operations/sync` every 4 seconds. Also the app context (`run`, `nav`, toasts, overlays). |
| `src/domain/` | Types, read-only helpers, the calculations the screens show before saving (road legs, 20 °C correction, shortage preview, funding suggestion) and `nextStep` for whose turn it is. The API recomputes everything it stores. |
| `src/desks/` | Trips (list, stepper, one panel per stage), New trip, Nominations, Finance, Driver accounts (settlements), Owner overview, Driver desk. |
| `src/consignments/` | A trip's consignments: the booking rows and the rate choice (`RateChoice.tsx`: rate contract or another rate), the drawer, loading and delivery at a stop (`StopWork.tsx`), splits, refusals, revenue and profit panels, the Consignments list and report. |
| `src/billing/` | Invoices and Company → Money (exchange rates, tax, invoicing). |
| `src/settings/`, `src/setup/` | Connections (simulated or real e-mail, WhatsApp, SMS, maps, GPS) and message templates; the company set-up. |
| `src/masters/MastersScreen.tsx` | One generic list, detail and form for every master, built from `GET /meta/masters`: fields, links, company fields with their choices, custom masters and their records, usage and history. A few masters add an extra on top (pairings, numbering series, message templates, a truck's place and fuel). |
| `src/masters/CompanyPanel.tsx`, `FreightSettings.tsx` | The company record: names, country, base currency, modules and the operations settings; Company → Freight (everyday settings first, the rest under "More"; settings not acted on yet aren't shown). |
| `src/phone/` | Phone frame, WhatsApp threads, attach sheet with sample photos, the desk's phone. |
| `src/tracking/` | Map, drive simulator that reports positions to the API, dashcam, small route maps. |
| `src/docs/` | A4 trip sheet and driver statement with print styles. |

## How a change happens

A screen calls `run(action)`. `runCommand` sends it to the API, the store re-reads `/operations/sync`, and every desk sees the result on its next poll. Refusals come back as the API's own sentence and show as a toast. Screens never change records themselves, so the rules live in one place: the API.

What each person sees is filtered by the API. Message threads, queues and approvals follow permissions and the approval policies, not desk names.

Which buttons show follows the same rules. `ACTION_PERMISSION` in `src/api/session.tsx` names the permission each action needs, as `operations.router.ts` checks it, and `useMay()` asks it for the signed-in person. Approving a money request or an expense also needs the approval policy to name the person for a waiting level (`mayDecide` on the record, worked out in the adapter by the API's rule). A desk's "your turn" (`useMine` in `desks/Trips.tsx`) needs both: the step is that desk's, and the person may take it. Buttons inside chat messages follow the same check.

## Still open

- **Waivers and settlements under a policy.** Waiving a shortage and posting a settlement show by permission (`shortage-decisions`, `settlements`). When a company adds an approval policy for either, the API decides who may by amount, and the screen doesn't mirror that yet: it would need the API to say who may waive or settle, as it does with `mayDecide`.
