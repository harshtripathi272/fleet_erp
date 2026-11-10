# Consignments phase 1: the API contract

Marichi Fleet · #135 · server side by `lakshya-desktop`, screens by `lakshya-t3`. This file is the contract between the two branches. It follows design 3.12 (`docs/design/consignments.md`); where it differs, the row says so and why. A change to the contract changes this file in the same commit.

Every route is under `/api/v1`, needs a signed-in user, and answers in the house envelope:

```json
{ "success": true, "data": { … }, "message": "Loading recorded" }
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Record the loading first.", "details": { … } } }
```

Paged lists add `meta: { total, page, limit, pages }`. Refusals are plain sentences for the screen: 422 (`VALIDATION_ERROR`) when the input or a rule says no, 409 (`CONFLICT`) when the record is in the wrong state or was changed by someone else, 403 when the role does not allow it, 404 when it is not there.

**Money** is `{ amountMinor, currencyId }`. **Dates** are ISO strings. Sub-records (lines, legs, documents, stops, revenue lines) carry `id`.

**Who sees money.** Rates, revenue and profit need the sensitive switch on the area: `consignment-revenue: sensitive` and `trip-profit: sensitive`. Owner and Finance have it by default; Operations and Viewer do not. Without it, `revenue` is left out of every consignment (lists, sync, the drawer), money columns are left out of the report, and the profit routes answer 403. Design 3.6.3 says "trip-profit (read)"; it is the sensitive switch instead because the built-in Operations role reads everything (`*: read`) and must not see money.

Status: ✅ on origin and working · 🟡 on origin, part of it still landing (the row says what) · ⬜ not on origin yet.

## 1. The consignment

### Shape (`GET /consignments/:id`)

```json
{
  "id": "6730…a1", "number": "CN/26/0012", "version": 4,
  "consignmentTypeId": "672f…10", "status": "delivering",
  "customerId": "672f…c1", "consignorPartyId": "672f…c1", "consignor": null,
  "consigneePartyId": null, "consignee": { "name": "Puma Energy Kabwe depot", "phone": "+260977000111" },
  "brokerPartyId": null, "paymentTerms": "to_be_billed",
  "tripId": "6730…t1",
  "movements": [{ "tripId": "6730…t1", "from": "2026-11-04T06:10:00.000Z", "reason": "assigned", "by": "672f…u1" }],
  "bookedAt": "2026-11-04T06:10:00.000Z", "loadedAt": "2026-11-05T09:30:00.000Z", "deliveredAt": null, "leadKm": 1961,
  "lines": [{ "id": "6730…l1", "productId": "672f…p1", "plannedQty": 38000, "unit": "L", "description": "Diesel 50 ppm" }],
  "legs": [
    { "id": "6730…g1", "kind": "pickup", "sequence": 1, "placeId": "672f…pl1", "stopId": "6730…s2", "tripId": "6730…t1", "status": "done",
      "actual": [{ "lineId": "6730…l1", "qty": 38000, "unit": "L", "ambientL": 38000, "tempC": 28, "density": 835, "vcf": 0.99279, "std20L": 37726 }],
      "recordedAt": "2026-11-05T09:30:00.000Z", "recordedBy": "672f…u2" },
    { "id": "6730…g2", "kind": "drop", "sequence": 2, "placeId": "672f…pl4", "stopId": "6730…s5", "status": "done", "outcome": "delivered",
      "planned": [{ "lineId": "6730…l1", "qty": 9500 }], "actual": [{ "lineId": "6730…l1", "qty": 9500, "unit": "L", "certStd20L": 9431 }],
      "pod": { "number": "PUMA-DN-551", "receivedBy": "J. Banda", "docIds": ["6730…d9"] } },
    { "id": "6730…g3", "kind": "drop", "sequence": 3, "placeId": null, "stopId": null, "status": "planned", "planned": [{ "lineId": "6730…l1", "qty": 28226 }] }
  ],
  "documents": [{ "id": "6730…k1", "documentTypeId": "672f…dt1", "label": "Loading invoice", "number": "TPA-INV-55120", "legId": "6730…g1", "driverDocId": "6730…d1", "at": "…", "by": "672f…u2" }],
  "references": { "customerRef": "PO-7781", "lrNo": "LR-0091", "sealNos": ["S-1", "S-2"] },
  "revenue": { "status": "estimated", "tariffId": "672f…tf1", "tariffVersion": 3, "currencyId": "672f…usd", "pricedOn": "2026-11-05T09:30:00.000Z",
    "basis": { "chargeOn": "delivered", "qty": 37726, "unit": "L at 20 °C", "drops": 2, "estimated": true },
    "lines": [{ "id": "6730…r1", "chargeTypeId": "672f…ct1", "kind": "freight", "description": "Freight, per litre at 20 °C", "qty": 37726, "unit": "L at 20 °C", "unitPriceMinor": 8.5, "amountMinor": 320671, "taxPercent": 0, "taxMinor": 0, "source": "tariff", "accepted": true }],
    "subtotalMinor": 320671, "taxMinor": 0, "totalMinor": 320671, "baseSubtotalMinor": 8722251, "baseTotalMinor": 8722251, "rateToBase": 27.2,
    "explanation": ["Tariff PUMA-DAR-ZM v3 (customer and route matched).", "…"], "problem": null },
  "shortage": null, "outcome": null, "custom": { "sealNo": "S-1" },

  "productId": "672f…p1", "invoiceNo": "TPA-INV-55120",
  "load": { "qty": 38000, "unit": "L", "ambientL": 38000, "tempC": 28, "density": 835, "vcf": 0.99279, "std20L": 37726 },
  "delivered": null, "inTransit": true, "writeOff": null, "returned": null, "transfers": null
}
```

- `status`: `draft · booked · assigned · loading · loaded · in_transit · delivering · delivered · closed · cancelled · returning · returned · written_off`, worked out from the legs on every save (design 3.2.1).
- A leg with `placeId: null` is a drop **to be confirmed** (a late split); it has no stop yet.
- `consignor` / `consignee` are inline contacts `{ name, phone?, whatsapp?, email?, address?, taxId? }` when there is no party record.
- **For one release** (design 3.10) the last block repeats the first goods line's totals in today's shape: `productId`, `invoiceNo`, `load` (everything loaded), `delivered` (everything delivered, with `at` and `podNo`, once every drop is in), `inTransit`, and `writeOff` / `returned` / `transfers` (from `outcome`). New screens should read `lines`, `legs`, `documents` and `outcome`.
- A record route also returns `checks: { capacity: { notes: [string], warnings: [string] } }` (see 2.4).

### Routes

| | Method and path | Permission | Body | Answers |
|---|---|---|---|---|
| ✅ | `GET /consignments` | `consignments: read` | query below | paged consignments |
| 🟡 | `POST /consignments` | `consignments: create` | `createConsignmentSchema` (1.1), or today's loading body (2.5) (the old body works now; the new one lands with the routes of section 1) | 201, the consignment |
| ✅ | `GET /consignments/:id` | `consignments: read` | — | the consignment |
| ⬜ | `PATCH /consignments/:id` | `consignments: update` | `updateConsignmentSchema`: `version` and any field of 1.1 but `tripId` and `legs` | the consignment |
| ⬜ | `PUT /consignments/:id/legs` | `consignments: update` | `putLegsSchema` (1.2) | the consignment |
| ⬜ | `POST /consignments/:id/cancel` | `consignments: update` | `{ version, reason }` | the consignment |
| ✅ | `POST /trips` | `trips: create` | today's body plus `consignments: [inlineConsignment]` (1.1 without `tripId`) | 201, the trip |

Query of `GET /consignments`: `page`, `limit` (≤ 100), `tripId`, `status` (comma list), `customerId`, `consignorPartyId`, `consigneePartyId`, `productId`, `revenueStatus` (`unpriced|estimated|priced|frozen|invoiced`), `podMissing` (`true`), `from`, `to`, `dateField` (`booked|loaded|delivered`, default `booked`), `q` (number, references, document numbers, party names, trip number), `shortage` (`pending|charged|waived|none`, as today), `tab` (`all|to_load|on_road|to_deliver|waiting_pod|unpriced`, the list tabs of 3.11.6). With `tripId` the order is booking order; otherwise newest loaded first.

#### 1.1 A new consignment

```json
{
  "tripId": "6730…t1",
  "consignmentTypeId": "672f…10",
  "customerId": "672f…c1",
  "consignorPartyId": "672f…c1",
  "consignee": { "name": "Puma Energy Kabwe depot", "phone": "+260977000111" },
  "paymentTerms": "to_be_billed",
  "lines": [{ "productId": "672f…p1", "plannedQty": 38000, "description": "Diesel 50 ppm" }],
  "legs": [
    { "kind": "pickup", "placeId": "672f…pl1" },
    { "kind": "drop", "placeId": "672f…pl4", "planned": [{ "line": 0, "qty": 38000 }], "contact": { "name": "Storeman", "phone": "+260…" } }
  ],
  "references": { "customerRef": "PO-7781" },
  "custom": {}
}
```

- Every field but `tripId` and `lines` may be left out. Left out: the customer is the trip's; the consignor is the customer (Company → Freight `consignorDefault`); the consignee is the customer unless a `consignee` contact or `consigneePartyId` is given; the type is Company → Freight's, else the trip type's, else Bulk liquid for a volume-corrected product and Full load otherwise.
- `legs` left out: one pickup at the trip's next loading stop and one drop at the offloading stop after it, which is today's one load and one drop. A leg may name a `stopId` instead of a `placeId`. `planned[]` names a goods line by `lineId` or by its position `line` in `lines`.
- Each leg is put on a stop at its place (design 3.3): an existing loading or offloading stop the truck hasn't passed, else a new stop where it adds least distance, before the end. The trip's km are worked out again; after dispatch the driver is told the new stop list.

Refusals: `Add the goods` · `Choose where each pickup is.` · `Say where the consignment is loaded.` · `Say where the consignment is dropped, or leave the drop to be confirmed.` · `Every pickup comes before the drops.` · `A full load is dropped at one place. Choose a consignment type that allows several drops.` (and the same for pickups) · `Choose where it is dropped. This consignment type does not leave drops to be confirmed.` · `Add a loading point to the trip, or say where this consignment is loaded.` · `Choose the consignee from the customers: this company needs a record for every consignee.` · `Enter the consignee's phone number.` · `This trip already has its consignment. This company carries one per trip.` · `This company does not add stops once the truck has left. …` · `This trip is closed.` (409)

#### 1.2 Planned legs (the split delivery)

```json
{
  "version": 4,
  "legs": [
    { "id": "6730…g1", "kind": "pickup", "placeId": "672f…pl1" },
    { "kind": "drop", "placeId": "672f…pl4", "planned": [{ "lineId": "6730…l1", "qty": 9500 }] },
    { "kind": "drop", "placeId": "672f…pl5", "planned": [{ "lineId": "6730…l1", "qty": 9500 }] },
    { "kind": "drop", "placeId": "672f…pl6", "planned": [{ "lineId": "6730…l1", "qty": 9500 }] },
    { "kind": "drop", "placeId": "672f…pl7", "planned": [{ "lineId": "6730…l1", "qty": 9226 }] }
  ],
  "leaveRest": false
}
```

Done legs keep exactly what they were (sending them is optional; moving one is refused). Planned legs are replaced by what is sent. New places get stops after the truck's position; stops no consignment needs any more go (unless the truck has been there). The driver is told: "Your drops for CN/26/0012 changed: 1 Puma Kabwe 9,500 L, 2 …".

Refusals: `A pickup or drop that is done cannot move. Correct it instead.` · `9,226 L is not placed on a drop yet. Put it on a drop, or leave the rest to be confirmed.` · `The drops add up to 300 L more than is on board.` · the type rules of 1.1 · `This consignment was changed by someone else. Reload it and try again.` (409)

## 2. Loading and delivery

### 2.1 Record a pickup or a drop

| | Method and path | Permission | Body | Answers |
|---|---|---|---|---|
| ⬜ | `POST /consignments/:id/legs/:legId/record` | `consignments: update` | `legRecordSchema` | the consignment with `checks` |
| ⬜ | `POST /consignments/:id/legs/:legId/correct` | `consignments: archive` (the area's Manage level) | `legRecordSchema` plus `reason` | the consignment |
| ⬜ | `POST /trips/:id/stops/:stopId/record` | `consignments: update` | `{ records: [legRecordSchema + consignmentId + legId] }` | `{ recorded, results: [{ consignmentId, legId, number, ok, status?, error? }] }` |

```json
{
  "measures": [{ "lineId": "6730…l1", "qty": 38000, "ambientL": 38000, "tempC": 28, "density": 835, "certStd20L": 37720 }],
  "documents": [
    { "documentTypeId": "672f…dt1", "number": "TPA-INV-55120", "amount": { "amountMinor": 4500000, "currencyId": "672f…usd" } },
    { "documentTypeId": "672f…dt3", "number": "WB-881" }
  ],
  "docId": "6730…d1",
  "pod": { "number": "PUMA-DN-551", "receivedBy": "J. Banda", "receivedAt": "2026-11-07T10:00:00.000Z", "remarks": "2 seals broken" },
  "sealNos": ["S-1", "S-2"],
  "override": { "reason": "Weighbridge reads 400 kg high" },
  "custom": {}
}
```

- `measures`: one per goods line handled here, shaped by the product: liquids at 20 °C send `ambientL`, `tempC`, `density`, optionally `certStd20L`; weighed goods `gross`, `tare`, `ticketNo` (the net is worked out) or `qty`; counted goods `qty` and `pieces`. Drops may add `accepted`, `damaged`, `shortDelivered`.
- `documents`: any number; a document without `documentTypeId` is the step's usual one (Loading invoice at a pickup, Delivery note at a drop). `docId` is the driver's photo the figures came from: it is marked recorded and filed on this consignment and leg.
- `pod` only on a drop. A drop's `outcome` is `delivered`, or `partial` when something was not accepted; `refused` is refused here ("Use Can't deliver").
- The driver-side shortage is worked out once the consignment's last drop is in, from all its pickups and drops (fuel at 20 °C).
- Several at a stop: each record goes in on its own; one refused does not stop the others.

Refusals: `Dispatch the truck first.` (409) · `This trip is closed.` (409) · `This pickup is already recorded.` / `Already delivered.` (409) · `Record the loading first.` (409, a drop before any pickup) · `Complete "<stage>" first.` (409) · `This company doesn't carry weighed goods. …` · `Fuel needs temperature and density.` · `Density looks wrong: expected 700–1000 kg/m³.` · `Enter both the gross and the tare from the weighbridge ticket.` · `Delivered 38,700 L at 20 °C is more than loaded (37,726) by over 2%. Check the figures.` · the capacity refusals of 2.4 · the gate refusals of 2.3 (arriving at the leg's stop) · `Fill in sealNo.` (a required company field).

### 2.2 Papers and the driver's photos

| | Method and path | Permission | Body | Answers |
|---|---|---|---|---|
| ⬜ | `POST /consignments/:id/documents` | `consignments: update` | `{ legId?, documentTypeId?, number?, date?, amount?, validUntil?, driverDocId?, fileId? }` | the consignment |
| ⬜ | `DELETE /consignments/:id/documents/:docId` | `consignments: update` | — | the consignment |
| ⬜ | `POST /driver-documents/:id/file` | `driver-documents: update` | `{ documentTypeId?, consignmentId?, legId? }` | the driver document |

`POST /driver-documents/:id/file` is "Change what this is" and "Move to another consignment": it sets the photo's `documentTypeId` (and its `kind` while it is still new), `consignmentId` and `legId`, and ends any WhatsApp question about it. Refusals: `That consignment is not on the trip this photo was sent for.` · `That pickup or drop is not on the consignment.` · `That photo belongs to another trip.` · `Enter the number, or attach the photo.`

Driver documents (`GET /driver-documents`, sync) now carry `consignmentId`, `legId`, `documentTypeId`, and `question: { ask: 'kind' | 'consignment', options: [{ label, value }], at }` while the WhatsApp bot waits for an answer.

### 2.3 The gate: what holds the truck

A loading or offloading stop holds the truck (it cannot be arrived past, by the office, the driver or a position report) while, by Company → Freight `leaveStopRequires`: a pickup or drop planned there is not recorded (`lines`); a paper whose type is "Waits for: the truck leaving the stop" is missing for a leg done there (`required_documents`; Loading invoice by default); at a loading stop, the trip has no consignment at all (`consignmentBy: loading`); with `consignmentRateRequired: at_loading`, a consignment loaded there has no rate.

| | Method and path | Permission | Body | Answers |
|---|---|---|---|---|
| ⬜ | `GET /trips/:id/gate` | `trips: read` | — | `{ gate: { index, stopId, reason, driverReason, why } \| null }` (not in 3.12: the screens' "can leave TIPER when …" line and the driver app read it) |
| ⬜ | `POST /trips/:id/stops/:stopId/pass` | `stop-gate-override: create` | `{ reason }` | the trip (the stop gets `gatePassed: { at, by, byName, reason }`; logged on the trip) |

`why`: `no_consignment · pickup · drop · document · rate`. Sentences (office / driver): with one consignment on the trip they are today's: `Record the loading first.` / `Waiting for Operations to record the loading.` and `Record the delivery at Lusaka depot first.` / `Waiting for Operations to record the delivery at Lusaka depot.` With several: `Record the loading of CN/26/0012 and CN/26/0013 at TIPER first.`, `Record the delivery of CN/26/0012 at Puma Kabwe first.` Papers: `CN/26/0012 needs its loading invoice.` / `Waiting for Operations to record the loading invoice.` Rate: `CN/26/0012 has no rate yet.` / `Waiting for the office to agree the rate.`

### 2.4 Capacity

On board after a pickup = everything recorded on the trip and not yet dropped, plus this pickup: weighed goods in kg against the smaller of the truck's payload and the trailer's `capacityKg`; liquids in litres against the trailer's `capacityL`. Company → Freight `capacityCheck`: `refuse` (default), `warn`, `off`; `capacityTolerancePercent` above the limit before it bites.

| | Method and path | Permission | Answers |
|---|---|---|---|
| ⬜ | `GET /trips/:id/capacity` | `trips: read` | `{ limits: { kg?, l?, kgFrom?, lFrom? }, onBoard: { kg, l }, planned: [{ stopId, place, kg, l, over: bool }], notes: [string] }` |

Refusal (422): `ABC 1234 carries 30 t; this would put 31.2 t on board.` · `TAC 7821 holds 38,000 L; this would put 39,000 L on board.` Holders of `capacity-override: create` get ` Give a reason to record it anyway.` added, and pass by sending `override: { reason }` (logged on the trip). With no figure on the truck, `checks.capacity.notes` says `No payload set for ABC 1234, so the weight was not checked.` With `warn`, `checks.capacity.warnings` has the sentence and the trip's activity logs it.

### 2.5 One load per trip, for one release (design 3.10)

`POST /consignments` with today's body (`{ tripId, productId, invoiceNo, consignor?, consignee?, qty, ambientL?, tempC?, density?, certStd20L?, gross?, tare?, ticketNo?, docId?, custom? }`) records the pickup of the consignment planned at the trip's loading point, or makes the consignment and records it; the invoice becomes a Loading invoice document. `POST /consignments/:id/delivery` with `{ podNo, qty, …, docId?, custom? }` records the consignment's next drop. Both answer the consignment as above. A trip already loaded with nothing more planned still refuses `This truck is already loaded.` (409). The message buttons `load.record` and `delivery.record` keep working.

## 3. Stops

| | Method and path | Permission | Body | Answers |
|---|---|---|---|---|
| ⬜ | `PUT /trips/:id/stops` | `trips: update` | `{ version, stops: [{ id?, placeId, kind }] }` | the trip |

Re-orders the stops the truck has not reached, or adds one (`via`, `border`, a `load` or `offload` with no consignment yet). Stops already reached must come back first and unchanged. After dispatch needs Company → Freight `stopsEditableOnRoad` (on by default). Refusals: `The stops the truck has reached can't move.` · `A stop with a planned pickup or drop can't be removed. Move the pickup or drop first.` · `Every pickup comes before its drops: CN/26/0012 would be dropped before it is loaded.` · the stop rules (`The first stop is the start.` …).

A trip's stops (`GET /trips/:id`, sync) gain `origin` (`route · consignment · office`), `addedAt`, `addedBy`, `skipped`, `gatePassed`, `activityTypeId`.

## 4. Revenue (`consignment-revenue`)

| | Method and path | Permission | Body | Answers |
|---|---|---|---|---|
| ✅ | `GET /consignments/:id/revenue` | `consignment-revenue: sensitive` | — | the revenue (shape of `revenue` above) with `tariff: { id, code, name, version, matchedOn } \| null` |
| ✅ | `POST /consignments/:id/reprice` | `consignment-revenue: update` | — ; `?preview=1` saves nothing | `{ before, after, changed }` with `?preview=1`; else the revenue |
| ✅ | `POST /consignments/:id/revenue/lines` | `consignment-revenue: update` | `{ chargeTypeId, description?, qty?, unitPrice: money, note? }` | the revenue |
| ✅ | `PATCH /consignments/:id/revenue/lines/:lineId` | `consignment-revenue: update` | `{ accepted }` | the revenue |
| ✅ | `POST /consignments/:id/revenue/manual` | `consignment-revenue: update` | `{ amount: money, reason?, whole? }` | the revenue |
| ✅ | `POST /consignments/:id/revenue/freeze` | `consignment-revenue: update` | — | the revenue |
| ✅ | `POST /consignments/:id/revenue/reopen` | `consignment-revenue: archive` | `{ reason }` | the revenue |

The engine is `priceConsignment` in `src/modules/freight/revenue` (#130); `src/modules/freight/pricing.ts` gathers the facts, matches the tariff and saves. It reprices on every change to the consignment's goods, legs or parties and on every pickup and drop. A manual line, or an automatic line switched off, survives a reprice; a frozen or invoiced revenue is never repriced. A manual price sets one Freight line "priced by hand" (with `whole: true`, nothing else is added). Company → Freight `manualPriceNeedsReason` (on) makes the reason required.

Refusals: `Say why the price is set by hand.` · `This price is frozen. Reopen it first.` (409) · `It is on an invoice; correct it with a credit note.` (409) · `Switch the Freight charge type back on under Charge types first.` · `Only an automatic or added line can be switched off.`

## 5. Tariffs

| | Method and path | Permission | Body | Answers |
|---|---|---|---|---|
| ✅ | masters: `GET/POST /tariffs`, `GET/PATCH/DELETE /tariffs/:id`, archive, import, audit | `tariffs: …` | the master | as every master |
| ✅ | `POST /tariffs/try` | `tariffs: read` | `{ tariff: <tariff body>, consignmentId? , sample?: { … } }` | `{ problems: [string], result: RevenueResult \| null, facts }` |
| ✅ | `POST /tariffs/:id/try` | `tariffs: read` | `{ consignmentId?, sample? }` | the same, for the saved tariff |
| ✅ | `GET /tariffs/:id/match?consignmentId=` | `tariffs: read` | — | `{ matches: bool, tariff: { id, code, matchedOn } \| null, winner }` (not in 3.12: "why didn't this tariff apply") |
| ✅ | `GET /freight/formula/variables` | signed in | — | `{ variables: FORMULA_VARIABLES ([{ name, kind, help }]), bases: [{ value, label, sentence, price: 'price' \| 'percent' \| 'formula' \| 'none', priceOptional, free }] }`: `label` and `sentence` are BASIS_LABELS and BASIS_SENTENCES; `price` is the input a line of that basis shows (shortage and damage take an optional price, `priceOptional: true`); `free` is true for per_drop_beyond and per_pickup_beyond |

Design 3.12 has only `/tariffs/:id/try`; `/tariffs/try` prices a tariff that is not saved yet (the editor's "Try it" before the first save). `sample` is plain figures: `{ qty?, unit?, loadedQty?, deliveredQty?, plannedQty?, km?, drops?, pickups?, kg?, litres20?, pieces?, declaredValue?, productId? }`. Saving a tariff runs `checkTariff`: each problem comes back under `details.lines` ("Line 3: the formula: There is no value called "kgs": did you mean "kg"?").

Matching (design 3.4.5): active tariffs valid on the pricing day whose every condition holds; most specific first by weight (customer 16, consignor 12, route 8, from place 6, to place 6, from country 3, to country 3, product 4, product group 3, consignment type 2, vehicle type 1), then `priority`, then the latest `validFrom`.

## 6. Profit (`trip-profit`)

| | Method and path | Permission | Body | Answers |
|---|---|---|---|---|
| ⬜ | `GET /trips/:id/profit` | `trip-profit: sensitive` | — | design 3.6.3 (below) |
| ⬜ | `POST /trips/:id/costs` | `trip-profit: update` | `{ chargeTypeId?, label, amount: money, note? }` | the profit |
| ⬜ | `DELETE /trips/:id/costs/:lineId` | `trip-profit: update` | — | the profit |

```json
{
  "status": "provisional", "complete": false, "currency": { "id": "…", "code": "ZMW", "minorUnits": 2 },
  "revenueMinor": 9653144, "costMinor": 6120410, "profitMinor": 3532734, "marginPercent": 36.6,
  "perKm": 1869, "perLoadedKm": 1801, "perDay": 883184, "km": 3922, "loadedKm": 1961, "days": 4,
  "revenue": [{ "consignmentId": "…", "number": "CN/26/0012", "customer": "Puma Energy", "status": "priced", "amountMinor": 9653144, "share": 100, "counted": true, "note": null }],
  "costs": [
    { "group": "fuel", "label": "Fuel", "amountMinor": 3414300, "litres": { "opening": 120, "issued": 1150, "closing": 72, "used": 1198 },
      "items": [{ "ref": "fund-requests:…", "label": "FUEL/26/0031 · 1,150 L at 28.50 ZMW", "amountMinor": 3277500 }, { "ref": "price-list", "label": "48 L at 28.50 ZMW (Diesel in Zambia)", "amountMinor": 136800 }] },
    { "group": "expenses", "label": "Road and border", "amountMinor": 412000, "items": [{ "ref": "expenses:…", "label": "Road toll R-1", "amountMinor": 25000 }] },
    { "group": "charges", "label": "Cost charges", "amountMinor": 0, "items": [] },
    { "group": "losses", "label": "Losses carried by the company", "amountMinor": 0, "items": [] },
    { "group": "recovered", "label": "Recovered from the driver", "amountMinor": -12400, "items": [] },
    { "group": "other", "label": "Other costs", "amountMinor": 50000, "items": [{ "ref": "costs:…", "label": "Toll account", "amountMinor": 50000 }] }
  ],
  "pending": [{ "ref": "expenses:…", "label": "Meals and lodging", "amountMinor": 18000 }],
  "budget": { "fuelL": 1240, "cashMinor": 450000, "usedFuelL": 1198, "usedCashMinor": 412000 },
  "warnings": ["CN/26/0013 has no price yet.", "Fuel is priced at the company's default 28.50 ZMW per litre."]
}
```

`status`: `estimate` while the trip is open, `provisional` once it ended with something still open, `final` when every consignment is frozen and the trip is settled. Company → Freight `profitCosts` says which groups count; `overhead` is not built yet. `trip.profit` (`{ status, revenueMinor, costMinor, profitMinor, complete, at }`) and `trip.costLines` come with the trip only for holders of `trip-profit: sensitive`.

## 7. The report

| | Method and path | Permission | Answers |
|---|---|---|---|
| ⬜ | `GET /consignments/report` | `consignments: read` | `{ columns: [{ key, label, money, unit? }], rows: [{ <key>: value }], totals: { count, quantities: [{ unit, qty }], km, money: [{ currency, amountMinor }] }, available: [{ key, label, money }] }`, paged with `page`, `limit` (≤ 500) |
| ⬜ | `GET /consignments/report.xlsx` · `/report.csv` | `consignments: read` | the file of exactly the columns and filters asked |
| ⬜ | `GET /consignments/report/columns` · `PUT` `{ columns: [key] }` | `consignments: read` | the person's remembered columns (not in 3.12: "remembered per person" needs a home on the server, so it follows the person across browsers) |

Query: the filters of `GET /consignments` plus `columns` (comma list of keys, in order; left out, the person's remembered columns, else the default view), `dateField` (`booked|loaded|delivered|invoiced`), `vehicleId`, `driverId`, `routeId`, `withPod`. Default view (the 8 Nov columns): `tripNo, vehicleNo, invoiceDate, lrNo, product, quantity, route, leadKm`. The rest: `number, customer, consignor, consignee, loadingInvoiceNo, loadedQty, deliveredQty, difference, loadedOn, deliveredOn, podNo, daysInTransit, rate, freight, charges, deductions, total, currency, invoiceNo, status`, and `custom.<key>` for each company field on consignments. Money columns (`rate, freight, charges, deductions, total, currency`) are left out without `consignment-revenue: sensitive`, even when asked for.

## 8. Driver side

| | Method and path | Change |
|---|---|---|
| ⬜ | `GET /driver-app/home` | `trip.stops[]` gain `legs: [{ consignmentId, legId, number, kind, party, phone, whatsapp, product, plannedQty, unit, status, send: [{ documentTypeId, label }] }]`; `trip.next` becomes a list `[{ consignmentId, legId, documentTypeId, label, stopId }]` (empty when nothing is due); `trip.gate: { stopId, driverReason } \| null`. `trip.loaded` / `trip.delivered` stay. Never: rates, revenue, profit |
| ⬜ | `POST /driver-app/send` | adds `consignmentId`, `legId`, `documentTypeId`, `allAtStop` (one sheet for every drop at the stop, with Company → Freight `podPerStopAllowed`). Several consignments open at the stop and none named: answered 201 with `pick: [{ consignmentId, legId, number, party, product, qty }]`, the photo filed on the trip |
| ⬜ | `POST /whatsapp/simulate` | adds `consignmentId`, `legId` (the simulated phone's picker) |

## 9. Settings

| | Method and path | Permission | Answers |
|---|---|---|---|
| ✅ | `GET /company` | `company: read` | the company as today, plus `freight` (only what the company changed), `effectiveFreight` (every key of 3.9 as it applies now: `freightSettings()`, so `chargeOnDefault` and `shortageDeductionDefault` fall back to Money settings → Bill on and Shortage on the invoice), `freightNotBuilt: [key]` (stored but not acted on yet: the screen says "Not built yet") and `freightNotBuiltValues: { key: [value] }` (values of a built setting that a later phase acts on, e.g. `transferRevenueSplit: ['by_km']`) |
| ✅ | `PUT /company` | `company: update` | `{ version, freight: { key: value \| null } }`: only the keys sent change; `null` puts one back to its default (the key is removed from the stored block) |

(3.12 says "through the existing company settings route": this is that route, with the effective values beside the stored ones.)

## 10. Masters

The freight masters are in the Trips area (`module: 'trips'`, on by default), never behind Billing (which starts off): pricing and profit work whether or not the company invoices from this app (correction 12 in 3.4.7). Charge types, tariffs and fuel prices sit in the Money and tax group of the masters console; consignment types and consignment document types in Cargo.

Generic CRUD, import and audit for `/consignment-types`, `/consignment-document-types`, `/charge-types`, `/tariffs`, `/fuel-prices` (design 3.12 writes them under `/masters/…`; this app mounts every master at `/api/v1/<key>`). `/stop-activity-types` and `/packaging-types` are phase 2. `GET /meta/masters` describes them with labels, hints and choice names.

## 11. The demo sample

`POST /meta/sample-data` (the full sample, `npm run seed`) has consignments in every shape, for the screens at every width:

- a trip with one consignment, one load and one drop (the simple case), delivered and priced;
- a trip with three consignments for two customers over two loading stops;
- a loaded consignment split into four drops after the border;
- one priced from a tariff with a minimum charge (the minimum top-up line shows);
- one with a manual price, and its reason;
- one unpriced, with the reason ("No tariff covers this consignment …").

It ships the usual consignment types, consignment document types and charge types, the tariffs those need (per tonne with a minimum, per litre at 20 °C with an extra-drop line and a shortage deduction), and a fuel price, so profit has a price for fuel.

## 12. Sync and messages

`GET /operations/sync` sends consignments in the shape of section 1 (revenue left out without the permission), trips with their new stop fields (profit left out likewise). New notice events a company can route: `consignment.loaded`, `consignment.delivered`, `consignment.pod_received`, `consignment.split`. A new WhatsApp template `stops_changed`, and the bot's two questions `what_photo` and `which_consignment`.
