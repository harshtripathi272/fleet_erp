# Trip desk architecture

## Layout

| Path | What it holds |
| --- | --- |
| `src/domain/types.ts` | Masters, records and the `Action` union. |
| `src/domain/engine.ts` | `apply(data, action, role, at?)`. It deep-copies the data, checks the rule, mutates the copy and posts WhatsApp messages. Refusals are thrown as `Refusal` with a plain sentence. |
| `src/domain/calc.ts` | Pure helpers: road legs, fuel estimate, funding suggestion, the 20 °C correction, shortage, currency and driver ledger. |
| `src/domain/turn.ts` | `nextStep(data, trip)` returns whose turn it is, the move and the waiting text. `queueFor(desk)` builds each desk's queue. |
| `src/domain/reading.ts` | Deterministic simulated reading of invoices, delivery notes and receipts. |
| `src/domain/seed.ts` | Masters, plus a history built by replaying real engine actions, so the seed can't drift from the rules. |
| `src/store.tsx` | Shared state (`marichi.tripdesk.v4` in `localStorage`, synced by `BroadcastChannel`), the desk in `sessionStorage`, and the app context. |
| `src/desks/` | Trips (list, stepper, next-step bar, one panel per stage), Finance, Driver accounts, Nominations, Masters, Owner overview, Driver desk. |
| `src/phone/` | Phone frame, WhatsApp, gallery and attach sheet, desk phone and notification banner. |
| `src/tracking/` | MapLibre tracking view, drive simulator, dashcam, small route maps. |
| `src/docs/` | A4 trip sheet and driver statement with print styles. |

All changes go through `apply`. The UI never edits records directly, so every desk sees the same rules and the same messages.

## Records

- **Trip**: truck, trailer, driver, customer, ordered stops (start, loading, via, offloading, end) with road kilometres, fuel and cash budget, opening and closing fuel, tracking position.
- **Fund request**: fuel in litres or cash in ZMW or USD. Status goes pending, then with the owner if above the suggestion, then approved, then issued with the payment method and reference. It can also be rejected or cancelled.
- **Driver document**: a photo or file sent by the driver, with its simulated reading. Operations accepts or returns it with a reason.
- **Consignment**: the loading and delivery measures from the invoice and delivery note. For fuel cargo it keeps the observed litres, temperature and density, plus the 20 °C volume.
- **Shortage**: loss at 20 °C, the product's allowance, net short litres and value. Finance charges or waives it.
- **Expense**: a receipt, recorded against the driver and approved or rejected by Finance.
- **Settlement**: a periodic statement across several closed trips. It freezes the driver's ledger lines and the cash handed in or paid out.
- **Nomination**: a customer's request for trucks. It is sent to the customer, accepted, and converted into trips.

## Rules worth knowing

- **Whose turn.** `nextStep` is the single source of the next action. The trip list, the next-step bar, the desk queues and the WhatsApp buttons all read from it, so there's never a second button for the same move.
- **Funding suggestion.** The fuel suggestion is the budget minus fuel in the tank, issued fuel and requests in flight, capped by the tank's free space. The cash suggestion is the budget minus cash the driver already holds, cash issued and requests in flight. Anything above the suggestion needs a reason and goes to the Owner.
- **Road walls.** Tracking can't pass the loading point before the load is recorded, or the offloading point before delivery. Stops passed between pings get times spread by distance.
- **20 °C correction.** This uses the API MPMS 11.1 form, iterating on density. The shortage is the loaded 20 °C volume minus the delivered 20 °C volume, less the product's allowance (a product master field, 0.3% by default), priced at the product's rate.
- **Driver ledger.** A positive balance means the driver holds company cash, and a negative one means the company owes the driver. Advances, approved expenses, shortage charges and settlements are all ledger lines. A settlement covers any set of closed trips for one driver.

## Configuration extension

`src/configuration/schema.ts` describes the eight existing master contracts. `engine.ts` resolves company overlays/custom masters, validates definitions and record values, evaluates structured calculations and ordered save rules. `state.ts` adapts the current single-company `AppData` without importing React.

Configuration draft/publish, custom save/archive and existing master writes all pass through `domain/engine.ts:apply`. `AppData.configuration` stores active/draft/version history and `customRecords` stores custom entity records. Both are optional, preserving existing v4 browser data. The owner publishes; operations and the owner enter custom records; finance keeps its existing product/category scope.

`Studio.tsx` edits and previews definitions. `Fields.tsx` renders both sample forms and published master forms. `Masters.tsx` retains specialized route-stop/pairing UI and the original domain checks, while resolving labels, fields and columns from metadata. Core fields and references remain stable; archive custom values instead of deleting them. Linked master records cannot be deleted.

The local role checks are demo behavior, not authentication. Production must enforce permissions and tenant isolation on the server, use shared validation for every ingress, and add existing-data checks/migrations before publication. See [the configuration plan](../reference/planning/configuration-architecture.md).

## Open questions for the owner

1. What allowance applies to fuel cargo? The meeting said about 3%, a legacy screen shows 0.03%, and the mock defaults to 0.3%. It is editable per product in Masters.
2. Which payments and documents must be in place before dispatch?
3. Does one trip ever carry several consignments or drops?
