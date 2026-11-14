# Consignments, loads and freight revenue: design

> **Background, not a spec (15 Nov 2026).** Phase 1 is built (#144–#150). Prices now come from rate contracts (#151), and tariffs are "Coming soon". The rest of this design is parked. Where it and the app differ, the app wins. See [README](README.md).

Marichi Fleet · domain design · 10 November 2026 · sections 1–3.4 written against worktree `fleet_erp-lakshya-t3` at `de3a793` (develop + #121); sections 3.5–5 written and the whole checked against develop at `1cbcb7b` (the same tree; corrections in 3.4.7)

## Summary for the owner

- A trip stops being "one truck, one load". It carries **consignments**: one, or a hundred. Each has its own goods, consignor, consignee (with a contact number), papers, rate and proof of delivery.
- Consignments are added while planning the trip, at loading, or while the truck is on the road (a backhaul). Later they can also be booked before any truck is chosen.
- **Loading and offloading can happen anywhere on the route, any number of times.** A consignment can load at two terminals on two invoices, and be dropped at one place or many. The drops can be decided late: 40,000 L becomes four depots after the border in one screen, and the driver is told the new stops.
- The Operations loading screen is rebuilt around the stop: every consignment loading there, several documents each, and quantities shaped by the product (litres at 20 °C, weighbridge gross and tare, pieces and bags).
- **Each consignment has its own POD.** The driver's upload says which consignment it is for: one tap in the app, one reply on WhatsApp; the office can re-file a photo in two clicks.
- **Capacity and the loading gate are policies, not fixed rules.** By default a load over the truck's capacity (weight, litres, later pieces) is refused unless someone allowed to overrides it, and the truck is held at a loading point until its consignments are recorded. A company can set either to warn only, or off.
- **Revenue is worked out, not typed.** A tariff per customer, route or product prices a consignment: fixed, per trip, tonne, kg, litre, piece, km or tonne-km, on loaded or delivered quantity, with minimums, slabs, extra-drop and waiting charges, shortage deductions, and custom formulas. Every figure shows how it was reached. A price can still be typed by hand.
- **Trip profit = its consignments' revenue − the trip's costs** (fuel, expenses, losses, commissions), shown on every trip to the people allowed to see it.
- **The consignment report** is a table the company shapes: choose, order and save its columns, filter, group, total, download to Excel. Its starting view is the usual transporter statement (trip no., vehicle no., invoice date, LR number, product, quantity, route, lead distance). It later feeds invoices per consignment or per month.
- New lists the company controls: consignment types, charge types, tariffs, stop types, packaging and cargo documents, each with sensible defaults.
- **Nothing changes for a company with one load and one drop.** Every extra is a setting, and every default is today's behaviour. Existing trips, rates and invoices are converted automatically and keep their numbers.
- It is built in four large steps. The first one alone makes consignments useful end to end (plan, load, deliver, prove, price, see the profit, report); the rest add booking and volume, the full rate engine, and billing and reports.
- The 8 Nov call is used as evidence of what transporters care about, not as a specification. Where it stated a rule, the design has a setting whose default follows it; section 3.9.1 lists where the design departs from it and why.

This document designs the revenue side of a trip. A trip today carries at most one consignment, loaded once at the first `load` stop and delivered once at the first `offload` stop (`src/modules/operations/models/cargo.model.ts`, unique index `{ tripId, inTransit }`; `src/modules/operations/cargo.service.ts` `recordLoading`/`recordDelivery`). Pricing happens after the trip closes, from one `CustomerRate` per customer with four bases (`src/modules/finance/billing/pricing.ts`). The business lead's call of 8 Nov made the gap plain: no transporter will take a product whose trip does not know what it carries, for whom, at what rate, and whether it made money.

The design below makes the trip carry any freight: one consignment or a hundred; loads and drops anywhere on the route, decided late; several documents per consignment; a revenue engine with configurable rate bases, slabs, charges and deductions, including custom formulas; and trip profit. It stays easy for the transporter with one load and one drop, because every extra is a setting whose default is "off" or "one", and the simple path is the same number of clicks it is today.

Contents

1. [Research: how freight really works and how other software models it](#1-research)
2. [Real-world situations the design must handle](#2-situations)
3. [Design](#3-design)
   - 3.1 Words and the shape of things
   - 3.2 Data model
   - 3.3 Route stops and consignment legs
   - 3.4 New masters and their defaults
   - 3.5 The revenue engine
   - 3.6 Trip profit
   - 3.7 Stage machine changes
   - 3.8 Driver side
   - 3.9 Configuration knobs
   - 3.10 Migration
   - 3.11 Screens
   - 3.12 API surface
   - 3.13 GPS/analytics push (brief)
4. [Phasing](#4-phasing)
5. [Open product questions](#5-questions)

---

## 1. Research

### 1.1 How freight moves and is documented

**FTL vs LTL / part load.** A full truck load (FTL) is one consignor's goods filling (or paying for) the whole truck; the rate is usually per trip or per tonne for the whole lorry. Less-than-truckload (LTL, "part load" in India) puts several consignors' goods on one truck, each with its own document and rate, loaded and dropped at different places; carriers rate it by weight tier with a minimum charge ([DAT on LTL rates](https://www.dat.com/resources/how-to-calculate-ltl-freight-rates), [FreightWaves on LTL billing](https://www.freightwaves.com/news/cashflow-corner-ltl-freight)). Multi-pick/multi-drop is the general case: a route with a mix of pickups and deliveries; even IBM's Sterling TMS notes a limitation of one pickup or delivery per stop, which tells us the "several consignments touched at one stop" case is a real design choice, not a given ([IBM Sterling TMS](https://www.ibm.com/support/pages/node/752257)).

**The lorry receipt / bilty / GR in India.** The LR (lorry receipt), also called bilty or GR (goods receipt), is the carrier's receipt and contract: LR number and date, transporter name and GSTIN, consignor and consignee with addresses, pickup and delivery addresses, vehicle number, goods description with quantity and weight, freight charges, payment mode and the consignee's acknowledgement on delivery ([Tata Nexarc guide](https://blog.tatanexarc.com/logistics/lorry-receipt-a-guide-to-types-features-rules-format-and-usage), [Fleetx on bilty](https://blog.fleetx.io/what-is-bilty-a-simple-explanation-for-transporters-shippers/), [Fretron glossary](https://www.fretron.com/blog/glossary-lorry-receipt/)). Copies go to consignor, consignee and transporter. There is an "open LR" where the consignee is not known at booking. Freight terms are three: **Paid** (consignor pays at booking), **To Pay** (consignee pays on delivery) and **To Be Billed / TBB** (credit: billed to the account customer after delivery with POD) ([AKR Express terms](https://akrexpress.com/resources), [BHEL tender wording of "to be billed"](https://tenders.bhel.com/sites/default/files/download-1603942886.pdf)). Under GST an e-way bill is mandatory for goods over ₹50,000, carries GSTIN, value, HSN and vehicle number or transporter ID, and has a validity computed from distance; the LR itself is not mandatory under GST but travels with the e-way bill ([Tata Nexarc](https://blog.tatanexarc.com/logistics/lorry-receipt-a-guide-to-types-features-rules-format-and-usage)). Shortage and damage recovered from the transporter are treated as liquidated damages, not a taxable supply (Gujarat AAR, 2026, [Taxscan](https://www.taxscan.in/top-stories/gst-not-payable-on-compensation-received-from-transporters-for-loss-damage-or-shortage-in-transit-aar-read-order-1448321)).

**The consignment note / CMR in Europe and Africa.** The CMR note is the contract and receipt for international road carriage: sender, consignee, carrier (and successive carriers), place and date of taking over, place of delivery, description of goods (packages, marks, gross weight or volume), special instructions, documents handed to the carrier, and who pays the freight; normally four copies (sender, consignee, carrier, extra for customs or a second carrier) ([Racklify CMR guide](https://racklify.com/encyclopedia/how-to-fill-and-use-a-cmr-consignment-note-step-by-step-guide/), [Impargo](https://impargo.de/en/blog/cmr), [nibusinessinfo](https://www.nibusinessinfo.co.uk/content/cmr-note-key-road-transport-document)). Southern African cross-border loads travel with a customs road manifest, a consignment note (often a CMR-style form), commercial invoice, packing list and clearing instructions; Mozambique requires an electronic master manifest at entry ([Focus on Transport](https://focusontransport.co.za/cross-border-trucking-procedures-for-compliant-operators/), [exporthelp.co.za road consignment note](https://exporthelp.co.za/steps/8-outbound-logistics/foreign-market-logistics/import-documentation/transport-documents/road-consignment-note/), [C-BRTA Mozambique handbook](https://www.cbrta.co.za/uploads/files/Road-Transport-Operator-Handbook-for-Mozambique.pdf)). Fuel cargo is additionally covered by the loading terminal's bill of lading / loading certificate stating litres at observed and at reference temperature, density and seals; inspectors such as Intertek verify loaded and discharged quantities against it ([Intertek overland petroleum](https://intertek.com/inspection/cargo/overland-southern-africa)).

**Bill of lading vs waybill.** A bill of lading can be a document of title and is negotiable; a waybill or consignment note is a non-negotiable receipt and contract ([Vector](https://www.withvector.com/blog/waybill-vs-bill-of-lading-understanding-the-difference/), [Credlix](https://blog.credlix.com/bill-of-lading-and-waybill-whats-the-big-difference-2024/)). For a road transporter the practical difference is only which document name and number the customer wants printed and quoted. We model the document as data (a Document Type master, section 3.4), not as a fixed form.

**Consolidation: master and house.** Forwarders put many "house" shipments under one "master" (Magaya's parent/child shipment view, with each customer seeing only their house) ([Magaya](https://www.magaya.com/the-freight-forwarders-guide-to-lcl-consolidation-best-practices/), [Cargoflip](https://cargoflip.com/post/master-bill-of-lading-vs-house-bill-of-lading)). Our trip is the master; each consignment is a house.

### 1.2 Rate bases

What we found, and how each becomes a basis in section 3.5:

| Basis | Where it is used | Notes from practice |
| --- | --- | --- |
| Fixed per trip / per vehicle | FTL everywhere; "40,000 for the load" in the call | Often with a route and vehicle type |
| Per tonne | Bulk, minerals, agri | On loaded or on delivered weight; the call: "some pay on loaded, some on unloaded" |
| Per kg with minimum weight | Courier / part load | Chargeable weight = max(actual, volumetric, minimum); divisors 333 kg/m³ (road), 6,000 cm³/kg (air) ([GetTransport](https://blog.gettransport.com/logistics-guide/chargeable-volumetric-weight-calculation-2026/), [WARP glossary](https://www.wearewarp.com/glossary/chargeable-weight)) |
| Per km | Lead distance of the consignment (route master), not the truck's actual km | The GPS vendor's report calls it "lead distance" |
| Per tonne-km | Indian Railways, government tariffs, some bulk contracts | qty × distance; needs both figures |
| Per litre at 20 °C or ambient | Fuel haulage | Contracts pay on the loading certificate's standard litres (sometimes per m³) with a shrinkage tolerance; the loss beyond it is deducted from the transporter |
| Per piece / pallet / container / drum | Packaged goods, containers | Count basis; containers are per unit by size class (20 ft / 40 ft) |
| Slab or tiered | LTL, courier, detention | Price per unit changes by band (progressive or whole-quantity); rounding up to the next kg or 100 kg is common ([DHL Freight Eurapid charging rules](https://www.dhl.com/content/dam/dhl/local/be/dhl-freight/documents/pdf/be-freight-eurapid-charging-rules.pdf)) |
| Minimum charge / absolute minimum | Everywhere | Topped up when the computed freight is below it |
| Loaded vs delivered quantity | Bulk, fuel | A contract term, per customer |

### 1.3 Extra charges (accessorials)

Sources agree on a standard list: detention (truck waiting beyond free time, per hour or per day with slabs), demurrage (equipment held at a terminal), layover, loading/unloading labour (lumper, hamali), extra stop charge (per additional pickup or drop), fuel surcharge (percent of freight or per km from a fuel-price table), toll pass-through at cost, waiting at border, redelivery, reconsignment, weekend/holiday delivery, hazardous surcharge, escort, tarping, weighing, cash-on-delivery handling ([ATS](https://www.atsinc.com/blog/accessorial-charges-101), [Intek](https://www.inteklogistics.com/cost-of-freight-accessorial-charges), [Rose Rocket's list of 21](https://www.roserocket.com/blog/21-common-accessorial-charges-and-how-to-avoid-them), [RoadSync](https://blog.roadsync.com/definitions-of-common-accessorial-charges)). India: halting charges after a free window of 24 h (or 2–4 h for smaller trucks), ₹1,000–3,000 per day with rising slabs, or ₹200–500 per hour ([FR8](https://www.fr8.in/blog/why-should-halting-or-detention-charges-be-higher), [TruckGuru](https://truckguru.co.in/blog/?p=1867)). Tailwind lets a fuel surcharge be a percent of order revenue excluding accessorials ([Tailwind help](https://intercom.help/tailwind-help-center/en/articles/3517653-tailwind-fuel-surcharges-and-fsc-schedules)). Advances paid by the consignor at loading ("advance against LR") reduce what is billed; the three payment terms above decide who is invoiced.

### 1.4 Losses and paperwork

Shortage and damage are netted off the carrier's freight by the shipper or recovered from the driver; a claim stands only when the shortage was noted on the POD at delivery ([SupplyPike](https://supplypike.com/blog/shortages-damages-claims-freight/), [Racklify on freight deductions](https://racklify.com/encyclopedia/what-is-a-freight-deduction-causes-examples-and-retail-practices/)). Fuel contracts in the region apply a tolerance (we already model 0.3–3 % allowance in `ShortagePolicy`) and deduct beyond it; border dip tests are a known dispute point ([FreightNews on Chirundu dip tests](https://www.freightnews.co.za/article/border-beat-transporter-says-moz-issue-could-seal-zambias-fuel-fate?page=9)). Each consignment needs its own POD because billing is per consignment and payment is released against POD ([Fretron ePOD](https://www.fretron.com/solutions/epod-claims/), [Startup India logistics white paper](https://www.startupindia.gov.in/content/dam/invest-india/Templates/public/White%20Paper_Logistics%20Sector.pdf)).

### 1.5 What established products do

| Product | Concepts worth copying | Source |
| --- | --- | --- |
| **Fleetx** (India) | A consignment records consignor, consignee, materials with quantity/weight/declared value, pickup and delivery details, contracted rate and handling instructions; freight is computed from rate charts; e-way bill linked per consignment with validity from distance; bilty printed in standard format; advances recorded against consignments; bills at creation or periodically per customer; many consignments on one trip each with its own drop, independent status, documents and e-way bill; ePOD with signature, photo and GPS stamp; consignment- and trip-level P&L | [Fleetx consignment management](https://www.fleetx.ai/consignment-management) |
| **LogiNext** | Orders with a pickup leg, a delivery leg or both; multi-stop route planner; returns as a first-class order kind | [LogiNext multi pickup/drop](https://www.loginextsolutions.com/multiple-pickups-drops-management-software), [order intake](https://www.loginextsolutions.com/add-orders-logistics-automation-optimization) |
| **BlackBuck** | Marketplace: loading and unloading locations on booking, driver notified, truck tracked. Little rating | [App Store listing](https://apps.apple.com/in/app/blackbuck/id6499570896) |
| **TruckSuvidha / TruckBilty** | Load boards plus consignment booking and bilty printing; the LR is the unit of billing | [Techjockey](https://www.techjockey.com/detail/trucksuvidha/) |
| **Oracle OTM** | Order release → shipment; a **rate offering** with **rate records** that override it; **rate basis items** (weight, volume, distance, number of stops, …) usable in conditions and in the charge; a cost = basis × amount with conditions, min/max, rounding; accessorials attached to the order; SELECT over a subset of ship units (e.g. only those picked up at one location) | [OTM rate basis items](https://docs.oracle.com/en/cloud/saas/transportation/24c/otmol/planning/rate_manager/rate_basis_items.htm), [order release](https://docs.oracle.com/en/cloud/saas/transportation/24a/otmol/planning/order_manager/order_release_other_attributes.htm), [accessorials](https://docs.oracle.com/en/cloud/saas/transportation/25c/otmol/planning/order_manager/order_accessorial.htm) |
| **SAP TM** | Forwarding order (customer side) vs freight order (carrier side), both charged with the same engine; a **calculation sheet** is an ordered list of charge types; each charge type points at a **rate table** whose dimensions are **scales** (weight, distance, zone…); agreements determined by partner and org unit; minimums only on certain scale types | [SAP Learning: charge master data](https://learning.sap.com/courses/charges-and-settlement-in-sap-s-4hana-transportation-management/managing-charge-calculation-master-data-1), [forwarding agreements](https://learning.sap.com/courses/exploring-sap-s-4hana-transportation-management-for-logistics-service-providers/managing-forwarding-agreements) |
| **Rose Rocket** | Orders carry stops, commodities, quotes and custom accessorials that can live on the customer profile; documents (BOL, rate confirmation, invoice) from templates fed by live record data | [Rose Rocket](https://www.roserocket.com/), [integrations](https://www.roserocket.com/integrations) |
| **McLeod LoadMaster** | "Master order" holding several deliveries and moves under one customer order; per-customer tariff rating with accessorial automation (LTL module); profitability per driver, tractor and load | [CCJ on master orders](https://www.ccjdigital.com/business/article/14938400/mcleod-software-debuts-new-features-for-loadmaster-software), [LTL module](https://www.ccjdigital.com/business/article/14899793/mcleod-releases-ltl-module) |
| **Tailwind** | Every invoice or bill line is a Revenue Item or Expense Item type; fuel surcharge schedules that apply to revenue excluding accessorials | [Tailwind FSC](https://intercom.help/tailwind-help-center/en/articles/3517653-tailwind-fuel-surcharges-and-fsc-schedules) |
| **Alvys** | Load-centric; LTL not supported (G2); rate confirmations per load | [G2 compare](https://www.g2.com/compare/alvys-vs-rose-rocket) |
| **Magaya** | Master/house parent-child shipments, consolidation wizard grouping by consignee, tracking per house | [Magaya](https://www.magaya.com/the-freight-forwarders-guide-to-lcl-consolidation-best-practices/) |

Takeaways we adopt:

1. **Separate the contract from the movement.** OTM's order release vs shipment, SAP's forwarding order vs freight order: the consignment is the customer-side contract (what, for whom, at what rate); the trip is the carrier-side movement (truck, driver, fuel). One trip can serve many consignments and, with transfers, one consignment can be served by several trips.
2. **A rate is a list of charge lines, each with a basis, conditions, slabs and a min/max**, not one price (SAP calculation sheet, OTM rate costs). Our `Tariff` master is exactly that, and today's `CustomerRate` becomes its simplest form.
3. **Charge types are a master with a default basis** (Tailwind revenue items, Rose Rocket custom accessorials on a customer profile). Each company adds its own.
4. **Each consignment has its own documents and status** (Fleetx), including the POD, and billing is per consignment and POD.
5. **Formulas are not code.** Nobody in this list lets a user type JavaScript; they offer a basis vocabulary and conditions. Our formula language is that vocabulary with arithmetic (section 3.5.6).

### 1.6 Safe formula evaluation in Node

`expr-eval` has a prototype-pollution advisory leading to code execution and is effectively unmaintained ([advisory list](https://releasealert.dev/github/silentmatt/expr-eval/cves)); `filtrex` compiles to a JavaScript function at runtime (code generation, even without `eval`) ([filtrex on npm](https://openapps.pro/packages/filtrex)); TomFrost's `jexl` is inactive on Snyk and has no sandbox model ([Snyk](https://security.snyk.io/package/npm/jexl), [GitHub](https://github.com/TomFrost/Jexl)); general JS sandboxes are repeatedly broken ([PortSwigger](https://portswigger.net/research/attacking-and-defending-javascript-sandboxes)). The safe pattern is an AST interpreter over a closed grammar with an allow-list of functions and variables, which is about 250 lines of TypeScript. **Recommendation: no library; we write `src/core/formula/` ourselves** (section 3.5.6). If the owner prefers a library, `jexl` is the closest fit and would have to be proposed as a new dependency first, per the house rule.

---

## 2. Situations

Each row is a real situation and how the design handles it. "C" is a consignment; "T" a trip; sections refer to section 3.

| # | Situation | How the design handles it |
| --- | --- | --- |
| 1 | A tanker loads 38,000 L of diesel at Dar port for one customer; after the Tunduma border the customer splits it into 4 depots of 9,500 L | One C with one line (diesel, planned 38,000 L). One pickup leg at Dar (actual 38,000 L observed, 37,650 L at 20 °C). Drops are **planned as one drop to "customer, place to be confirmed"**; after the border Operations opens "Split delivery", adds 4 drop legs with planned 9,500 L each at 4 places; the engine inserts 4 `offload` stops into the trip after the border (3.3). Each drop records its own POD and measure; shortage is computed on the C total (sum of drops at 20 °C vs loaded at 20 °C) and, if the tariff says so, apportioned per drop (3.5.5). Revenue: per litre at 20 °C on delivered total; a multi-drop charge (Charge type "Extra drop", per drop beyond the first) is added automatically if the tariff includes it. |
| 2 | A part-load truck picks up at 3 consignors on the way and drops at 5 consignees | Five Cs (or three with two lines each if one consignor sends to several consignees: one C per consignor–consignee pair, the usual LR practice). Each C has its own pickup leg and drop leg; the trip has 3 `load` stops and 5 `offload` stops in route order, generated from the Cs (3.3). Each C has its own rate (per kg with minimum weight, slab rate). Each POD belongs to its C (3.8). |
| 3 | One C needs 2 loading invoices because it loads at two terminals (e.g. 20,000 L at TIPER and 18,000 L at Kurasini) | One C, two pickup legs, each with its own `loading_invoice` document and measure; the C's loaded total is the sum; capacity is checked on the running total per pickup. |
| 4 | A return load (backhaul): the truck delivers copper to Dar and brings back fertiliser to Ndola | One T with two Cs: C1 (copper, Kitwe → Dar) and C2 (fertiliser, Dar → Ndola). C2's pickup stop comes after C1's drop stop. `legLoaded` in `calc.ts` becomes per-leg from the legs' load state (3.3). Revenue per C. If the backhaul is booked only after the truck left, C2 is **booked while the trip is on the road** and its stops are inserted (setting `stopsEditableOnRoad`, default on). |
| 5 | A C is moved to another truck after a breakdown | `undelivered.service.ts transferLoad` is generalised: it moves **chosen Cs** (all by default) to a new T created from the breakdown place; the C keeps its number and revenue and gets a `movements[]` entry; each T keeps the legs it actually performed (3.2.1 `movements`). Trip profit splits revenue between the two trips by the setting `transferRevenueSplit` (default: whole revenue on the delivering trip, with the first trip's costs shown as "transferred in" on the second). |
| 6 | Rejected goods at the consignee (quality refused), going back to the consignor | Drop leg recorded with `outcome: 'refused'` and the refused quantity; the office chooses Return (new drop leg to the consignor place, the C enters `returning`), Transfer or Write-off; the return leg can carry a return charge (Charge type "Return freight", basis per km or flat). |
| 7 | A C with no rate agreed yet | Allowed when `consignmentRateRequired` is 'later' (default) rather than 'at_booking'. Revenue status `unpriced`; the C is listed under "Unpriced consignments" in Billing; invoicing refuses until a tariff or manual price exists. |
| 8 | Customer billed per tonne on delivered weight with 2 % shortage allowance | Tariff line: basis `per_tonne`, charged on `delivered`, with `shortageAllowancePercent: 2` and `shortageDeduction: 'beyond_allowance'`: delivered tonnes are billed, and loss beyond 2 % of loaded is deducted at the product's shortage price (3.5.5). The driver-side shortage (ShortagePolicy, 0.3 %) stays separate: what the customer deducts and what the driver pays are two policies. |
| 9 | Per-km billing on the route's lead distance | Tariff basis `per_km` with `distanceSource: 'route_lead'` (the C's pickup→drop distance from the Route master or `buildStops` legs), not the truck's odometer. Alternatives: `trip_loaded_km` (today's `loadedKm`), `manual`. |
| 10 | Containers counted per unit; 20 ft and 40 ft at different prices | C line with `packagingTypeId: container_20ft`, `pieces: 2`; tariff lines conditioned on packaging type (`when: packaging = "CONT20"`), basis `per_piece`. |
| 11 | Mixed products in one C (cement bags and roofing sheets from one consignor to one consignee) | Several `lines[]` on one C, each with product, packaging, quantity, weight. Rate basis per tonne sums line weights; per piece sums pieces; a line-level override (`lineRates`) handles different prices per product in one C. |
| 12 | A consignee who is a person with only a phone number | The consignee on a C is **either** a Party (`consigneePartyId`) **or** an inline contact `{ name, phone, address }` (3.2.1). Setting `consigneeMustBeParty` (default off). "Save as party" button creates the Party later. |
| 13 | A C booked before any truck is assigned | C status `booked`, `tripId` empty, listed in "Unassigned consignments"; the New trip flow and the trip's Consignments tab both offer "Add booked consignment". Fleetx and LogiNext work the same way. |
| 14 | Trucks on a nomination: the customer names 5 trucks for one order | `convertNomination` creates one T per truck **and one C per truck** (the nomination's product, `qtyPerTruck`, customer as consignor by default) so the trips start with a draft C each; the nomination's reference becomes the C's `customerRef`. |
| 15 | Demurrage at a loading place: the tanker waits 3 days at the depot | Stop `arrivedAt`/`leftAt` already exist; the Stop Activity Type master gets `freeTimeHours` (default from the Charge type) and the Charge type "Detention at loading" has basis `per_hour_beyond_free` or `per_day_beyond_free` with slabs; the engine computes it from the stop times when `autoCharges` includes it, and Finance can accept, edit or drop the charge line before invoicing. GPS geofence arrivals (`arrivedVia: 'gps'`) feed the same times. |
| 16 | A customer pays a fixed 40,000 for the load whatever the weight | Tariff line basis `per_consignment` (flat). |
| 17 | Freight "To Pay": the consignee pays cash on delivery | C `paymentTerms: 'to_pay'`; the drop leg asks for `collectedAmount`; the amount lands in the driver's ledger as cash held (reusing `ledger.ts`), and the invoice goes to the consignee party (or none, marked "collected"). |
| 18 | Freight "Paid": the consignor paid at booking | `paymentTerms: 'paid'`; `advances[]` on the C record the receipt; the invoice is zero or shows the advance as a deduction. |
| 19 | Freight "To Be Billed": the account customer is invoiced monthly for all Cs with POD | `paymentTerms: 'to_be_billed'` (default); Billing's "Draft invoices" groups Cs per customer (new `invoiceFrom: 'consignment'` and `'customer_period'`), requires POD unless `invoiceWithoutPod` is on. |
| 20 | 50–100 small courier Cs on one truck | Cs are imported from CSV/XLSX through the existing masters import engine (`src/core/masters/import.ts`) or pasted in the "Many consignments" grid; stops are generated by grouping Cs by pickup/drop place; drops are auto-sequenced by route order; the driver app shows a per-stop checklist with one POD photo per C or a **manifest POD** (one signed sheet covering all Cs dropped at that stop, setting `podPerStopAllowed`). |
| 20a | The same, but each C must have its own LR number from the company's series | Numbering series `consignments` (already supported by `nextNumber('consignments', 'CN')`); the LR/consignment note print layout is a Print Layout master. |
| 21 | A tanker is loaded but the invoice photo is blurry; Operations returns it and the truck must not leave | `returnDocument` as today; the stop gate (3.7) holds the truck at the loading stop until every pickup planned there has recorded lines and the required documents (`leaveLoadingRequires: ['lines', 'required_documents']`). Driver sees "Waiting for Operations to record the loading." |
| 22 | The driver sends a POD photo but there are 3 open Cs at this stop | Driver app: the "Send POD" button lists the open Cs at the current stop; one tap picks. WhatsApp: the reply "Which consignment? 1) CN-0412 to Shoprite 2) CN-0413 to Pick n Pay" and the driver answers "1" (or sends the photo with the caption "1" or the CN number). If only one C is open at that stop it is picked automatically. Operations can re-attach a document to another C before recording (3.8). |
| 23 | The office types the loading without any photo | As today ("Type it without a photo"); documents are optional unless the Document Requirement master says otherwise per step. |
| 24 | The truck's capacity (30 t) must not be exceeded across several Cs | `recordPickup` sums loaded quantity across all Cs on board (by dimension: mass → `payloadKg`, volume → trailer `capacityL`, pieces → trailer `palletCapacity` if set) and refuses beyond capacity unless the person has the `capacity-override` permission (setting `capacityCheck: 'refuse' | 'warn' | 'off'`, default `refuse`). Booking also warns when planned quantities exceed capacity. |
| 25 | A fuel C where the customer pays on loaded litres at 20 °C, and the driver is charged for shortage | Tariff `chargeOn: 'loaded'`, basis `per_litre_20`; shortage via ShortagePolicy stays with the driver; no customer deduction (`shortageDeduction: 'none'` on the tariff). |
| 26 | The same customer pays on delivered litres and also deducts shortage beyond 0.5 % | Tariff `chargeOn: 'delivered'` plus `shortageDeduction: 'beyond_allowance'` with 0.5 %. |
| 27 | A C delivered in two drops where only the second has a shortage | Shortage is computed per C from totals by default (`shortageScope: 'consignment'`); a company that wants per-drop figures sets `shortageScope: 'drop'`; the explanation lines show both. |
| 28 | A consignor pays an advance to the driver at loading (₹5,000 "advance against LR") | `advances[]` on the C: amount, who paid, to whom (driver or company), receipt doc; it reduces the invoice and, when paid to the driver, posts to the driver ledger as cash received. |
| 29 | The customer's own reference, PO number, and e-way bill number must print on the invoice | `references: { customerRef, orderNo, ewayBillNo, ewayBillValidUntil, lrNo }` on the C, plus any company field (`FieldDefinition` with `entity: 'consignments'`, placement `booking`). |
| 30 | E-way bill expiry while in transit | `references.ewayBillValidUntil` is a date; a notice (`notices.ts` `announce('consignment.eway_expiring')`) fires at `ewayBillWarnHours` before expiry; shown on the trip. |
| 31 | A C whose weight is only known at the weighbridge after loading | Line `plannedQty` optional; the pickup leg records the weighbridge ticket's gross/tare/net (as today's `measure`); revenue uses actuals. |
| 32 | A C where the customer wants to be charged on the **higher** of loaded and delivered | Tariff `chargeOn: 'greater_of'` (also `lesser_of`, `planned`). |
| 33 | Chargeable weight: 400 kg actual but 3 m³ volume at 333 kg/m³ | Line has `volumeM3` (or dims); tariff `volumetricDivisorKgPerM3: 333` → chargeable = max(actual, volumetric); plus `minimumChargeableKg`. |
| 34 | A slab rate: first 500 kg at 12/kg, next 1,500 kg at 10/kg, above at 8/kg | Tariff line `slabs: [{ upTo: 500, price }, { upTo: 2000, price }, { upTo: null, price }]` with `slabMode: 'progressive'`; `'whole'` prices the full quantity at the band it falls in. |
| 35 | A tonne-km contract | Basis `per_tonne_km` = tonnes × lead km. |
| 36 | A custom formula: "USD 1.80 per litre at 20 °C, less 3 cents for every 100 km under 1,500 km, plus 5 % fuel surcharge when diesel is above ZMW 30" | Tariff line `basis: 'formula'`, formula `max(0, 1.80 - 0.03 * floor((1500 - min(km, 1500)) / 100)) * litres20` with a second line "Fuel surcharge" `when: fuelPriceBase > 30`, basis `percent_of_freight` 5. Variables are documented in the editor (3.5.6). |
| 37 | The tariff changes on 1 January but trips straddle the date | Tariffs have `validFrom`/`validTo` like `CustomerRate`; the pricing date is configurable: `priceOn: 'pickup_date' | 'delivery_date' | 'booking_date' | 'trip_dispatch'` (default `pickup_date`). |
| 38 | Tax: 16 % VAT in Zambia but zero-rated export freight to DRC | Tariff line `taxRatePercent` override; `taxMode` as today; a tariff can be conditioned on a route or on the drop place's country. |
| 39 | Two consignors on one truck pay in different currencies | Revenue is computed in the tariff's currency per C, converted to base for trip profit with `toBase`; invoices per customer in the customer's currency as `pricing.ts` does. |
| 40 | A broker brings the load and takes a commission | Party role `broker`; C `brokerPartyId` and a Charge type with `direction: 'cost'` ("Broker commission", percent of freight) that lowers trip profit and appears in a broker payable report. |
| 41 | A hired (subcontracted) truck does the trip | Out of scope here but the model leaves room: a `cost` direction charge "Hire charge" on the trip, settled with the hired transporter party. |
| 42 | A C is cancelled after booking but before loading | C `cancelled` with reason; if a cancellation fee is agreed, a Charge type "Cancellation" with `appliesWhen: 'cancelled'`. |
| 43 | The truck arrives at a drop and the consignee is closed; delivery next morning (redelivery) | Stop `arrivedAt` stamped, drop not recorded; the next day the drop is recorded; detention time counts; a "Redelivery" charge can be added manually or via `autoCharges`. |
| 44 | Partial delivery: the consignee accepts 8 of 10 pallets, 2 damaged | Drop leg per line: `accepted`, `damaged`, `shortDelivered`; damaged quantity feeds a `damage` deduction (price from the line's declared value per unit or the product's shortage price). |
| 45 | The loading place sells the fuel to the customer; the customer is not the consignor | C: `customerId` (bill-to) = the customer, `consignorPartyId` = the terminal operator, `consigneePartyId` = the depot. All three are Party roles; `customerId` defaults from the trip's customer. |
| 46 | A C is booked by a customer with several branches; the consignee is a branch address | Party `addresses[]` with `kind: 'delivery'`; the drop leg's place may be a Place record or a party address (`placeId` or `addressRef`); the engine makes an ad-hoc Place when needed for distance (setting `createPlacesFromAddresses`, default on). |
| 47 | The company wants the trip's start stop to be the yard, a load, then 2 borders, 1 drop, and the end at the yard | Stops are stop activity types in any order; `validateStops` keeps only: one `start`, one `end`, every planned pickup before its drop (3.3). |
| 48 | A C loaded from a railway siding and a second one from a warehouse 2 km away in the same town | Two `load` stops at two places; the trip's first "loading complete" happens when both pickups are recorded (3.7). |
| 49 | Monthly statement to a customer listing every C with trip no., vehicle, invoice date, LR, product, quantity, route and lead distance | The consignments report (3.11.5) has exactly those columns, exportable as XLSX/CSV through the existing export service; the GPS vendor's consignment report is reproduced. |
| 50 | The company does only one load and one drop, ever | Defaults: one C per trip created inline in New trip, legs derived from the route's `load` and `offload` stops, consignor = customer, rate from the customer's tariff; the Loading screen shows one card as today. No extra clicks versus today. |
| 51 | A legacy trip from before this change | Migration script wraps the old consignment into the new shape (3.10). |
| 52 | A customer wants an estimate before dispatch | The engine prices on `planned` quantities and marks revenue `estimated`; shown on the trip as "Expected revenue ≈ …" until actuals arrive. |
| 53 | Two offices enter the same C twice | Unique index on `{ customerId, references.customerRef }` when the ref is given (partial), and a soft duplicate warning on consignor + consignee + product + date. |
| 54 | A product measured in bags of 50 kg: the customer pays per tonne but the LR says 600 bags | Line `pieces: 600`, `packagingTypeId: bag_50kg` with `kgPerPiece: 50` → mass 30,000 kg derived; both figures print. |

---

## 3. Design

### 3.1 Words and the shape of things

| Word | Meaning here |
| --- | --- |
| **Consignment** | One consignor's goods moving under one contract and document set to one consignee (or to several drops of the same goods), at one agreed rate. The revenue unit. A company may rename it ("LR", "Job", "Shipment") through the words setting (`web/src/domain/words.ts`, `/meta/workspace`). |
| **Line** | One product (with packaging) and quantity inside a consignment. |
| **Leg** | One pickup or one drop of a consignment at a place: planned, then actual. A consignment has 1+ pickups and 1+ drops. |
| **Stop** | A place the truck visits on the trip, with an activity type (load, offload, border, rest, weighbridge…). Legs attach to stops. |
| **Tariff** | A rate agreement: who it is for, when it applies, and its charge lines (basis, slabs, minimum, conditions). Replaces `CustomerRate`. |
| **Charge type** | A kind of money line on an invoice (freight, detention, extra drop, toll, fuel surcharge, shortage deduction…). |
| **Revenue** | The computed money for one consignment: freight, charges, deductions, tax, in the tariff's currency, with its explanation. |
| **Trip profit** | Sum of its consignments' revenue in base currency, less the trip's costs. |

Shape: **Trip 1 ─ n Consignment** (a consignment is on at most one trip at a time; `movements[]` keeps the history). **Consignment 1 ─ n Line**, **1 ─ n Leg**, **1 ─ n Document**, **1 ─ 1 Revenue**. **Leg n ─ 1 Stop** (several consignments' legs can attach to one stop).

### 3.2 Data model

All in `src/modules/operations/models/` unless said. Mongoose, `strict: 'throw'`, `schemaOptions` from `core/masters/schema.ts`, money as `{ amountMinor, currencyId }`. Embedded arrays are used for lines, legs, documents and charges because a consignment is read and written as one unit and even a courier consignment stays small; the one array that could grow (events) goes to the Activity log already present (`support.ts log`).

#### 3.2.1 `Consignment` (replaces today's schema in `cargo.model.ts`)

```ts
const consignmentSchema = new Schema<any>({
  number: { type: String, required: true },                  // CN/26/0001 or the company's LR series
  consignmentTypeId: { type: ObjectId, ref: 'ConsignmentType' },
  status: { type: String, enum: CONSIGNMENT_STATUSES, required: true, default: 'booked' },
  // Parties
  customerId: { type: ObjectId, ref: 'Party', required: true },      // bill-to; defaults from the trip
  consignorPartyId: { type: ObjectId, ref: 'Party' },
  consignor: { type: contactSchema, default: undefined },            // inline when no party
  consigneePartyId: { type: ObjectId, ref: 'Party' },
  consignee: { type: contactSchema, default: undefined },
  brokerPartyId: { type: ObjectId, ref: 'Party' },
  paymentTerms: { type: String, enum: ['to_be_billed', 'paid', 'to_pay'], default: 'to_be_billed' },
  // Movement
  tripId: { type: ObjectId, ref: 'Trip' },                            // the trip carrying it now (may be empty: booked)
  movements: { type: [movementSchema], default: [] },                 // every trip it has been on, oldest first
  bookedAt: { type: Date, required: true },
  requiredBy: Date,
  lines: { type: [lineSchema], required: true },                      // >= 1
  legs: { type: [legSchema], required: true },                        // >= 1 pickup, >= 1 drop (planned)
  documents: { type: [consignmentDocumentSchema], default: [] },
  references: { type: referencesSchema, default: undefined },
  revenue: { type: revenueSchema, default: undefined },
  advances: { type: [advanceSchema], default: undefined },
  shortage: { type: shortageSchema, default: undefined },             // the driver-side shortage, as today
  outcome: { type: outcomeSchema, default: undefined },               // returned / transferred / written off (today's returned, transfers, writeOff)
  notes: String,
  custom: { type: Schema.Types.Mixed, default: undefined },
  createdBy, updatedBy,
}, schemaOptions);

export const CONSIGNMENT_STATUSES = [
  'draft', 'booked', 'assigned', 'loading', 'loaded', 'in_transit', 'delivering', 'delivered', 'closed',
  'cancelled', 'returning', 'returned', 'written_off',
] as const;
```

Status is **derived** from the legs on every save by `deriveStatus(consignment)`: `booked` (no trip), `assigned` (trip, nothing loaded), `loading` (some pickups done), `loaded` (all pickups done, no drop), `delivering` (some drops done), `delivered` (all drops done), `closed` (delivered and priced-frozen, or trip settled). `cancelled`, `returning/returned`, `written_off` are set by actions.

Indexes:

```ts
consignmentSchema.index({ number: 1 }, { unique: true });
consignmentSchema.index({ tripId: 1, status: 1 });
consignmentSchema.index({ customerId: 1, bookedAt: -1 });
consignmentSchema.index({ status: 1, bookedAt: -1 });
consignmentSchema.index({ 'legs.stopId': 1 }, { sparse: true });
consignmentSchema.index({ 'references.lrNo': 1 }, { sparse: true });
consignmentSchema.index({ customerId: 1, 'references.customerRef': 1 }, { unique: true, partialFilterExpression: { 'references.customerRef': { $type: 'string' } } });
consignmentSchema.index({ 'revenue.status': 1 }, { sparse: true });     // unpriced / estimated queues
consignmentSchema.index({ 'shortage.status': 1 }, { sparse: true });
consignmentSchema.index({ updatedAt: 1 });
```

The unique index `{ tripId: 1, inTransit: 1 }` is **dropped** (3.10).

Sub-schemas:

```ts
/** A person or company without a party record: a consignee who is only a phone number. */
const contactSchema = new Schema({
  name: { type: String, required: true },
  phone: String, whatsapp: String, email: String,
  address: String, cityId: { type: ObjectId, ref: 'City' },
  taxId: String,
}, { _id: false, strict: 'throw' });

const movementSchema = new Schema({
  tripId: { type: ObjectId, ref: 'Trip', required: true },
  from: { type: Date, required: true }, to: Date,
  reason: String,                      // 'assigned' | 'transferred: breakdown at Mpika' …
  by: { type: ObjectId, ref: 'User' },
}, { _id: false, strict: 'throw' });

const lineSchema = new Schema({
  productId: { type: ObjectId, ref: 'Product', required: true },
  description: String,                 // as on the customer's invoice ("Portland cement 50 kg")
  packagingTypeId: { type: ObjectId, ref: 'PackagingType' },
  /** Planned figures; actuals live on the legs. */
  plannedQty: Number, unit: { type: String, required: true },        // the product's unit symbol, as today's measure.unit
  pieces: Number,                                                   // count of packages when the unit is mass/volume
  grossKg: Number, volumeM3: Number,
  dims: { type: new Schema({ lengthCm: Number, widthCm: Number, heightCm: Number }, { _id: false }), default: undefined },
  declaredValue: { type: moneySchema, default: undefined },
  hazard: Boolean,
  /** Per-line price override when one consignment mixes products at different rates. */
  rate: { type: lineRateSchema, default: undefined },
}, { _id: true, strict: 'throw' });

export const LEG_KINDS = ['pickup', 'drop'] as const;
export const LEG_STATUSES = ['planned', 'arrived', 'done', 'skipped', 'refused'] as const;

const legSchema = new Schema({
  kind: { type: String, enum: LEG_KINDS, required: true },
  sequence: { type: Number, required: true },                 // order among the consignment's legs
  placeId: { type: ObjectId, ref: 'Place' },                  // may be empty while "to be confirmed"
  addressRef: String,                                         // a party address line when no Place exists yet
  stopId: { type: ObjectId },                                 // trip.stops._id once attached
  activityTypeId: { type: ObjectId, ref: 'StopActivityType' },
  status: { type: String, enum: LEG_STATUSES, default: 'planned' },
  plannedAt: Date,
  /** Planned quantity per line at this leg (a split delivery: 9,500 L of line 1 here). */
  planned: { type: [plannedQtySchema], default: undefined },
  /** What was actually loaded or offloaded here, per line. */
  actual: { type: [legMeasureSchema], default: undefined },
  arrivedAt: Date, leftAt: Date,                              // copied from the stop for reporting/detention
  recordedAt: Date, recordedBy: { type: ObjectId, ref: 'User' },
  /** Drops: the POD facts. */
  pod: { type: podSchema, default: undefined },
  /** To-pay freight collected at this drop. */
  collected: { type: moneySchema, default: undefined },
  outcome: { type: String, enum: ['delivered', 'partial', 'refused'] },
  note: String,
  custom: { type: Schema.Types.Mixed, default: undefined },
}, { _id: true, strict: 'throw' });

const plannedQtySchema = new Schema({ lineId: { type: ObjectId, required: true }, qty: Number, pieces: Number }, { _id: false });

/** Today's measureSchema (qty, unit, ambientL, tempC, density, vcf, std20L, certStd20L, gross, tare, ticketNo) plus the line it measures. */
const legMeasureSchema = new Schema({
  lineId: { type: ObjectId, required: true },
  ...measureFields,
  pieces: Number,
  accepted: Number, damaged: Number, shortDelivered: Number,   // drops only, in the line's unit
  docIds: { type: [{ type: ObjectId, ref: 'DriverDocument' }], default: undefined },
}, { _id: false, strict: 'throw' });

const podSchema = new Schema({
  podTypeId: { type: ObjectId, ref: 'PodType' },
  number: String,                                              // delivery note / POD number
  receivedBy: String, receivedAt: Date,
  docIds: { type: [{ type: ObjectId, ref: 'DriverDocument' }], default: undefined },
  remarks: String,                                             // "2 bags torn" as written on the POD
}, { _id: false, strict: 'throw' });

const consignmentDocumentSchema = new Schema({
  documentTypeId: { type: ObjectId, ref: 'ConsignmentDocumentType', required: true },
  number: String, date: Date,
  legId: { type: ObjectId },                                   // the leg it belongs to, when it does
  driverDocId: { type: ObjectId, ref: 'DriverDocument' },       // the photo/PDF as sent
  fileId: { type: ObjectId, ref: 'StoredFile' },               // or a file uploaded by the office
  amount: { type: moneySchema, default: undefined },            // an invoice's value, when read
  validUntil: Date,                                            // e-way bill, permit
  verifiedAt: Date, verifiedBy: { type: ObjectId, ref: 'User' },
}, { _id: true, strict: 'throw' });

const referencesSchema = new Schema({
  customerRef: String, orderNo: String, lrNo: String, ewayBillNo: String, ewayBillValidUntil: Date, sealNos: [String], permitNo: String,
}, { _id: false, strict: 'throw' });

const advanceSchema = new Schema({
  at: { type: Date, required: true }, amount: { type: moneySchema, required: true }, baseAmountMinor: Number,
  paidBy: { type: String, enum: ['consignor', 'consignee', 'customer', 'broker'], required: true },
  paidTo: { type: String, enum: ['driver', 'company'], required: true },
  reference: String, docId: { type: ObjectId, ref: 'DriverDocument' }, recordedBy: { type: ObjectId, ref: 'User' },
}, { _id: true, strict: 'throw' });
```

`outcomeSchema` carries today's `returned`, `transfers` and `writeOff` fields unchanged in meaning (`writeOffSchema` is reused as is), so `undelivered.service.ts` keeps its logic with `consignment.outcome.*` paths.

#### 3.2.2 `revenueSchema` (embedded in Consignment)

```ts
export const REVENUE_STATUSES = ['unpriced', 'estimated', 'priced', 'frozen', 'invoiced'] as const;

const revenueSchema = new Schema({
  status: { type: String, enum: REVENUE_STATUSES, required: true, default: 'unpriced' },
  tariffId: { type: ObjectId, ref: 'Tariff' },
  tariffVersion: Number,                                     // the tariff's version used, so a later edit doesn't move history
  currencyId: { type: ObjectId, ref: 'Currency' },
  pricedOn: Date,                                            // the date whose tariff and exchange rates applied
  pricedAt: Date, pricedBy: { type: ObjectId, ref: 'User' },
  /** Quantities the engine charged on, after chargeOn / chargeable-weight rules. */
  basis: { type: new Schema({ chargeOn: String, qty: Number, unit: String, km: Number, hours: Number, pieces: Number, chargeableKg: Number }, { _id: false }), default: undefined },
  lines: { type: [revenueLineSchema], default: [] },         // freight, charges, deductions, each with explanation
  subtotalMinor: Number, taxMinor: Number, totalMinor: Number,
  baseTotalMinor: Number, rateToBase: Number,                // for trip profit, at pricedOn
  /** Manual price instead of a tariff: who, why. */
  manual: { type: new Schema({ by: { type: ObjectId, ref: 'User' }, at: Date, reason: String }, { _id: false }), default: undefined },
  frozenAt: Date, invoiceIds: { type: [{ type: ObjectId, ref: 'Invoice' }], default: undefined },
  /** The engine's own words for how it got here, one per step, for the screen and the audit trail. */
  explanation: { type: [String], default: [] },
}, { _id: false, strict: 'throw' });

const revenueLineSchema = new Schema({
  chargeTypeId: { type: ObjectId, ref: 'ChargeType', required: true },
  kind: { type: String, enum: ['freight', 'minimum', 'charge', 'deduction', 'tax'], required: true },
  description: { type: String, required: true },
  qty: Number, unit: String, unitPriceMinor: Number,
  amountMinor: { type: Number, required: true },             // negative for deductions
  taxPercent: Number, taxMinor: Number,
  source: { type: String, enum: ['tariff', 'auto', 'manual'], required: true },
  tariffLineId: { type: ObjectId },
  legId: { type: ObjectId },                                 // a detention or extra-drop line names its leg
  formula: String, variables: { type: Schema.Types.Mixed, default: undefined },   // what a formula line saw
  accepted: { type: Boolean, default: true },                // Finance can switch an auto charge off before invoicing
  note: String,
}, { _id: true, strict: 'throw' });
```

#### 3.2.3 Trip changes (`trip.model.ts`)

```ts
const stopSchema = new Schema({
  placeId: { type: ObjectId, ref: 'Place', required: true },
  /** The physical class the arithmetic needs (calc.ts); derived from the activity type. */
  kind: { type: String, enum: STOP_KINDS, required: true },         // 'start' | 'load' | 'via' | 'border' | 'offload' | 'end'
  activityTypeId: { type: ObjectId, ref: 'StopActivityType' },
  legKm, legHours, arrivedAt, arrivedVia, leftAt,                  // as today
  /** Added after dispatch (a late split, a backhaul), and by whom. */
  addedAt: Date, addedBy: { type: ObjectId, ref: 'User' },
  /** Nothing planned here any more (a drop moved elsewhere); kept for the sheet, skipped by the gates. */
  skipped: Boolean,
}, { strict: 'throw' });
```

On the trip: `productId`/`plannedQty` stay for compatibility but are no longer written by the new flow (the first consignment's first line is shown instead); `customerId` stays as the default bill-to for new consignments. New: `consignmentCount`, `loadedKg`, `loadedL` denormalised on save for lists (optional, phase 2).

`EVENT_ORDER` in `stages.ts` keeps its names (`loaded` = every pickup planned so far is recorded; `delivered` = every drop); see 3.7.

#### 3.2.4 `DriverDocument` changes

Add `consignmentId` and `legId` (both optional, indexed sparse) and widen `kind` to include `'pod'`, `'weighbridge'`, `'permit'`, `'eway'`, `'other'` while keeping `'loading'` and `'delivery'` as aliases for the common two. `reading` gains `consignmentNo` (what the driver typed or chose) and `lineQtys[]`.

### 3.3 Route stops and consignment legs

**Stops come from legs.** When a consignment is added to a trip, each of its legs needs a stop at its place: the engine finds an existing stop at that place with a compatible activity (`load` for a pickup, `offload` for a drop) that is not yet reached and attaches (`leg.stopId = stop._id`); otherwise it inserts a new stop. Insertion position: after the last stop the consignment's earlier legs use, before the `end` stop, and before any stop whose cumulative distance from the new place is greater (nearest-insertion by `haversineKm`, with the route master's legs where known). The person sees the proposed order and can drag stops; the order is saved with the trip. `buildStops` (`trips.service.ts`) recomputes `legKm`/`legHours` for the whole list exactly as today.

**Stops can be added or re-ordered while the truck is on the road** when `stopsEditableOnRoad` is on (default on): only stops not yet `arrivedAt` may move or be inserted; `reportPosition` (`trips.service.ts`) already recomputes cumulative km from the stops array each call, so inserted stops take effect at the next position report. Removing a stop that still has planned legs is refused; mark the legs `skipped` first.

**A stop's "type" is a master.** `StopActivityType` (3.4.2) replaces the hard-coded `STOP_KINDS` labels in `web/src/desks/stages.tsx KIND_LABEL` and the driver portal's `STOP_LABEL`. Each activity type has a `physical` field with one of today's six kinds, so `calc.ts` (`validateStops`, `legLoaded`, `fuelEstimate`) needs only one change: `legLoaded` reads the load state from the consignments' legs (loaded quantity on board after each stop) rather than "between the first load and the first offload". For a trip with no consignments yet, it falls back to today's rule.

`validateStops` becomes: first is `start`, last is `end`, one of each; every pickup leg's stop comes before every drop leg's stop of the same consignment; at least one `load`-physical stop **or** the company setting `tripsWithoutCargo` is on (a repositioning trip). The old "exactly one load and one offload" rule goes.

**What the driver sees:** the stop list with the activity name from the master ("Load at TIPER", "Offload 9,500 L at Puma Kabwe") and, under each stop, the consignments touched there.

### 3.4 New masters and their defaults

All are ordinary masters through `defineMaster` (`src/core/masters/define.ts`), so they get CRUD, audit, custom fields, import, the console and the setup kit (`src/modules/setup/kit.ts` snapshot) for free. Group: `GROUPS.cargo` for 3.4.1–3.4.3 and 3.4.6; `GROUPS.money` for 3.4.4–3.4.5. Defaults ship through `starterLists.ts`/`sampleData.ts` and the setup wizard's "Freight" step; a company can archive any.

#### 3.4.1 `consignment-types` (`ConsignmentType`)

What kind of consignment this is and which rules apply by default.

| Field | Meaning | Defaults shipped |
| --- | --- | --- |
| `code`, `name`, `description` | | `FTL` Full load; `PTL` Part load; `BULK_LIQUID` Bulk liquid (fuel); `CONTAINER` Container; `COURIER` Parcels |
| `cargoKind` | `volume` / `weighed` / `counted` default for new lines | FTL weighed, BULK_LIQUID volume, CONTAINER counted, COURIER counted |
| `multiDrop` | may have several drops | FTL no, PTL yes, BULK_LIQUID yes, COURIER no |
| `multiPickup` | may have several pickups | BULK_LIQUID yes, others no |
| `splitDecidedLate` | drops may be left "to be confirmed" at booking | BULK_LIQUID yes |
| `defaultTariffBasis` | hint for the tariff editor | FTL per_consignment, PTL per_kg, BULK_LIQUID per_litre_20, CONTAINER per_piece, COURIER per_kg |
| `requiredDocuments` | list of `{ documentTypeId, step }` overriding the company default | BULK_LIQUID: loading certificate at pickup, delivery note at drop |
| `podTypeId` | default POD type | signed note |
| `requireConsigneeParty` | consignee must be a Party | off |
| `numberingSeries` | the numbering series to draw numbers from (else `consignments`) | — |
| `printLayoutId` | the LR / consignment note layout | — |

Today's `LoadType` master (`pricingBasis`, `multiDropAllowed`) is folded into this one: the migration renames `load-types` records into `consignment-types` and `TripType.loadTypeId` becomes `defaultConsignmentTypeId`.

#### 3.4.2 `stop-activity-types` (`StopActivityType`)

Replaces the enum `STOP_KINDS` as the user-facing list and absorbs today's `StopType` master (`waitingCountsAs`, `requiresDocumentTypeId`).

| Field | Meaning | Defaults |
| --- | --- | --- |
| `code`, `name` | | `START` Start, `LOAD` Loading, `OFFLOAD` Offloading, `BORDER` Border, `WEIGHBRIDGE` Weighbridge, `REST` Rest / overnight, `FUEL` Fuel stop, `CUSTOMS` Customs yard, `WASH` Tank cleaning, `END` End |
| `physical` | `start` / `load` / `via` / `border` / `offload` / `end` | as named; WEIGHBRIDGE, REST, FUEL, CUSTOMS, WASH are `via` |
| `holdsTruckUntilRecorded` | the truck cannot pass before legs here are recorded | LOAD on, OFFLOAD on (configurable per type) |
| `freeTimeHours` | before detention starts | LOAD 24, OFFLOAD 24, BORDER 0 |
| `detentionChargeTypeId` | the charge to compute for waiting beyond free time | LOAD → Detention at loading, OFFLOAD → Detention at offloading |
| `requiredDocumentTypeIds` | documents expected at this activity | LOAD → loading invoice/certificate; OFFLOAD → delivery note |
| `driverPrompt` | the sentence sent on arrival | as today's two sentences |
| `countsAsLoadedLeg` | override for fuel estimate (a wash stop on the way back is empty) | by physical |

#### 3.4.3 `packaging-types` (`PackagingType`)

Today `Product.packaging` is an enum (`bulk`, `bags`, …). It becomes a master so "20 ft container", "200 L drum", "50 kg bag", "Euro pallet" can carry conversion facts.

| Field | Meaning | Defaults |
| --- | --- | --- |
| `code`, `name` | | `BULK`, `BAG50` 50 kg bag, `DRUM200` 200 L drum, `PALLET` Pallet, `CONT20` 20 ft container, `CONT40` 40 ft container, `CARTON`, `LOOSE` |
| `kgPerPiece`, `litresPerPiece`, `m3PerPiece` | to derive mass/volume from pieces | BAG50 50 kg, DRUM200 200 L, CONT20 33 m³, CONT40 67 m³ |
| `countable` | pieces are the natural quantity | all but BULK |
| `stackable`, `palletPositions` | for a pallet capacity check later | — |

`Product.packaging` keeps working: migration maps the enum values to these codes into `Product.packagingTypeId`.

#### 3.4.4 `charge-types` (`ChargeType`)

| Field | Meaning | Defaults |
| --- | --- | --- |
| `code`, `name` | | `FREIGHT`, `MINIMUM` Minimum charge top-up, `EXTRA_DROP`, `EXTRA_PICKUP`, `DETENTION_LOAD`, `DETENTION_OFFLOAD`, `BORDER_WAIT`, `LOADING_LABOUR`, `UNLOADING_LABOUR`, `FUEL_SURCHARGE`, `TOLL`, `ESCORT`, `HAZMAT`, `REDELIVERY`, `RETURN_FREIGHT`, `CANCELLATION`, `SHORTAGE_DEDUCTION`, `DAMAGE_DEDUCTION`, `ADVANCE_DEDUCTION`, `BROKER_COMMISSION` |
| `kind` | `freight` / `charge` / `deduction` | as named |
| `direction` | `revenue` (billed to the customer) / `cost` (a payable: broker, hired truck) | all revenue except BROKER_COMMISSION |
| `defaultBasis` | one of the bases in 3.5.1 | FREIGHT per_consignment; EXTRA_DROP per_drop_beyond(1); DETENTION_* per_hour_beyond_free; TOLL at_cost; FUEL_SURCHARGE percent_of_freight; SHORTAGE_DEDUCTION shortage_beyond_allowance; ADVANCE_DEDUCTION at_cost |
| `defaultPrice` | money, optional | — |
| `autoApply` | the engine computes it without a tariff line when its facts exist (detention from stop times, extra drops from legs, tolls from expenses in a flagged category, advances from `advances[]`) | DETENTION_* off, EXTRA_DROP off, TOLL off, ADVANCE_DEDUCTION on, SHORTAGE_DEDUCTION by tariff |
| `taxable` | tax applies | all except deductions |
| `accountCodeId` | for the accounting export (`AccountCode`) | — |
| `expenseCategoryIds` | for `at_cost` pass-through: which trip expense categories feed it | TOLL → the "Tolls" category |
| `printLabel` | words on the invoice | = name |

#### 3.4.5 `tariffs` (`Tariff`, replaces `customer-rates`)

A tariff answers "who, when, for what" and holds the charge lines.

```ts
const tariffSchema = masterSchema({
  ...codeNameFields,
  /** Who: a customer, a party in any role, or everyone (a company's standard rate card). */
  customerId: { type: ObjectId, ref: 'Party' },
  consignorPartyId: { type: ObjectId, ref: 'Party' },
  /** Narrowing conditions; each empty one means "any". */
  consignmentTypeId: { type: ObjectId, ref: 'ConsignmentType' },
  routeId: { type: ObjectId, ref: 'Route' },
  fromPlaceId: { type: ObjectId, ref: 'Place' }, toPlaceId: { type: ObjectId, ref: 'Place' },
  fromCountryId: { type: ObjectId, ref: 'Country' }, toCountryId: { type: ObjectId, ref: 'Country' },
  productId: { type: ObjectId, ref: 'Product' }, productGroupId: { type: ObjectId, ref: 'ProductGroup' },
  vehicleTypeId: { type: ObjectId, ref: 'VehicleType' },
  /** validFrom / validTo are the master's own. */
  currencyId: { type: ObjectId, ref: 'Currency', required: true },
  priceOn: { type: String, enum: ['pickup_date', 'delivery_date', 'booking_date', 'trip_dispatch'] },   // empty: company default
  chargeOn: { type: String, enum: ['loaded', 'delivered', 'planned', 'greater_of', 'lesser_of'] },       // empty: company default
  distanceSource: { type: String, enum: ['route_lead', 'trip_loaded_km', 'manual'] },
  volumetricDivisorKgPerM3: Number, minimumChargeableKg: Number, roundQtyUpTo: Number,
  shortageDeduction: { type: String, enum: ['none', 'beyond_allowance', 'all'] }, shortageAllowancePercent: Number,
  shortageScope: { type: String, enum: ['consignment', 'drop'] },
  taxRatePercent: Number,
  lines: { type: [tariffLineSchema], required: true },
  minimumCharge: moneySchema,                        // on the whole consignment, after lines
  priority: { type: Number, default: 0 },           // tie-break after specificity
});

const tariffLineSchema = new Schema({
  chargeTypeId: { type: ObjectId, ref: 'ChargeType', required: true },
  description: String,
  basis: { type: String, enum: RATE_BASES, required: true },
  price: moneySchema,                               // per unit of the basis (or the flat amount)
  percent: Number,                                   // for percent bases
  slabs: { type: [slabSchema], default: undefined }, slabMode: { type: String, enum: ['progressive', 'whole'] },
  minimum: moneySchema, maximum: moneySchema,
  freeQty: Number,                                   // free hours / free drops before the charge starts
  /** A condition in the formula language; the line applies only when true. */
  when: String,
  /** basis = 'formula' */
  formula: String,
  perLine: { type: Boolean, default: false },        // compute per consignment line (mixed products)
  taxRatePercent: Number,
  order: { type: Number, default: 100 },
}, { _id: true, strict: 'throw' });

const slabSchema = new Schema({ upTo: Number, price: moneySchema }, { _id: false });
```

Defaults shipped: none that bind a customer; the setup wizard offers "Standard rate card" templates per consignment type (e.g. BULK_LIQUID: FREIGHT per_litre_20 on delivered; EXTRA_DROP per drop beyond 1; DETENTION_OFFLOAD per hour beyond 24 h). Sample data converts its `CBM-CATH` customer rate into a tariff.

**Matching** (replaces `rateFor` in `pricing.ts`): candidates are active tariffs valid on `priceOn` whose every set condition matches the consignment (customer, consignor, type, route or from/to place or country, product or group, vehicle type). Specificity score = number of set conditions that matched, weighted (customer 16, route 8, from/to place 6, product 4, type 2, vehicle type 1), then `priority`, then latest `validFrom`. No candidate → revenue `unpriced` with the explanation "No tariff covers this consignment; add one under Tariffs or price it by hand."

#### 3.4.6 `consignment-document-types` (`ConsignmentDocumentType`)

Which papers a consignment carries, and when each is required.

| Field | Meaning | Defaults |
| --- | --- | --- |
| `code`, `name` | | `LOADING_INVOICE` Loading invoice, `LOADING_CERT` Loading certificate / BoL, `WEIGHBRIDGE` Weighbridge ticket, `LR` Lorry receipt / consignment note (ours), `EWAY` E-way bill, `PERMIT` Transit permit, `DELIVERY_NOTE` Delivery note, `POD` Proof of delivery, `SEAL_REPORT` Seal report, `OTHER` |
| `step` | `booking` / `pickup` / `transit` / `drop` / `close` | as named |
| `requiredBy` | `none` / `to_leave_stop` / `to_close_trip` / `to_invoice` | LOADING_INVOICE to_leave_stop (fuel default), POD to_invoice, others none |
| `perLeg` | one per pickup/drop (vs one per consignment) | LOADING_*, WEIGHBRIDGE, DELIVERY_NOTE, POD yes |
| `hasNumber`, `hasDate`, `hasAmount`, `hasValidity` | which fields the form shows | EWAY validity; LOADING_INVOICE amount |
| `driverKind` | the `DriverDocument.kind` it maps to when sent from the phone | LOADING_INVOICE→loading, DELIVERY_NOTE/POD→delivery |
| `readFields` | which `reading` fields to ask the driver to type (docNo, qty, tempC, density…) | as today's two |
| `printOn` | invoice / LR / trip sheet | — |

Today's `TripStage.requiredDocumentTypeIds` and `TripType.requiredDocumentTypeIds` point at compliance `DocumentType` (truck/driver papers); they stay. This master is about cargo papers.

#### 3.4.7 Checked against develop `1cbcb7b`: corrections to 3.1–3.4

Sections 1–3.4 were written against `de3a793`. Develop is now `1cbcb7b`, which is the same tree (`git diff de3a793 1cbcb7b` is empty: #127 is the squash of that branch). So the data model in 3.2 still fits. Reading the code again for the second half turned up these corrections; where they differ from the text above, these win.

| # | Where | Correction |
| --- | --- | --- |
| 1 | 3.1 "a company may rename it" | `DEFAULT_WORDS` in `web/src/domain/words.ts` (and the server's copy behind `/meta/workspace`) has no `consignment` term today. Add `consignment` ("Consignment"/"Consignments") and `consignmentNote` ("Consignment note"; a company in India sets "LR"). |
| 2 | 3.2.1, fields dropped | Today's `loadedAt` is what `listConsignments`, `tripSheet` and `priceTrip` sort by, with an index `{ loadedAt: -1 }`. Keep two denormalised dates on the consignment, `loadedAt` (first pickup recorded) and `deliveredAt` (last drop recorded), set by the leg services, and keep that index. Reports and the pricing date read them. |
| 3 | 3.2.1, statuses | `draft` and `in_transit` are in the enum but not in the derivation. `draft` = saved incomplete (a row in the many-consignments grid or an import with errors); it never attaches to stops. `in_transit` = every pickup done and the truck has left its last pickup stop (`stop.leftAt` set) with no drop done. `loaded` is the short time between. |
| 4 | 3.2.1, `legMeasureSchema` | Today's `measureSchema` also has `at`, `podNo` and `docId`. The migration maps them: `delivered.at` → `leg.recordedAt`, `delivered.podNo` → `leg.pod.number`, `docId` → `actual[0].docIds[0]` and `pod.docIds[0]`. |
| 5 | 3.2.1, `outcome` | `ledger.ts` (`driverLedger`) queries `'writeOff.status'` and `'writeOff.carrier'` at the top level and `shortage.status`. `shortage` stays at the top level, so only the two write-off paths change to `outcome.writeOff.*`. `undelivered.service.ts` and `web/src/desks/CantDeliver.tsx` change the same way. |
| 6 | 3.2.4, document kinds | Today `DOC_KINDS` is `loading, delivery, expense, fuel, other`. `expense` and `fuel` stay (Finance's receipts); the widened list is `loading, delivery, pod, weighbridge, permit, eway, expense, fuel, other`. |
| 7 | Situation 22, WhatsApp | On a real WhatsApp connection every photo is filed as `kind: 'other'` (`whatsapp.service.ts` `onInbound` → `fileDriverMessage`); only the driver app and the simulated phone know the kind. So the bot must ask two things, not one: what the photo is, then which consignment. See 3.8.3. |
| 8 | Situation 24, capacity | The fields that exist are `Vehicle.payloadKg` (read as `truckFacts().capacityT`), `Trailer.capacityKg`, `Trailer.capacityL` and `Trailer.compartments[]`. There is no `palletCapacity`. Mass limit = the smaller of the vehicle's payload and the trailer's `capacityKg` when both are set; volume limit = `Trailer.capacityL`; a piece limit needs a new optional `Trailer.capacityPieces` (phase 2). Today's check also skips products measured in units other than L, kg and t; the new one converts through the packaging type (3.4.3) and the product's `densityKgPerL`. |
| 9 | 3.4.1, `LoadType` | `LoadType.pricingBasis` uses `PRICING_BASES` (`per_tonne, per_litre, per_km, per_trip, per_day, flat`), not the billing bases. Migration maps `flat` → `per_consignment`, `per_trip` → `per_trip`, `per_day` → `per_consignment` with a note on the record (a per-day basis is a detention-style charge, not a freight basis); the rest keep their names. |
| 10 | 3.4.2, `StopType` | The existing `stop-types` master (`src/modules/trips/models/stopType.model.ts`) is not used by trip stops at all today: stops only carry `kind`. Its `requiresDocumentTypeId` points at the compliance `DocumentType`. In `StopActivityType` keep that field as `requiredComplianceDocumentTypeId` and name the cargo-paper list `requiredCargoDocumentTypeIds` (→ `ConsignmentDocumentType`), so the two document families are not mixed. The master stays in `GROUPS.trips`. |
| 11 | 3.4.2, free time | The GPS design (`gps-design.md` 4.3) proposes a `DetentionPolicy` master with free minutes per place, customer and product. Both stand: `StopActivityType.freeTimeHours` is the company default; a `DetentionPolicy` that matches overrides it. The revenue engine never reads either directly; it calls one function, `freeMinutesFor(stop, consignment)` (3.5.7). |
| 12 | 3.4.5, module | `customer-rates` is registered with `module: 'billing'`, and Billing is an area that starts switched off (`billing.masters.ts` `isBillingOn`). Revenue and trip profit must work without Billing. Tariffs and charge types are therefore registered with `module: 'trips'` in a new server module `src/modules/freight/`; only invoices, payments and the accounting export stay behind the Billing area. |
| 13 | 3.4.5, company defaults | A tariff's empty `chargeOn` falls back to today's Billing setting `billOn` (default `delivered`), and its empty `shortageDeduction` to `shortageOnInvoice` (`deduct` → `beyond_allowance`). Both settings move to Company → Freight (3.9) and Billing reads them from there. |

### 3.5 The revenue engine

The engine answers one question: "what is this consignment worth, and why?" It runs many times in a consignment's life (an estimate at booking, again when it is loaded, again at each drop) and always from the same facts, so the same input always gives the same answer.

#### 3.5.1 Where it lives

A new server module, `src/modules/freight/`:

| File | What it holds |
| --- | --- |
| `freight.masters.ts` | `defineMaster` for `tariffs`, `charge-types`, `consignment-types`, `consignment-document-types`, `packaging-types` (3.4) |
| `models/tariff.model.ts`, `models/chargeType.model.ts` … | The schemas of 3.4 |
| `revenue/facts.ts` | `factsFor(consignment)`: reads the database once and returns a plain `PricingFacts` object (quantities, distances, times, parties, codes) |
| `revenue/match.ts` | `tariffFor(facts, tariffs)`: the matching rule of 3.4.5 |
| `revenue/engine.ts` | `price(facts, tariff, chargeTypes, settings): RevenueResult`. **Pure: no database, no clock.** Every test is a table of facts in, lines out |
| `revenue/quantities.ts` | Unit conversion, charge-on choice, chargeable weight, rounding |
| `revenue/explain.ts` | Turns each step into one plain sentence for `revenue.explanation[]` |
| `revenue/revenue.service.ts` | `reprice(consignmentId, ctx)`, `setManualPrice`, `freeze`, `acceptLine`; saves `consignment.revenue` |
| `profit/profit.ts`, `profit/profit.service.ts` | Trip profit (3.6) |
| `src/core/formula/{tokens,parse,evaluate,index}.ts` | The formula language (3.5.6); in `core` because detention policies and custom fields may use it later |

`src/modules/finance/billing/pricing.ts` keeps its money helpers (`totalLine`, `totals`, `taxPercentFor`, `rateOrRefuse`, `currencyUnits`) and loses `rateFor`, `quantity`, `loadedKm` and `priceTrip`; `invoices.service.ts` builds invoice lines from `consignment.revenue.lines` (3.5.9).

#### 3.5.2 Rate bases

`RATE_BASES` (in `tariff.model.ts`; the labels come from `choiceLabels`, so screens say the words on the right). The first group prices freight; the second prices extras; a tariff line may use any of them.

| Basis | Reads as | Amount = price × … | Needs |
| --- | --- | --- | --- |
| `per_consignment` | Fixed, per consignment | 1 | nothing |
| `per_trip` | Fixed, per trip | 1, **once per trip and customer**: the customer's first consignment on the trip carries it; the others get a zero line "Included in CN-0412" | the consignment is on a trip |
| `per_tonne` | Per tonne | charged quantity in tonnes | mass, or volume and density |
| `per_kg` | Per kg | chargeable kg (3.5.4) | mass |
| `per_litre` | Per litre (as measured) | observed litres | volume |
| `per_litre_20` | Per litre at 20 °C | litres at 20 °C (`certStd20L`, else `std20L`) | a volume-corrected product |
| `per_m3` | Per cubic metre | litres ÷ 1,000, or the lines' `volumeM3` | volume |
| `per_piece` | Per piece | pieces (bags, drums, pallets, containers) | a piece count |
| `per_km` | Per km | distance by `distanceSource` | distance |
| `per_tonne_km` | Per tonne-km | tonnes × km | mass and distance |
| `per_drop_beyond` | Per drop after the first `freeQty` | max(0, drops − `freeQty`), `freeQty` default 1 | drop legs |
| `per_pickup_beyond` | Per pickup after the first `freeQty` | max(0, pickups − `freeQty`) | pickup legs |
| `per_hour_beyond_free` | Per waiting hour after free time | hours waited − free hours, summed over the stops the charge type names, rounded by `roundQtyUpTo` | stop `arrivedAt` and `leftAt` |
| `per_day_beyond_free` | Per waiting day after free time | the same in days, each started day counting | stop times |
| `percent_of_freight` | Percent of freight | `percent` × the sum of `kind: freight` and `minimum` lines so far | freight lines |
| `percent_of_value` | Percent of declared value | `percent` × the lines' `declaredValue` | declared value |
| `at_cost` | At cost | the approved trip expenses in the charge type's `expenseCategoryIds`, shared between the trip's consignments by `costShareBy` (3.9) | approved expenses |
| `shortage_beyond_allowance` | Shortage beyond the allowance | −(short quantity beyond the tariff's allowance) × the shortage price (3.5.5) | loaded and delivered quantities |
| `damage_value` | Damaged goods | −(damaged quantity) × the line's value per unit | drop `damaged` figures |
| `formula` | Formula | the formula's result (3.5.6) | whatever it names |

Today's four bases map one to one: `per_trip`, `per_tonne`, `per_litre_20`, and `per_km` with `distanceSource: 'trip_loaded_km'` (which is what `loadedKm()` in `pricing.ts` computes now).

A company adds a new basis without code in two ways: a `formula` line, or a new **charge type** with a default basis and price. Adding a basis to the enum is a code change, kept for cases a formula cannot express.

#### 3.5.3 The steps, in order

`price()` does this, and writes one explanation sentence per step:

1. **Facts.** Quantities planned, loaded and delivered per line; distances; stop times; counts of pickups and drops; the parties, product, packaging, route, place and country codes.
2. **Tariff.** The matched tariff (3.4.5) and its version. A manual price skips steps 3–7 for freight but still runs the charges and deductions unless the person ticks "This is the whole price".
3. **Charged quantity.** `chargeOn` picks loaded, delivered, planned, the greater or the lesser (3.5.4). Before anything is loaded the engine uses planned and the result is `estimated`.
4. **Tariff lines,** in their `order`. For each: evaluate `when` (skip the line if false); take the quantity for its basis; apply `freeQty`; price it flat, by `slabs` (progressive or whole), or by `formula`; clamp to the line's `minimum` and `maximum`. With `perLine` on, do this once per consignment line and write one revenue line each. A line-level `rate` on a consignment line (3.2.1) replaces the freight line for that product.
5. **Minimum charge.** If freight lines sum to less than `tariff.minimumCharge`, add a `MINIMUM` line for the difference (as `priceTrip` does today).
6. **Automatic charges.** Each active charge type with `autoApply` on, and not already covered by a tariff line, is computed from its default basis and price. They are written with `source: 'auto'` and `accepted: true`; Finance can switch any of them off before invoicing.
7. **Deductions.** Shortage and damage by the tariff (3.5.5); advances already received (`ADVANCE_DEDUCTION`, from `consignment.advances[]`). Deductions are negative lines.
8. **Tax.** Per line: the line's `taxRatePercent`, else the tariff's, else the Billing settings (`taxPercentFor`). Lines of charge types with `taxable: false` get none. `pricesIncludeTax` is honoured by the existing `totalLine`.
9. **Totals and currency.** Amounts are in the tariff's currency. `baseTotalMinor` and `rateToBase` use the exchange rate on the pricing date (`toBase` in `support.ts`); a missing rate does not fail the pricing: the revenue is saved, `baseTotalMinor` is left empty, and the explanation says "Add the USD rate for 4 Nov under Exchange rates to see this in ZMW." Trip profit shows that consignment as "not converted".
10. **Status.** `unpriced` (no tariff and no manual price, or a line could not be computed), `estimated` (some quantity is still planned), `priced` (all actual). `frozen` and `invoiced` are set by actions, never by the engine (3.5.8).

Rounding: unit prices keep fractions of a minor unit, as today (`0.0123 USD` per litre is stored as 1.23 minor units); each line's amount is rounded to a whole minor unit once (`Math.round(qty × unitPriceMinor)`); totals add the rounded lines. Quantities keep three decimals.

#### 3.5.4 Quantities

**Loaded** = the sum of `actual` over the consignment's pickup legs, per line. **Delivered** = the sum of `accepted` (else `qty`) over drop legs with `outcome` delivered or partial. Refused quantity is not delivered.

| `chargeOn` | Quantity charged |
| --- | --- |
| `loaded` | Loaded |
| `delivered` | Delivered. While some drops are still open: loaded quantity as an estimate, flagged in the explanation |
| `planned` | The lines' `plannedQty` (a contract that pays the nominated quantity whatever is loaded) |
| `greater_of` / `lesser_of` | Of loaded and delivered |

The default when a tariff leaves it empty is the company setting `chargeOnDefault` (default `delivered`, today's `billOn`).

**Converting between units.** The engine converts in this order and says which it used: the unit itself (kg ↔ t, L ↔ m³); the packaging type (`kgPerPiece`, `litresPerPiece`); the measure's own density (kg/m³ on a fuel reading); the product's `densityKgPerL`. This is today's `quantity()` in `pricing.ts`, extended with packaging. If no path exists the line is not priced: "CN-0412 has no weight or density, so it can't be charged per tonne."

**Chargeable weight** (basis `per_kg`, and `per_tonne` when the tariff sets a divisor): the greatest of actual kg, volumetric kg (`volumeM3 × volumetricDivisorKgPerM3`) and `minimumChargeableKg`; then rounded up to `roundQtyUpTo` (1 → next kg, 100 → next 100 kg).

**Distance** (`distanceSource`):

| Source | Distance |
| --- | --- |
| `route_lead` (default) | The consignment's own lead: from its first pickup stop to its last drop stop along the trip's stops (`legKm` summed, which already prefers Route master legs over straight-line distance in `buildStops`). When a Route master has the same two end places, its figure wins, so two trips on the same lane bill the same km whatever detour the truck took |
| `trip_loaded_km` | Today's rule: first loading to last offloading of the whole trip |
| `manual` | `consignment.references.leadKm`, typed by the office |

The lead distance is also saved on the consignment as `leadKm` whenever legs or stops change, because the consignment report (3.11.6) needs it even for consignments with no per-km rate.

**Waiting time** for the detention bases: per stop, `leftAt − arrivedAt` (or now, while the truck is still there, as an estimate), less `freeMinutesFor(stop, consignment)`. A stop shared by several consignments is charged to each consignment whose tariff carries the charge, in full by default (each customer's contract stands alone); `detentionShare: 'split'` divides the hours between them.

#### 3.5.5 Shortage and damage: two policies, kept apart

There are two separate questions and today's code mixes them (`pricing.ts` deducts the driver-side shortage from the customer's invoice):

| | Driver side (exists today) | Customer side (new) |
| --- | --- | --- |
| Question | Does the driver pay for the loss? | Does the customer pay less freight, or charge us for the goods? |
| Rule | `ShortagePolicy` master, product, then company default (0.3 %) | The tariff: `shortageDeduction` (`none`, `beyond_allowance`, `all`) and `shortageAllowancePercent` |
| Scope | Per consignment | `shortageScope`: per consignment (default) or per drop |
| Price | `ShortagePolicy.pricePerUnit`, else `Product.shortagePricePerUnit` | The tariff line's `price` when the tariff has a `SHORTAGE_DEDUCTION` line; else the product's shortage price |
| Where it lands | `consignment.shortage`, the driver's ledger, Finance's shortage decision | A negative revenue line (`kind: deduction`) |

Loss is measured the way `shortageFor` does now: fuel at 20 °C, other cargo in its own unit, summed over all pickups and all drops of the consignment. With several products in one consignment the loss is computed per line and the lines are added.

When a tariff leaves `shortageDeduction` empty, the company setting `shortageDeductionDefault` applies (default `beyond_allowance`, which is today's `shortageOnInvoice: 'deduct'`), with the driver-side allowance as the allowance. So a company that changes nothing gets exactly today's invoice.

Damage: the drop's `damaged` quantity × the line's value per unit (`declaredValue ÷ plannedQty`), else the product's shortage price. Written only when the tariff has a `DAMAGE_DEDUCTION` line or the charge type has `autoApply` on.

#### 3.5.6 The formula language

A formula is an arithmetic expression over named facts. It can compute a number (a line's amount or unit price) or a yes/no (a line's `when`). It cannot loop, assign, call anything outside the list below, or reach any object; it is parsed into a tree and the tree is walked (`src/core/formula/`, about 250 lines, no dependency).

```
expr     := or
or       := and ( "or" and )*
and      := not ( "and" not )*
not      := "not" not | compare
compare  := sum ( ( "=" | "!=" | "<" | "<=" | ">" | ">=" ) sum )?
sum      := product ( ( "+" | "-" ) product )*
product  := unary ( ( "*" | "/" | "%" ) unary )*
unary    := "-" unary | primary
primary  := number | string | name | name "(" expr ( "," expr )* ")" | "(" expr ")"
name     := letter ( letter | digit | "_" | "." )*
```

Functions: `min`, `max`, `round(x, digits)`, `floor`, `ceil`, `abs`, `if(condition, a, b)`, `between(x, low, high)`, `slab(x, upTo1, price1, upTo2, price2, …, priceAbove)` (progressive).

Variables (all read-only, all listed with their current values in the tariff editor's test box):

| Name | Meaning |
| --- | --- |
| `qty` | The charged quantity in the consignment's unit, after `chargeOn` |
| `plannedQty`, `loadedQty`, `deliveredQty` | The three quantities |
| `kg`, `tonnes`, `chargeableKg` | Mass, when it can be derived |
| `litres`, `litres20`, `m3` | Volume as measured, at 20 °C, and in cubic metres |
| `pieces` | Count of packages |
| `km`, `tripKm`, `loadedKm` | Lead distance; the whole trip; the trip's loaded distance |
| `pickups`, `drops` | Counts of legs |
| `hoursAtLoading`, `hoursAtOffloading`, `hoursAtBorder` | Waiting beyond free time |
| `days` | Days from first pickup to last drop |
| `declaredValue` | Sum of the lines' declared value, in the tariff's currency |
| `freight` | Freight lines so far (for surcharges) |
| `shortQty`, `damagedQty` | Loss and damage |
| `fuelPrice` | The company's fuel price per litre on the pricing date (3.6.2), for fuel-linked surcharges |
| `product`, `productGroup`, `packaging`, `type`, `route`, `vehicleType`, `fromPlace`, `toPlace`, `fromCountry`, `toCountry`, `paymentTerms` | Codes, as text, for conditions: `packaging = "CONT20"` |
| `custom.<key>` | A company field on the consignment (number, text or yes/no) |
| `line.qty`, `line.pieces`, `line.kg`, `line.product` … | The current line, when `perLine` is on |

Limits and failures: at most 500 characters and 200 nodes; numbers must be finite; dividing by zero, an unknown name, or a text where a number is needed is an error. An error never guesses: the line is not priced, the consignment stays `unpriced`, and the explanation names the line and the reason ("Fuel surcharge: `fuelPrice` has no value on 4 Nov"). A tariff cannot be saved with a formula that does not parse or names an unknown variable (`prepare` in the master definition runs the parser and a dry run with sample values).

Every formula line stores what it saw (`revenueLine.formula` and `variables`), so an invoice query two years later can be answered from the record.

#### 3.5.7 Free time for waiting charges

`freeMinutesFor(stop, consignment)` in `revenue/facts.ts`: a matching `DetentionPolicy` (GPS design 4.3: most specific of place, customer, product) → the tariff line's `freeQty` → `StopActivityType.freeTimeHours` → 0. The explanation names the source: "Waited 61 h at Puma Kabwe, 24 h free (stop type Offloading), 37 h charged."

Times come from `stop.arrivedAt` and `stop.leftAt`, whoever stamped them (GPS, driver, office). When the GPS design's `dwell.status` is `disputed`, the detention line is written with `accepted: false` and a note, so it is not invoiced until someone confirms the times.

#### 3.5.8 When pricing runs, and when it stops

| Moment | What happens |
| --- | --- |
| A consignment is created or its lines, legs, parties or type change | `reprice`: usually `estimated` on planned quantities |
| A pickup or drop is recorded or corrected | `reprice` |
| A stop's arrival or departure time changes; an expense in a pass-through category is approved | `reprice` for the consignments touching that stop or trip |
| A tariff is edited | Nothing by itself. Open consignments pick it up at their next reprice; the Tariffs screen offers "Reprice 14 open consignments" and shows the difference first |
| Someone presses "Reprice" | `reprice`, with the differences shown before saving when a person asks |
| A manual price is set | Freight is replaced by one `source: 'manual'` line; `revenue.manual` keeps who and why; needs the permission `consignment-revenue: update` |
| **Freeze** | On the first of: an invoice is drafted for it, its trip is settled, or someone presses "Freeze". After this nothing reprices it; a change needs "Reopen pricing" (permission `consignment-revenue: manage`, with a reason, refused once invoiced; an invoiced consignment is corrected with a credit note as today) |

Repricing never changes a line a person has touched: a line with `source: 'manual'`, or an auto line switched off (`accepted: false`), survives a reprice. The pricing date is `priceOn` (default `pickup_date`: the first pickup's `recordedAt`, falling back to the booking date while nothing is loaded).

Two people repricing at once are safe: `reprice` reads, computes and saves under the consignment's version (`save()` in `support.ts` already turns a version clash into a retry or a conflict).

#### 3.5.9 What Billing does with it (the join, kept small)

- `unbilledTrips` becomes `unbilled`: consignments with `revenue.status` in `priced` or `frozen`, no `invoiceIds`, delivered, and with the documents whose `requiredBy` is `to_invoice` (the POD by default) unless `invoiceWithoutPod` is on.
- `draftInvoices` groups them by `invoiceFrom`: `trip` (default, as today: one invoice per trip and customer), `nomination`, `consignment` (one each), `customer_period` (all of a customer's between two dates), `on_demand`.
- Invoice lines are copied from `revenue.lines` where `accepted` and the charge type's `direction` is `revenue`, converted to the invoice currency with the existing code. `Invoice.lines.consignmentId` already exists (`billing.model.ts`).
- To-pay consignments: collected cash is a payment against the consignee's invoice (or, with `toPayInvoice: 'none'`, only a receipt in the driver's ledger).

Until phase 4 ships the grouping options, phase 1 keeps `trip`, `nomination` and `on_demand` and only swaps where the lines come from.

#### 3.5.10 Three worked examples

**A. Tanker, split after the border (situation 1).** Tariff "Puma, Dar → Zambia": `FREIGHT` per litre at 20 °C, USD 0.085, charged on delivered; `EXTRA_DROP` USD 150 per drop beyond 1; `SHORTAGE_DEDUCTION` beyond 0.5 % at USD 1.10. Loaded 37,650 L at 20 °C; four drops deliver 37,390 L at 20 °C.

| Line | Quantity | Unit price | Amount (USD) |
| --- | --- | --- | --- |
| Freight, delivered | 37,390 L at 20 °C | 0.085 | 3,178.15 |
| Extra drop | 3 | 150.00 | 450.00 |
| Shortage beyond 0.5 % | 260 − 188 = 72 L | −1.10 | −79.20 |
| **Total before tax** | | | **3,548.95** |

Explanation as saved: "Tariff PUMA-DAR-ZM v3 (customer and route matched). Charged on delivered: 37,390 L at 20 °C from 4 drops. 4 drops, 1 free. Loaded 37,650, delivered 37,390: loss 260 L, allowance 0.5 % = 188 L, 72 L deducted."

**B. Part load on a slab rate (situations 33, 34).** Tariff: per kg, progressive slabs 12 / 10 / 8 at 500 and 2,000 kg, divisor 333 kg/m³, minimum charge 6,000. Actual 400 kg, 3 m³ → chargeable 999 kg → 500 × 12 + 499 × 10 = 10,990.

**C. Fixed price (situation 16).** Tariff line `per_consignment` 40,000. Loaded 28.4 t, delivered 28.1 t: 40,000 either way.

### 3.6 Trip profit

**Trip profit = the revenue of the consignments it carried − what the trip cost.** Everything is in the base currency. It is computed, never typed, and every figure opens the records it comes from.

#### 3.6.1 Revenue side

The sum of `revenue.baseTotalMinor` **before tax** for the consignments in the trip's `movements`, counting only accepted lines whose charge type has `direction: 'revenue'`. Pass-through lines (`at_cost`) are in both revenue and cost, so they cancel out, which is correct.

A transferred consignment (situation 5) counts by `transferRevenueSplit`:

| Value | Revenue goes to |
| --- | --- |
| `delivering_trip` (default) | The trip that delivered it. The first trip shows "CN-0412 moved to TRIP/26/0031: revenue counted there" |
| `by_km` | Each trip, in proportion to the loaded km it drove for that consignment |
| `first_trip` | The trip that loaded it |

Unpriced consignments count as zero and are named in a warning line; estimated ones count and are marked.

#### 3.6.2 Cost side

Each row is a switch in Company → Freight (`profitCosts`), so a company decides what "cost" means for it.

| Cost | Source | Default |
| --- | --- | --- |
| **Fuel** | Litres used × fuel price. Litres used = `openingFuelL` + fuel issued (`FundRequest` of kind `fuel`, status `issued`) − `closingFuelL`; while the trip is open, issued so far. **Fuel issues carry litres but no money today**, so a price is needed: the price typed when the fuel is issued (new optional `FundRequest.unitPrice`), else the `fuel-prices` list (new small master: fuel type, optional place or country, price per litre, valid from), else the company's `defaultFuelPricePerL`. With none of the three, fuel shows as litres with "No fuel price set" and the profit is marked incomplete rather than overstated silently | on |
| **Trip expenses** | Approved `Expense` records on the trip (`baseAmountMinor`), grouped by expense category. Pending ones are listed under "Awaiting approval" and not counted until approved | on |
| **Fuel bought on the road** | Expenses in fuel categories are already in the row above; the fuel row excludes litres bought this way so nothing is counted twice | on |
| **Cost charges** | Revenue lines whose charge type has `direction: 'cost'` (broker commission, hired truck) | on |
| **Losses carried by the company** | Shortage value not charged to the driver (waived, or the company's share under `ShortagePolicy.bearer`), and approved write-offs with `carrier: 'company'` | on |
| **Recovered from the driver** | Shortage charged and write-offs carried by the driver: shown as a negative cost, so the customer's deduction and the driver's payment meet on one screen | on |
| **Other costs** | Manual lines on the trip (`trip.costLines[]`: charge type with `direction: 'cost'`, amount, note, who) for things the system does not track yet, such as a toll account or a driver's trip pay | on |
| **Overhead** | `overheadPerKm` × trip km + `overheadPerDay` × trip days: the owner's own figure for wages, insurance, tyres and finance cost | off (both 0) |

Cash advances are **not** a cost: they are money the driver holds, and become cost only as approved expenses. This matches `ledger.ts`.

#### 3.6.3 The result

```ts
// GET /trips/:id/profit  (profit.service.ts tripProfit)
{
  status: 'estimate' | 'provisional' | 'final',
  currency, revenueMinor, costMinor, profitMinor, marginPercent,
  perKm, perLoadedKm, perDay,
  revenue: [{ consignmentId, number, customer, status, amountMinor, share }],
  costs:   [{ group: 'fuel'|'expenses'|'charges'|'losses'|'recovered'|'other'|'overhead', label, amountMinor, items: [{ ref, label, amountMinor }] }],
  warnings: ['CN-0413 has no price yet', 'No fuel price set'],
}
```

`estimate` while the trip is open (planned quantities, the fuel and cash budget as expected cost); `provisional` once it has ended but something is still open (an unpriced consignment, a pending expense or shortage decision); `final` when every consignment is frozen and the trip is settled.

A snapshot `{ status, revenueMinor, costMinor, profitMinor, at }` is kept on the trip (`trip.profit`) so lists and reports can sort and total without recomputing; `refreshProfit(tripId)` rewrites it after any event that changes a figure. The detailed breakdown is always computed on read.

Who sees it: a new permission area `trip-profit` (read). By default the Owner and Finance roles have it; Operations does not; drivers never do (the driver API never includes revenue, rates or profit). Rates and revenue on a consignment are a sensitive field group (`consignment-revenue`), using the role editor's existing "sensitive fields" switch.

### 3.7 Stage machine changes

The trip type's stages and `EVENT_ORDER` (`stages.ts`) keep their names; only what fires each event changes, so no company has to re-do its stage set-up.

#### 3.7.1 What each event means now

| Event | Today | With many consignments |
| --- | --- | --- |
| `loaded` | `recordLoading` ran once | The first time the truck has cargo on board and **no planned pickup remains at any stop before the first drop stop**. A backhaul picked up later does not un-load the trip; it is just another pickup |
| `arrived_offloading` | Arrived at the first `offload` stop | Arrived at the first stop that has a drop leg |
| `delivered` | The one consignment delivered | Every consignment on the trip is finished here: all drops done, or it was transferred, returned, written off or cancelled; and no planned pickup remains |
| `ended` | `endTrip` | The same. `endTrip` refuses while any consignment on the trip is unfinished. "Nothing was loaded on this trip" still refuses unless `tripsWithoutCargo` is on |

`deriveTripEvents(trip, consignments)` in `stages.ts` computes these from the legs after every leg change and calls the existing `recordEvent`. Events are only ever added, as today.

#### 3.7.2 The gate at each stop

Today `arrivalRefusal` and `reportPosition` (`trips.service.ts`) hold the truck at the first `load` stop until a consignment exists, and at the first `offload` stop until it is delivered. They are replaced by one function used by both:

```ts
/** The first stop the truck may not pass yet, and why. */
stopGate(trip, consignments): { index: number; reason: string; driverReason: string } | null
```

A stop holds the truck when its activity type has `holdsTruckUntilRecorded` and any of these is true:

| Check (setting) | Default | Message to the office |
| --- | --- | --- |
| A leg planned here is not recorded (`leaveStopRequires` includes `lines`) | on | "Record the loading of CN-0412 at TIPER first." |
| A document with `requiredBy: 'to_leave_stop'` for a leg here is missing (`required_documents`) | on, but only LOADING_INVOICE has that default | "CN-0412 needs its loading invoice." |
| It is a `load`-physical stop and the trip has **no consignment at all** (`consignmentBy`) | on | "Add the consignment for this trip first." |
| A consignment loaded here is unpriced and `consignmentRateRequired` is `at_loading` | off | "CN-0412 has no rate yet." |

This is the default policy, not a fixed rule (3.9.1): it follows the wish that a trip should not run on from loading without its consignments, and with one consignment it behaves exactly as today. `leaveStopRequires: []` and `consignmentBy` relax it; each activity type's `holdsTruckUntilRecorded` switches it per kind of stop. The driver sees `driverReason` ("Waiting for Operations to record the loading."). `reportPosition` clamps the reported km at the gate stop's cumulative km, as it clamps at the load stop now. A person with the permission `stop-gate: override` can pass a gate with a reason, which is logged on the trip.

`consignmentBy` decides how early a consignment must exist: `loading` (default: by the time the truck leaves the first loading stop, today's behaviour) or `dispatch` (dispatch is refused without at least one consignment: for companies that book first).

#### 3.7.3 Recording a pickup and a drop

`recordLoading` and `recordDelivery` in `cargo.service.ts` become `recordPickup(consignmentId, legId, input, ctx)` and `recordDrop(…)` in a new `consignments.service.ts`; driver-document functions stay in `cargo.service.ts`.

`recordPickup`, in order: the trip is dispatched and active; `assertStageAllows(trip, 'loaded')`; each line's product kind is allowed (`cargoKinds`); measure each line (the existing `measure`, `quantityOf`, `fuelChecks`); **capacity** (below); arrive at the leg's stop (`arriveAt` with the stop's own index, not "the first load"); save the leg (`status: 'done'`, `actual`, documents); `deriveStatus`; `deriveTripEvents`; `reprice`; mark the driver documents recorded; tell the driver; `announce('trip.loaded')` once per trip and `announce('consignment.loaded')` each time.

`recordDrop` mirrors it: the "delivered more than loaded" check (`deliveredOverLoadedPercent`) now compares the consignment's **running delivered total** with its loaded total; the driver-side shortage (`shortageFor`) is computed once, when the consignment's last drop is recorded (per drop with `shortageScope: 'drop'`); the trailing stops at the same place are arrived at only when the trip's last drop is done, as today.

Both accept several consignments in one call (`POST /trips/:id/stops/:stopId/record`), so 40 parcels dropped at one stop are one action.

**Capacity.** On board after this pickup = everything loaded on the trip and not yet dropped, plus this pickup, per dimension (kg, litres, pieces; converted as in 3.5.4). Compared with the limits of correction 8 in 3.4.7. `capacityCheck: 'refuse'` (default) refuses with "ABC 1234 carries 30 t; this would put 31.2 t on board." unless the person holds `capacity: override`; `warn` records it with a warning on the trip; `off` skips it. When the truck and trailer have no limit recorded for a dimension, there is nothing to compare: the pickup is recorded and the screen says "No payload set for ABC 1234, so capacity was not checked" with a link to the vehicle. Planning checks the same sums on planned quantities along the stop order and warns (never refuses) when a stretch of the route is over. For tankers with `compartments[]`, an optional per-compartment plan is phase 3.

Two people recording pickups on the same trip at once: the trip's version is bumped by `arriveAt`/`recordEvent` on every pickup, so the second save clashes and is retried against fresh on-board totals; capacity cannot be passed by a race.

#### 3.7.4 The web's "next step"

`web/src/domain/turn.ts` `workedStep` reads the first load and first offload stop. It changes to walk the stops in order: the **current stop** is the first unfinished stop with legs (or the gate stop). The step's wording comes from that stop: "Confirm 2 loadings at TIPER" (documents waiting), "Waiting for Kelvin's loading invoice for CN-0412", "Driving to Puma Kabwe", "Confirm the delivery of CN-0413 at Puma Ndola". The seven stage ids stay; a trip with a backhaul simply returns from Offloading to Loading on the stepper, which already allows any stage to be current. `stageTimes` uses the derived events.

### 3.8 Driver side

Drivers send photos and little else. The rule for every change here: the driver chooses from what the office planned, and never types what the system already knows.

#### 3.8.1 What the driver app shows (`driverApp.service.ts` `home`, `web/src/driver/DriverPortal.tsx`)

`home().trip.stops[]` gains, per stop, the activity name from the master and `legs[]`: consignment number, `kind`, consignee (or consignor) name **and phone** (a tap calls or opens WhatsApp), product, planned quantity, status, and `send[]`: the document types still expected for that leg. `next` changes from one word (`'loading' | 'delivery'`) to a list: `[{ consignmentId, legId, documentTypeId, label }]`, computed by the same `stopGate` so the phone and the office always agree.

Never sent to the phone: rates, revenue, the customer's price, profit.

#### 3.8.2 Sending a document from the app

`driverSendSchema` gains `consignmentId`, `legId` and `documentTypeId` (all optional). The flow on the phone:

1. At a stop, the stop's card lists its consignments, each with a button named for what is missing: "Send loading invoice", "Send POD".
2. Tapping one opens the camera with the consignment already chosen. The form asks only the `readFields` of that document type (3.4.6), e.g. document number and quantity.
3. If the driver uses the general "Send a photo" button while several consignments are open at the stop, a sheet asks "Which consignment is this for?" with one row per consignment (number, consignee, product). One open consignment: it is chosen without asking.
4. With `podPerStopAllowed` on, the sheet has a first row "All consignments delivered here (one sheet)", which attaches the photo to every drop leg at the stop.

The offline outbox (`web/src/driver/outbox.ts`, idempotency keys) is unchanged: the choice travels with the queued item.

#### 3.8.3 Sending a document on WhatsApp

A real WhatsApp photo arrives with no kind (correction 7). `fileDriverMessage` gains a short, stateless exchange that uses quick-reply buttons, which the messaging layer already sends and redeems (`redeemByLabel`, action tokens):

1. The photo is filed at once as `kind: 'other'` on the trip, so nothing is ever lost if the driver stops replying.
2. If the trip is at a stop with open legs, the bot replies "What is this photo?" with buttons from the document types expected there, plus "A receipt" and "Something else". At a stop with one open leg expecting one document, it skips the question and says "Filed as the loading invoice for CN-0412. Reply WRONG if it isn't."
3. If more than one consignment could own it: "Which consignment?" with one button per consignment (up to WhatsApp's limits; beyond that a numbered list and the driver answers with the number). A caption that contains a consignment number or its position ("2") answers in advance.
4. The answer updates the same `DriverDocument` (`kind`, `consignmentId`, `legId`) and posts the usual card to the office queue.

Operations can always re-file: the document card has "Move to another consignment" and "Change what this is", which is also how a wrong answer is corrected. Unanswered questions expire with the 24-hour window; the document stays where step 1 put it.

#### 3.8.4 Other driver-side points

- **Arrival messages** (`announceArrival`) take their sentence from `StopActivityType.driverPrompt` and list the consignments at the stop, instead of the two fixed tanker sentences.
- **Driver questions** (`placements.ts` `driverQuestions`) ask company fields for the first open consignment today; they become per leg at the current stop.
- **To-pay freight:** the drop form on the phone shows "Collect 4,500 ZMW from the consignee" and asks the amount collected; it lands in the driver's ledger as cash held.
- **Refusal at the door:** a "Not accepted" button on a drop sends a message of kind `other` flagged `refusal` to Operations with a required note; the office decides the outcome (situation 6). The driver never closes a consignment alone.
- **Telling the consignee** (setting `notifyConsignee`, default off): on dispatch and on arrival at the drop, a message to the consignee's contact number through the existing message templates (`announce('consignment.arriving')`), with the driver's name and truck.
- **The simulated phone** (`web/src/phone/*`) gets the same consignment picker and stays labelled "simulated".

### 3.9 Configuration knobs

All in one new block on the company record, `Company.freight` with `FREIGHT_DEFAULTS` beside `OPERATIONS_DEFAULTS` in `src/modules/company/company.model.ts`, read through `freightSettings()`; edited at Company → Freight (3.11.11). Every default below gives today's behaviour for a company with one load and one drop.

| Key | Default | What it changes |
| --- | --- | --- |
| **Consignments** | | |
| `consignmentBy` | `loading` | When a trip must have a consignment: `loading` or `dispatch` |
| `maxConsignmentsPerTrip` | 0 (no limit) | 1 gives the single-load company a screen with no "Add consignment" |
| `defaultConsignmentTypeId` | the trip type's, else FTL | Type of a new consignment |
| `consignorDefault` | `customer` | New consignment's consignor: `customer` or `empty` |
| `consigneeMustBeParty` | off | A consignee may be just a name and phone |
| `consigneePhoneRequired` | off | Booking refuses without the consignee's contact number |
| `createPlacesFromAddresses` | on | A party address used as a drop becomes a Place |
| `duplicateCheck` | `warn` | Same consignor, consignee, product and day: `warn`, `refuse`, `off` |
| `numbering` | series `consignments`, prefix `CN` | Or one series per consignment type |
| `bookWithoutTrip` | off | Shows Unassigned consignments and "Book a consignment" (phase 2) |
| **Stops and loading** | | |
| `stopsEditableOnRoad` | on | Stops may be added or re-ordered after dispatch |
| `lateSplit` | by consignment type | Drops may be left "to be confirmed" and split later |
| `leaveStopRequires` | `['lines', 'required_documents']` | What holds the truck at a loading or offloading stop |
| `capacityCheck` | `refuse` | `refuse`, `warn`, `off` |
| `capacityTolerancePercent` | 0 | Overload allowed before the check bites |
| `tripsWithoutCargo` | off | A trip may end with nothing loaded (repositioning) |
| `podPerStopAllowed` | off | One signed sheet may cover every consignment dropped at a stop |
| `deliveredOverLoadedPercent` | 2 (existing) | Unchanged, now per consignment total |
| `notifyConsignee` | off | Messages to the consignee's number |
| `ewayBillWarnHours` | 0 (off) | Warn this long before an e-way bill or permit expires |
| **Revenue** | | |
| `consignmentRateRequired` | `later` | `later`, `at_booking`, `at_loading` |
| `chargeOnDefault` | `delivered` (today's `billOn`) | Quantity charged when the tariff does not say |
| `priceOnDefault` | `pickup_date` | Which day's tariff and exchange rate apply |
| `distanceSourceDefault` | `route_lead` | Distance for per-km bases |
| `shortageDeductionDefault` | `beyond_allowance` (today's `deduct`) | Customer-side shortage when the tariff does not say |
| `shortageScopeDefault` | `consignment` | Or `drop` |
| `detentionShare` | `each` | Waiting at a shared stop: charged to each consignment, or `split` |
| `costShareBy` | `weight` | How a trip-level pass-through cost is shared between consignments: `weight`, `revenue`, `equal`, `km` |
| `manualPriceNeedsReason` | on | A typed price must say why |
| `freezeOn` | `invoice_or_settlement` | Or `delivery`, `manual` |
| `invoiceWithoutPod` | off | Billing may invoice before the POD is in |
| **Profit** | | |
| `profitCosts` | all but overhead | Which cost groups count (3.6.2) |
| `defaultFuelPricePerL` | empty | Fuel cost when neither the issue nor the price list has a price |
| `overheadPerKm`, `overheadPerDay` | 0 | The owner's fixed-cost figure |
| `transferRevenueSplit` | `delivering_trip` | Which trip gets a transferred consignment's revenue |
| `showProfitOnTripList` | off | A Profit column on the trips table for those allowed to see it |

#### 3.9.1 How the 8 Nov call is used, and where the design departs from it

The call is one group of transporters talking informally. It tells us what matters to them; it does not fix how the product behaves for every company. Each thing said there as a rule is a policy here, with the call's wish as the default where that default is also safe for a company that never heard the call. The owner's brief (any loading and unloading anywhere, many revenue methods, everything configurable, simple for one load and one drop) outranks it.

| Said on the call | In the design | Departure, and why |
| --- | --- | --- |
| "Capacity must not be exceeded" | `capacityCheck`, default `refuse`, with `capacityTolerancePercent` and an override permission; `warn` and `off` exist | Not absolute. Weighbridge and loading-arm figures differ by a little every day, some companies have no payload figures in their masters yet (the check then has nothing to compare and says so rather than blocking), and legal limits differ by country |
| "The trip can't run on after loading until its consignments are entered" | `leaveStopRequires` and `consignmentBy`, default: quantities recorded before leaving a loading stop | Holds on **recorded quantities**, not on paperwork: a missing photo should not strand a truck at a depot gate. Which documents hold a truck is per document type. An override with a reason exists; `leaveStopRequires: []` switches the gate off for companies that record after the fact |
| "Each consignment needs its own POD" | Default: one POD per consignment per drop | `podPerStopAllowed` lets one signed sheet cover a stop (parcel work), and `requiredBy` on the POD document type decides whether it gates invoicing, closing, or nothing |
| The report's eight columns | The report's default saved view, in that order | The report is a column chooser over every consignment fact and company field, with saved views; no column list is fixed in code |
| Rates: fixed, per kg/tonne, piece, km, litre; on loaded or unloaded quantity | All present | Generalised to tariffs with charge lines, slabs, conditions and formulas, because every company that trials this will bring one rate the list did not have |
| A consignment has an invoice number, weighbridge ticket, consignor, consignee | All present as optional data | None is required by code. A fuel haulier needs temperature and density, a parcel carrier needs neither invoice nor weighbridge. What is required is decided per consignment type and document type |
| GPS push of trip no., vehicle, LR, locations, start time | 3.13 and `gps-design.md` | Sent per consignment, since a trip no longer has one LR |
| "Consignments in v1" | Phase 1 | Phase 1 is scoped by what makes a consignment useful from planning to profit, not by the call's list: it adds late splitting, the working-out behind every price, manual pricing, the migration and the driver-side picker, none of which were asked for by name, and leaves booking-before-truck, to-pay freight and e-way bills (all raised or implied) to phase 2 |

Beyond settings, the same things a company can already do everywhere apply here without new work: company fields on consignments with a step (`FieldDefinition`, `entity: 'consignments'`, placements `booking`, `loading`, `delivery`: `placements.ts` already handles the last two), record layouts, the import engine, the words setting, and print layouts.

Settings that are stored but not acted on until a later phase say so on the screen ("Not built yet"), as `docs/ui-rules.md` requires.

### 3.10 Migration

One step, run once per installation at start-up, in the style of `src/modules/connections/migrate.ts` (a row in the `Migration` collection, id `consignments-v2`; idempotent; nothing deleted). File: `src/modules/operations/migrateConsignments.ts`, called from `src/server.ts` after the database connects.

| # | Step | Detail |
| --- | --- | --- |
| 1 | Copy | `consignments` → `consignments_v1` (whole collection, once). The rollback is: restore it and deploy the previous image |
| 2 | Drop the index | `{ tripId: 1, inTransit: 1 }` unique. Mongoose's `syncIndexes` is not relied on; the step calls `dropIndex` and ignores "not found" |
| 3 | Masters | Seed `consignment-types`, `charge-types`, `consignment-document-types`, `packaging-types`, `stop-activity-types` from `starterLists.ts` where the collection is empty. `load-types` records are copied into `consignment-types` with the same `_id` (correction 9); `TripType.loadTypeId` is copied to `defaultConsignmentTypeId`. `stop-types` records are copied into `stop-activity-types` with `physical: 'via'` unless the code is one of the six defaults. `Product.packaging` enum → `packagingTypeId` |
| 4 | Each consignment | Rewritten in place with the same `_id` and `number` (invoices, ledger entries, activity and messages point at these): |
| | | `customerId` ← the trip's; `consignor`/`consignee` strings → inline contacts `{ name }` (a party is linked only when exactly one active party has that exact name; "—" becomes empty) |
| | | `lines: [{ productId, unit: load.unit, plannedQty: trip.plannedQty }]` |
| | | Pickup leg at the trip's first `load` stop: `status: 'done'`, `actual: [load]`, `recordedAt: loadedAt`. Drop leg at the first `offload` stop: `done` with `actual: [delivered]`, `pod.number: delivered.podNo` when delivered; else `planned` |
| | | `documents`: a `LOADING_INVOICE` with `number: invoiceNo`, `driverDocId: loadDocId`; a `DELIVERY_NOTE` from `delivered.docId` |
| | | `movements` from `transfers[]` (or one entry for its trip); `outcome` from `returned`, `transfers`, `writeOff`; `shortage` and `custom` unchanged; `status` by `deriveStatus`; `loadedAt`, `deliveredAt`, `leadKm` filled |
| 5 | Revenue | For consignments already on an approved invoice: `revenue.status: 'invoiced'`, `invoiceIds`, and `lines` copied from the invoice's lines for that consignment, so history shows what was billed, not a recomputation. For the rest: left `unpriced` and repriced on first open (or by the button "Price all open consignments" on the Tariffs screen) |
| 6 | Tariffs | Each `CustomerRate` → one `Tariff` with the same `_id`, `code`, customer, route, product, validity, currency and tax rate, and one `FREIGHT` line with the same basis and price (`per_km` gets `distanceSource: 'trip_loaded_km'`), plus `minimumCharge`. `Invoice.lines.rateId` keeps pointing at the same id. The `customer-rates` master key stays registered as a read-only alias for one release so saved links and imports do not break |
| 7 | Settings | `billing.billOn` → `freight.chargeOnDefault`; `billing.shortageOnInvoice` → `freight.shortageDeductionDefault`. Roles: any role with `customer-rates` access gets the same on `tariffs` and `charge-types`; roles with `consignments` keep it; Owner and Finance get `trip-profit` and `consignment-revenue` |
| 8 | Driver documents | Recorded `loading`/`delivery` documents get `consignmentId` and `legId` from the consignment that references them |
| 9 | Trips | `stops[].activityTypeId` from `kind`. `productId`/`plannedQty` stay as they are. `trip.profit` is not back-filled at start-up (it would price years of history at boot); a job `npm run freight:backfill` does it in batches |
| 10 | Mark done | With counts, in the log and in the `Migration` row |

The setup kit (`src/modules/setup/kit.ts`, `snapshot.ts`) and company file gain the new masters and the `freight` block; a kit made before this change applies cleanly because every new value has a default. `sampleData.ts` and `sampleHistory.ts` are rewritten to the new shape and add one multi-drop tanker trip and one part-load trip, so the demo shows the feature.

API compatibility for one release: `POST /consignments` with today's `loadingSchema` body and `POST /consignments/:id/delivery` keep working as thin wrappers (create a one-line consignment and record its pickup; record the only drop). The web app stops calling them in phase 1; they are removed in phase 2.

Tests that must keep passing unchanged in meaning: `tests/operations.test.ts`, `walkthrough.test.ts`, `real-life.test.ts`, `first-trip.test.ts`, `trip-edge-cases.test.ts`, `undelivered-load.test.ts`, `cargo-units.test.ts`, `billing.test.ts`, `billing-2.test.ts`, `sample-data.test.ts`, `setup-kit.test.ts`. A new `tests/consignments-migration.test.ts` loads a fixture of v1 documents (every shape: in transit, delivered with shortage, returned, transferred twice, written off, invoiced) and checks each result.

### 3.11 Screens

Desktop first: laid out for 1366–1920 px, checked at 1440 and 1366 first. Everything follows `docs/ui-rules.md`: data in framed tables with the first column pinned and each cell on one line; underline tabs; one level of framing (a drawer's entries are cards, their list is not boxed again); figures in one framed line divided by rules, never a row of metric cards; status as a word in a tinted badge; headings first with identifiers on the line below; no side stripes, hover cards, gradients, pills, icon tiles or eyebrow labels; controls from `web/src/ui/kit.tsx` (`Segmented`, `Field`, `UnitInput`, `SwitchField`, `Drawer`, `Modal`, `Rows`, `Status`, `SaveBar`). Nothing a screen shows today is removed. "Consignment" below is the company's own word.

New files: `web/src/consignments/` (`ConsignmentsScreen.tsx`, `ConsignmentDrawer.tsx`, `ConsignmentForm.tsx`, `LegsEditor.tsx`, `SplitDelivery.tsx`, `StopWork.tsx`, `RevenuePanel.tsx`, `ProfitPanel.tsx`, `Report.tsx`, `ManyGrid.tsx`), `web/src/masters/TariffEditor.tsx`, `web/src/masters/FreightSettings.tsx`. Changed: `web/src/desks/NewTrip.tsx`, `Trips.tsx`, `stages.tsx` (Loading, Transit, Offloading, Close panels and `StopEditor`), `TripAside.tsx`, `web/src/domain/{types,turn,calc,words}.ts`, `web/src/driver/DriverPortal.tsx`, `web/src/phone/*`, `web/src/billing/Billing.tsx`, `web/src/Office.tsx` (navigation).

#### 3.11.1 New trip (`NewTrip.tsx`)

The form keeps its order: truck, driver, trailer, customer, route, planned start. Today's two fields "Product" and "Planned quantity" are replaced by a section **Consignments**, directly under the route:

- One consignment row is there from the start, filled from what is already chosen: customer as bill-to and consignor, loading and offloading places from the route's load and offload stops. The row shows, on one line: Product (select), Quantity (`UnitInput` with the product's unit), Consignee (party search that also accepts a typed name), Consignee phone, Rate (read-only: "0.085 USD per litre at 20 °C · tariff PUMA-DAR-ZM", or "No tariff · set a price" as a link). For the one-load company this is the same number of fields as today plus the consignee.
- "More details" on the row opens the full consignment form (3.11.3) in a drawer.
- Below the rows: "Add consignment" and, when `bookWithoutTrip` is on, "Add a booked consignment" (a picker of unassigned ones). With `maxConsignmentsPerTrip: 1` neither button shows.
- When `consignmentBy` is `loading` the row may be left empty ("Add it at loading") and the trip is created without one, as today.
- A framed line under the section: "On board at most: 28.4 t of 30 t · 0 L of 0 L", and a warning sentence when a stretch of the route is over capacity. Beside it, for people with `consignment-revenue`: "Expected revenue ≈ 3,650.00 USD".
- The stop list (`StopEditor`) now shows, under each stop, what happens there ("Load CN (new) · 38,000 L diesel", "Drop: to be confirmed"). Stops generated from consignments are marked "from CN-…" and are removed with their leg, not on their own.

#### 3.11.2 The trip's Consignments tab

The trip view gets underline tabs under its heading: **Stages** (today's stepper and panels, unchanged in place), **Consignments**, **Money** (the profit panel, 3.11.8), **Sheet**. Opening a trip lands on Stages as today.

Consignments tab, top to bottom:

1. A toolbar on one line: "Add consignment", "Add many" (the grid, 3.11.10), "Add a booked consignment", and on the right the on-board line ("On board now: 37,650 L at 20 °C of 40,000 L").
2. One framed table, a row per consignment: Number (pinned) · Status (badge) · Consignor · Consignee · Product (first line's, "+2" when more) · Planned · Loaded · Delivered · From → To (first pickup → last drop, "+3 drops") · Lead km · Documents ("2 of 3", red text when a required one is missing) · Revenue (right-aligned, with "est." when estimated, "No price" as a link) · POD (badge: In / Waiting / Not due). Clicking a row opens the consignment drawer.
3. Under the table, **Route and stops**: the trip's stops as a vertical list, each stop one row with its activity, place, planned and actual times, and indented under it the legs done there (consignment number, pickup or drop, quantity, status). "Re-order stops" turns on drag handles for stops not yet reached; "Add a stop" inserts a border, rest or weighbridge stop.

#### 3.11.3 Consignment drawer and form

A wide drawer (720 px at 1366, 880 px from 1600). Heading: the consignee's name in the serif face; on the line below: number · status badge · type · trip number and plate. Underline tabs inside: **Details · Loads and drops · Documents · Revenue · History**.

- **Details** is the form (`ConsignmentForm.tsx`), in sections of two columns: *Parties* (Bill to, Consignor, Consignee, each a party search with "or type a name and phone" beneath; Consignee phone and WhatsApp; Broker; Payment terms as a `Segmented choice`: To be billed / Paid / To pay). *Goods*: a small table of lines (Product, Description, Packaging, Pieces, Quantity with unit, Gross kg, Volume m³, Declared value, Hazardous) with "Add a line". *References*: Customer reference, Order number, Consignment note number, E-way bill and its expiry, Seal numbers, Permit. *Company fields* placed at `booking`. Type sits at the top as a select; choosing it sets the defaults (cargo kind, multi-drop, documents) and hides what the type does not allow.
- **Loads and drops** (`LegsEditor.tsx`): two lists, Pickups and Drops, each entry a numbered card: place (place search, or "To be confirmed" when the type allows a late split), planned time, planned quantity per line, status, and when done the actual figures and who recorded them. "Add a pickup", "Add a drop", "Split delivery" (3.11.5). A drop that is not yet reached can be moved to another place; a done leg has "Correct" (permission `consignments: manage`, reason required, repriced after).
- **Documents**: a table: Document · Number · Date · For (which pickup or drop) · From (driver app / WhatsApp / office) · Status (Checked / To check / Missing, required ones marked) · the photo thumbnail. "Upload a document" and "Print consignment note".
- **Revenue**: the revenue panel (3.11.7).
- **History**: the activity log entries for this consignment, and its movements between trips.

Footer: Cancel on the left of Save; "Cancel this consignment" separate on the far left, with a second click.

#### 3.11.4 Operations loading screen (the Loading panel in `stages.tsx`, rebuilt as `StopWork.tsx`)

Today: one card, one invoice, one product, three cargo kinds. New: the panel is organised **by stop**, because that is how the work arrives.

1. A heading line per loading stop: place name; on the line below, the activity name, "Arrived 09:14 (GPS)" or "On the way", and how long the truck has been there against free time ("Here 3 h 10 min · 24 h free").
2. Under it, a framed table with **one row per consignment loading at this stop**: Number · Consignor → Consignee · Product · Planned · Loaded · Documents · Status · action. The action is "Record loading" (primary) when a document is waiting or the truck has arrived, else "Type it without a photo".
3. "Record loading" opens the row into a working area (not a modal, so the photo stays readable): on the left the document photo at reading size with zoom and "Return to driver"; on the right the form:
   - **Document**: type (select from the consignment's expected documents, default Loading invoice), number, date, value (when the type has an amount). "Add another document" repeats this block, which is how a consignment gets several invoices, a weighbridge ticket and a seal report at one loading.
   - **Quantities**, one block per line of the consignment, shaped by the product: volume-corrected liquids ask observed litres, temperature, density and the certificate's litres at 20 °C, and show the computed 20 °C volume as they are typed (today's `MeasureForm`, kept whole); weighed goods ask gross, tare and ticket number and show the net; counted goods ask pieces and, when the packaging has a weight, show the derived mass. A line not loaded here is left empty.
   - **Seals and references**: seal numbers, compartment (when the trailer has compartments), company fields placed at `loading`.
   - A framed line: "On board after this: 28.4 t of 30 t." In red with the reason when over, and the Record button disabled unless the person may override.
   - Footer: "Return to driver" (danger, separate), Cancel, **Record loading**.
4. Above the stop tables, when photos have arrived that are not attached to a consignment: **Photos to file**, a strip of thumbnails each with "This is…" (document type) and "For…" (consignment), so a WhatsApp photo is filed in two clicks.
5. "Add a consignment at this stop" under each table: the short row of 3.11.1, for the load that was not planned.
6. At the bottom, the gate in words: "ABC 1234 can leave TIPER when CN-0412 is recorded." or "Ready to leave."

With one consignment and one stop, the screen is one heading and one row that opens to today's form: no extra clicks. A trip with several loading stops shows them in route order, the current one open and the others collapsed to their heading line.

#### 3.11.5 Offloading and the drop-splitting flow (`SplitDelivery.tsx`)

The Offloading panel has the same by-stop shape as loading: per offloading stop, a table of the consignments dropping there, each with "Record delivery". The delivery form: POD or delivery note number, received by, received at, POD type, remarks as written on the POD; per line the delivered figures (same product-shaped blocks), and "Accepted / Damaged / Short" when the consignee did not take everything; "Collected" for to-pay freight; "Not accepted" opens the refusal choices (return, transfer, write off: today's `CantDeliver.tsx`, now per consignment). After the last drop of a consignment the driver-side shortage card (`ShortageCard`) appears as today.

**Splitting a delivery** (the 40,000 L to four depots case). Entry points: "Split delivery" on the consignment's row in the Transit and Offloading panels, on the Consignments tab, and in the drawer. It opens a modal, 880 px wide:

1. Heading "Split the delivery of CN-0412"; below: "37,650 L at 20 °C on board for Puma Energy. Where is it going?"
2. A table of drops, one row each: Drop number (its position; not typed) · Place (place search; "Add a new place" inline with name and town) · Consignee at this drop (defaults to the consignment's; a depot contact name and phone can be typed) · Quantity (`UnitInput`) · Planned arrival · Remove. Rows for drops already done are shown read-only at the top.
3. "Add a drop", and two helpers: "Split equally into [4]" and "Put the rest on the last drop".
4. A framed line: "Planned 37,650 of 37,650 L · 0 left to place." It must reach zero, or the person ticks "Leave the rest to be confirmed".
5. **Stops preview**: the trip's remaining stops with the new offloading stops inserted in the proposed order (nearest-insertion, 3.3), each with its km; drag to re-order; the added km and hours for the trip are stated ("Adds 214 km and about 4 h").
6. For people who see revenue: "Extra drops: 3 × 150.00 USD. Expected revenue 3,548.95 USD (was 3,200.25)."
7. Footer: Cancel, **Save the split**. Saving updates the legs and the trip's stops in one request and tells the driver the new stop list ("Your drops changed: 1 Puma Kabwe 9,500 L, 2 …").

A split can be changed again until each drop is done; a drop that is no longer wanted is removed, and its stop goes with it when nothing else happens there.

#### 3.11.6 Consignments list and the consignment report (`ConsignmentsScreen.tsx`, `Report.tsx`)

A new navigation item "Consignments", between Trips and Nominations, for Owner, Operations and Finance. Page heading "Consignments"; underline tabs: **All · Unassigned** (only with `bookWithoutTrip`) **· To load · On the road · To deliver · Waiting for POD · Unpriced · Report**.

The list tabs share one layout: a toolbar on one line (search by number, reference, party or plate; filters for customer, product, type, date range; "Book a consignment" on the right when booking is on) and one framed table: Number (pinned) · Booked · Status · Customer · Consignor · Consignee · Product · Quantity · From → To · Trip · Truck · Loaded on · Delivered on · POD · Revenue · Invoice. Rows open the drawer. The table pages on the server (`GET /consignments` with filters), because a courier company has thousands.

**Report** is the statement transporters send their customers, and it is a real table, not a chart. Its columns are a choice, not a fixed list; the default view is the one named on the 8 Nov call:

- Filters on one line: date range (by booking, loading, delivery or invoice date: a `Segmented choice`), customer, consignor, consignee, product, route, truck, driver, status, "Only with POD".
- Default columns, then the rest that can be switched on: **Trip no. · Vehicle no. · Invoice date · LR number · Product · Quantity · Route · Lead distance (km)** · Consignment no. · Customer · Consignor · Consignee · Loading invoice no. · Loaded qty · Delivered qty · Difference · Loaded on · Delivered on · POD no. · Days in transit · Rate · Freight · Charges · Deductions · Total · Currency · Invoice no. · Status. "Columns" opens a checklist to hide, show and re-order them; the choice is remembered per person and can be saved as a named view for everyone. Company fields on consignments are offered as columns.
- A totals row pinned at the bottom: count, quantity per unit, km, and money per currency.
- "Group by" (none, customer, product, route, truck, month) adds subtotal rows.
- "Download" gives XLSX or CSV of exactly the visible columns and filters, through the existing export service; "Print" gives a landscape PDF with the company's letterhead for sending to a customer.
- Money columns show only to people with `consignment-revenue`.

#### 3.11.7 Revenue panel on a consignment (`RevenuePanel.tsx`)

In the drawer's Revenue tab and under each consignment in the trip's Money tab.

1. A framed line divided by rules: Status (badge: Unpriced / Estimated / Priced / Frozen / Invoiced) · Tariff (name and version, a link) · Charged on ("Delivered · 37,390 L at 20 °C") · Total ("3,548.95 USD") · In base ("96,531.44 ZMW at 27.20").
2. A table of lines: Charge · Quantity · Unit price · Amount · Tax · Source (Tariff / Automatic / Typed) · a `Switch` "Include" on automatic lines. Deductions are negative, in the same column. A totals row: Subtotal, Tax, Total.
3. **How this was worked out**: the explanation sentences as a plain numbered list, at reading width. A formula line shows the formula and the values it saw.
4. Actions on one line: "Reprice" · "Add a charge" (charge type, quantity, price, note) · "Set the price by hand" (amount, currency, reason, and the tick "This is the whole price") · "Freeze" / "Reopen pricing".
5. When unpriced: the reason in a tinted callout with the way out: "No tariff covers Puma Energy, Dar → Kabwe, diesel on 4 Nov." and two buttons, "Add a tariff" (opens the tariff editor pre-filled) and "Set the price by hand".

#### 3.11.8 The trip's revenue and profit panel (`ProfitPanel.tsx`, the Money tab)

Shown to people with `trip-profit`. Others see the Money tab with only what they see today (budgets, requests, expenses).

1. One framed line divided by rules, large tabular figures: **Revenue 96,531.44 ZMW · Costs 61,204.10 ZMW · Profit 35,327.34 ZMW · Margin 36.6 % · Per km 18.69 ZMW**, with a badge for the status (Estimate / Provisional / Final) and, on a second small line, any warnings as sentences ("CN-0413 has no price yet. Fuel is priced at the company's default 28.50 ZMW per litre.").
2. Two tables side by side at 1366 and wider (stacked below 1100 px):
   - **Revenue**: Consignment · Customer · Status · Amount · Share of trip. Rows open the consignment's revenue panel.
   - **Costs**: grouped rows: Fuel (litres used × price, with the opening, issued and closing litres under it) · Expenses by category · Cost charges · Losses carried by the company · Recovered from the driver (negative) · Other costs · Overhead (when on). Each group opens to its records, and each record opens where it lives (the expense, the fuel request, the shortage decision).
3. Under the costs table: "Add a cost" (charge type, amount, note) and "Awaiting approval" listing pending expenses that are not counted yet.
4. A line of comparison in words, not a chart: "Budget for this trip: fuel 1,240 L, cash 4,500.00 ZMW. Used: 1,198 L, 4,120.00 ZMW."

On the trips list, with `showProfitOnTripList`, a right-aligned Profit column (and Revenue) appears for people allowed to see it. The Owner's Overview gains one framed line "This month: revenue · costs · profit · trips · unpriced consignments", each figure a link to the filtered report.

#### 3.11.9 Masters

All five new masters appear in the masters console (`MastersScreen.tsx`) with the generic list, form, import and audit, under "Cargo" (Consignment types, Packaging types, Consignment document types), "Trip operations" (Stop activity types) and "Money and tax" (Tariffs, Charge types, Fuel prices). Their descriptions, hints and choice labels come from the definitions, as the rules ask. Two need more than the generic form:

**Tariff editor** (`TariffEditor.tsx`, a full-width page inside the masters console, since a drawer is too narrow for a line table):

1. Heading: the tariff's name; on the line below: code · Active / Draft badge · version · "Used by 14 open consignments".
2. **Applies to**: a form in two columns: Customer, Consignor, Consignment type, Route, From place and To place, From country and To country, Product, Product group, Vehicle type, Valid from, Valid until, Priority. Each empty field reads "Any". A sentence underneath states it back: "Applies to Puma Energy, any consignor, diesel, Dar es Salaam → any place in Zambia, from 1 Nov 2026."
3. **How it is charged**: Currency; Charged on (`Segmented choice`: Loaded / Delivered / Planned / Greater / Lesser / Company default); Priced on; Distance from; Volumetric divisor, Minimum chargeable weight and Round quantity up to (`UnitInput`s); Shortage deduction (`Segmented choice`: None / Beyond allowance / All / Company default) with Allowance % and Scope; VAT %; Minimum charge.
4. **Charge lines**: numbered cards (the rules' pattern for a list of entries: number from position, Remove in the header, "Add a line" below; drag to re-order). Each card, on two rows: Charge type (select) · Basis (select, with its sentence under it: "Price × litres at 20 °C") · Price or Percent · Free quantity (when the basis has one) · Minimum · Maximum · Per goods line (`Switch`). A link "Slabs" opens a small table inside the card (Up to · Price, "Add a band", and Progressive / Whole quantity). A link "Only when…" shows the condition field. Basis "Formula" replaces Price with a formula field in a monospaced face and, under it, the list of variables as a two-column reference that can be opened and closed.
5. **Try it**: pick an existing consignment (search) or type sample figures (quantity, km, drops, hours waited); the result shows as the same lines table and explanation as the revenue panel. Errors in a formula show here in words before the tariff can be saved.
6. One save bar when something changed. Saving an active tariff that has been used makes a new version; the bar says so ("Saves as version 4; 14 open consignments will use it when next repriced").

**Charge types**: the generic form is enough, grouped into sections: What it is (name, kind, direction, print label) · How it is worked out (default basis, default price, free time) · When it is added (Automatic `SwitchField` with its line "Added to every consignment whose trip has the facts for it; Finance can switch it off on any consignment") · Tax and accounts (taxable, account code, expense categories for pass-through).

**Consignment types**, **Stop activity types**, **Packaging types**, **Consignment document types**: generic forms. The stop activity type form shows "Behaves as" (`Segmented choice` of the six physical kinds) first, with the sentence "This decides how the route arithmetic treats the stop; the name is yours."

#### 3.11.10 Many consignments at once (`ManyGrid.tsx`, phase 2)

"Add many" opens a full-width grid: one row per consignment, columns for the fields a part-load needs (Consignor, Consignee, Consignee phone, Pickup place, Drop place, Product, Packaging, Pieces, Weight, Declared value, Reference, Payment terms, Rate). Cells are typed or pasted from a spreadsheet (tab-separated); unknown parties and places are marked and resolved in a side list ("3 new consignees: create them / match to existing"). A footer line totals pieces and weight against capacity. "Import a file" uses the existing import dialog (`ImportDialog.tsx`) with the consignments template. Rows with errors are saved as drafts, not lost.

#### 3.11.11 Company → Freight settings (`FreightSettings.tsx`)

A settings page in the house pattern: titled sections of rows (Consignments · Stops and loading · Revenue · Profit), each row the setting's name and a line on what it changes on the left, its control on the right; width capped at 920 px; one save bar. Settings not yet acted on say "Not built yet". The first row of the page is a plain sentence: "With every setting here left as it is, a trip carries one consignment from its loading point to its offloading point, as before."

#### 3.11.12 Billing

The "To invoice" tab lists consignments (grouped by trip, as today, by default) with POD status and revenue; a new filter "Unpriced" shows those that cannot be invoiced and why. Phase 4 adds grouping by consignment and by customer and period.

#### 3.11.13 Driver phone (`DriverPortal.tsx`)

One column, 375 px. The trip card lists stops; the current stop is open and shows its consignments as rows: consignee name, product and quantity, a "Call" and a "WhatsApp" button with words, and the one thing needed next as a full-width button ("Send POD for CN-0412"). Tap targets at least 40 px. The picker sheet of 3.8.2 is a list, each row two lines (number and consignee; product and quantity).

### 3.12 API surface

All under `/api/v1`, validated with Zod strict objects in `operations.schema.ts` and a new `freight.schema.ts`, authorised by area as today. Existing routes not listed are unchanged.

| Method and path | Does | Permission |
| --- | --- | --- |
| `GET /consignments` | Paged list. Filters: `tripId`, `status`, `customerId`, `consignorPartyId`, `consigneePartyId`, `productId`, `unassigned`, `revenueStatus`, `podMissing`, `from`, `to`, `dateField`, `q`, plus today's `shortage` | `consignments: read` |
| `POST /consignments` | Create (booked, or on a trip with `tripId`). Accepts today's loading body for one release (3.10) | `consignments: create` |
| `POST /consignments/bulk` | Create many (the grid, an import); returns per-row results | `consignments: create` |
| `GET /consignments/:id` | One, with legs, documents, revenue (revenue only with `consignment-revenue`) | `consignments: read` |
| `PATCH /consignments/:id` | Edit details, lines, references (versioned) | `consignments: update` |
| `POST /consignments/:id/assign` · `/unassign` | Put on a trip (attaches legs to stops) or take off before loading | `consignments: update` + `trips: update` |
| `PUT /consignments/:id/legs` | Replace the planned legs: the split-delivery save. Body: legs and, optionally, the trip's new stop order. Refuses changes to done legs | `consignments: update` |
| `POST /consignments/:id/legs/:legId/record` | Record a pickup or a drop (measures per line, documents, POD, collected) | `consignments: update` |
| `POST /consignments/:id/legs/:legId/correct` | Correct a recorded leg, with a reason | `consignments: manage` |
| `POST /trips/:id/stops/:stopId/record` | Record several consignments' legs at one stop in one call | `consignments: update` |
| `POST /consignments/:id/documents` · `DELETE …/:docId` | Attach an office upload or a driver document; detach | `consignments: update` |
| `POST /driver-documents/:id/file` | Say what a driver's photo is and which consignment and leg it belongs to | `driver-documents: update` |
| `POST /consignments/:id/cancel` · `/refuse` · `/return` · `/transfer` · `/write-off` | Outcomes, per consignment (generalising `POST /trips/:id/undelivered`, which stays and applies to all of a trip's open consignments) | `consignments: update`, plus today's `loadedTripRoles` rule |
| `GET /consignments/:id/revenue` · `POST …/reprice` | Read; recompute (with `?preview=1` returns the difference without saving) | `consignment-revenue: read` / `update` |
| `POST /consignments/:id/revenue/lines` · `PATCH …/:lineId` | Add a manual charge; accept or drop an automatic one | `consignment-revenue: update` |
| `POST /consignments/:id/revenue/manual` · `/freeze` · `/reopen` | Typed price; freeze; reopen with a reason | `consignment-revenue: update` / `manage` |
| `POST /consignments/:id/advances` | Record an advance received | `consignment-revenue: update` |
| `GET /consignments/report` · `/report.xlsx` · `/report.csv` · `/report.pdf` | The report of 3.11.6 with its filters, columns and grouping | `consignments: read` (money columns need `consignment-revenue`) |
| `GET /consignments/:id/note.pdf` | The printed consignment note / LR | `consignments: read` |
| `PUT /trips/:id/stops` | Re-order or insert stops on a trip, before or after dispatch (only unreached stops) | `trips: update` |
| `GET /trips/:id/capacity` | On-board figures along the route against the limits, planned and actual | `trips: read` |
| `GET /trips/:id/profit` | The breakdown of 3.6.3 | `trip-profit: read` |
| `POST /trips/:id/costs` · `DELETE …/:lineId` | Manual cost lines | `trip-profit: update` |
| `GET /reports/profit` | Totals by trip, truck, customer, route, driver or month (phase 4) | `trip-profit: read` |
| `POST /tariffs/:id/try` | Price sample figures or a named consignment against a tariff, saved or not | `tariffs: read` |
| `POST /tariffs/:id/reprice-open` | Reprice the open consignments a tariff covers (`?preview=1` first) | `consignment-revenue: update` |
| `GET /freight/formula/variables` | The variable list with meanings, for the editor | signed in |
| `GET/PUT /company/freight` | The settings block (through the existing company settings route) | company settings |
| Masters: `/masters/tariffs`, `/charge-types`, `/consignment-types`, `/consignment-document-types`, `/packaging-types`, `/stop-activity-types`, `/fuel-prices` | Generic CRUD, import, audit from `defineMaster` | per master |
| `GET /driver-app/home` | Adds legs per stop and the `next` list (3.8.1) | driver |
| `POST /driver-app/send` | Adds `consignmentId`, `legId`, `documentTypeId` | driver |

`GET /operations/sync` (the desks' working set) keeps sending consignments, now in the new shape; revenue is stripped for viewers without the permission. Message buttons gain the actions `pickup.record`, `drop.record` and `doc.file` beside today's `load.record` and `delivery.record`, which stay as aliases for cards already sent.

New notice events for `notices.ts` (so a company can route them to e-mail, SMS or WhatsApp): `consignment.booked`, `consignment.loaded`, `consignment.delivered`, `consignment.pod_received`, `consignment.split`, `consignment.unpriced`, `consignment.eway_expiring`, `consignment.arriving`.

### 3.13 GPS/analytics push (brief)

The exchange itself (connection type, adapters, outbox, signing, status model, map) is designed in `gps-design.md`; nothing here repeats it. What this design owes it:

- **The payload.** `trip.upsert` (`gps-design.md` 2.3) already carries `consignments[]` with `number`, `lrNumber`, `invoiceNumber`, `product`, `quantity`, `unit`, `loadingStopRef` and `offloadingStopRefs[]`. Those map to `consignment.number`, `references.lrNo` (falling back to `number`), the first `LOADING_INVOICE` document's number, the first line's product and quantity, and the legs' `stopId`s. One addition to that payload is asked for: `loadingStopRefs[]` in the plural, because a consignment can load at two terminals (situation 3). The payload builder reads a small projection, `consignmentsForExchange(tripId)`, exported from `consignments.service.ts`, so the GPS code never reaches into the model.
- **When to push.** A split, an added backhaul, a re-ordered stop list or a transfer changes `stops[]`; each bumps the trip's version, which is the exchange's trigger for a new `trip.upsert`. `stops[].ref` is the stop's `_id` and never changes, including across a re-order, as the GPS design requires.
- **What comes back.** Geofence arrivals and departures land on `stop.arrivedAt`/`leftAt` through the same `arriveAt()`, so the stop gate of 3.7.2 applies to them, and the detention bases of 3.5.2 read them. Free time: 3.5.7. A disputed dwell holds its detention line back from the invoice.
- **Statuses.** The availability statuses in `gps-design.md` 3 ("loaded, in transit", "empty returning") read the trip events of 3.7.1 and the on-board figure of 3.7.3, not the first consignment.
- **The vendor's consignment report** (trip no., vehicle, invoice date, LR, product, quantity, route, lead distance) is our report of 3.11.6, so the two sides can be reconciled line by line.

---

## 4. Phasing

Four phases, each one large pull request built by one agent and tested once at its end. Each leaves develop shippable. Phase 1 is scoped by one test: after it, a transporter can run real freight through the product from planning to profit, whether they carry one load or twenty. It happens to cover what the 8 Nov call raised (many consignments per trip, own load and drop stops, POD per consignment, rates on loaded or delivered quantity, a capacity policy, trip profit, the report), but that list is a check on the scope, not its source.

### Phase 1: Consignments on the trip, from planning to profit

**Ships to users:** a trip carries one or many consignments, each with its own goods, parties and consignee phone, its own loading and offloading stops (several of each), several documents per loading, and its own POD that the driver's upload names. Drops can be split late. The truck's capacity is checked, and it is held at a loading stop until its consignments are recorded. Each consignment is priced from a tariff (fixed, per trip, tonne, kg, litre, litre at 20 °C, m³, piece, km or tonne-km; on loaded, delivered, planned, greater or lesser quantity; with a minimum) or by hand, with the working shown. The trip shows revenue, costs and profit. The consignments list and the report exist and download. A company that changes nothing sees today's flow with one consignment.

**Scope**
- Model: 3.2 with the corrections of 3.4.7; migration 3.10 (all steps); `Company.freight` settings with every key of 3.9 stored, and those of this phase acted on (the rest labelled "Not built yet").
- Legs and stops: 3.3 with the six stop kinds as they are (the `StopActivityType` master is phase 2; `activityTypeId` is stored but labels still come from `kind`).
- Services: `recordPickup`, `recordDrop`, multi-record at a stop, `PUT legs` (split), `stopGate`, `deriveStatus`, `deriveTripEvents`, capacity (kg and litres), `endTrip`/`reportPosition`/`arrivalRefusal`/`remind` rewritten on legs; `undelivered.service.ts` moved to `outcome.*` paths and still acting on all of a trip's open consignments.
- Masters: `consignment-types`, `consignment-document-types`, `charge-types` (shipped with FREIGHT, MINIMUM, SHORTAGE_DEDUCTION, EXTRA_DROP and a generic OTHER; manual charge lines of any type), `tariffs` with flat-priced lines of the freight bases plus `per_drop_beyond` and `shortage_beyond_allowance`, `fuel-prices`.
- Revenue engine: 3.5.1–3.5.5 and 3.5.8 without slabs, conditions, formulas, volumetric weight, automatic charges and detention. Billing reads `revenue.lines` (3.5.9, existing `invoiceFrom` values only).
- Profit: 3.6 complete except overhead and `by_km` transfer split.
- Driver: app picker (3.8.1, 3.8.2), WhatsApp two-question flow (3.8.3), simulated phone, consignee phone on the stop.
- Screens: 3.11.1–3.11.8 (the report with its column chooser remembered per person; views saved for everyone and grouping come in phase 4), the tariff editor without slabs, conditions and formula, 3.11.11, 3.11.12 as far as "Unpriced", 3.11.13.
- API: every route of 3.12 this scope needs.

**Files (main ones)**
`src/modules/operations/models/cargo.model.ts`, `trip.model.ts`; new `consignments.service.ts`, `legs.ts`, `migrateConsignments.ts`; `cargo.service.ts` (documents only), `trips.service.ts`, `stages.ts`, `calc.ts`, `undelivered.service.ts`, `driverApp.service.ts`, `whatsapp.service.ts`, `nominations.service.ts` (one draft consignment per trip), `ledger.ts`, `dashboards.service.ts`, `placements.ts`, `operations.schema.ts`, `operations.router.ts`, `operations.controller.ts`, `printouts.ts`/`pdf.ts` (trip sheet lists consignments); new `src/modules/freight/**`; `src/modules/finance/billing/pricing.ts`, `invoices.service.ts`, `billing.masters.ts`; `src/modules/company/company.model.ts`; `src/modules/meta/starterLists.ts`, `sampleData.ts`, `sampleHistory.ts`; `src/modules/setup/kit.ts`, `snapshot.ts`; roles' default permissions. Web: the files listed at the top of 3.11 except `ManyGrid.tsx`.

**Acceptance tests** (`tests/consignments.test.ts`, `consignments-migration.test.ts`, `revenue-engine.test.ts`, `trip-profit.test.ts`, plus the existing suites unchanged in meaning)
1. One-load company: create a trip with one consignment inline, dispatch, record loading, record delivery, end: the same requests count as before and the same driver messages; the old `POST /consignments` body still works.
2. Three consignments, two loading stops, three drops: stops are generated in route order; each pickup and drop is recorded on its own; `loaded` fires after the last pickup before the first drop; `delivered` after the last drop; `endTrip` refuses before it.
3. One consignment, two loading invoices at two terminals: loaded total is the sum; both documents sit on their legs.
4. Late split: a loaded 38,000 L consignment is split into four drops after the border; four stops are inserted after the truck's position; each drop records its own POD; shortage is computed once on the totals; the driver is told the new stops.
5. Capacity policy: with the default, a pickup that takes on-board mass over the payload is refused; within `capacityTolerancePercent` it passes; a truck with no payload figure is not blocked and the screen says the check could not run; with the override permission it is recorded and logged; with `capacityCheck: 'warn'` it records with a warning; a drop frees capacity for a later pickup (backhaul).
6. Gate policy: with the default, the truck cannot arrive past a loading stop (office, driver, position report) while a consignment planned there is unrecorded, nor while a trip has no consignment; the driver gets the waiting sentence; an override with a reason passes and is logged; with `leaveStopRequires: []` nothing holds.
7. POD per consignment: with two open consignments at a stop, a driver-app upload carrying `consignmentId` lands on that consignment only; an upload without one is asked for; a WhatsApp photo is filed as `other`, then moved by the two answers; Operations can re-file it.
8. Rates: table-driven engine tests for each basis; `chargeOn` loaded vs delivered vs greater; minimum charge top-up; extra-drop line; shortage deduction beyond the allowance; unit conversions (kg ↔ t, litres → tonnes by density); a missing exchange rate leaves base empty with the sentence; an unmatched consignment is `unpriced` with the reason; a manual price survives a reprice; a frozen consignment does not reprice.
9. Tariff matching: customer + route beats customer only; validity dates; priority tie-break; a migrated `CustomerRate` prices a migrated trip to the same invoice total as before (compare with `billing.test.ts` figures).
10. Profit: revenue minus fuel (opening + issued − closing, at issue price, list price, default price, and the "no price" warning), approved expenses only, shortage waived vs charged to the driver, a write-off carried by the company; status moves estimate → provisional → final; a person without `trip-profit` gets 403 and no revenue in `sync`.
11. Report: the default view's eight columns are present and correct for a multi-drop consignment; hiding, adding and re-ordering columns is remembered; filters and totals; XLSX and CSV match the screen; money columns are absent without the permission.
12. Migration: every v1 shape converts; ids and numbers are kept; running it twice changes nothing; the driver ledger balances are identical before and after.
13. UI: `npm run check:ui` passes; the layout audit is clean at 1440, 1366, 1920, 768 and 375 for the trip's Consignments tab, the loading screen with 1 and with 12 consignments, the split modal, the profit panel with a seven-figure amount, and the report with every column on.

**Depends on:** nothing. It should merge before the GPS exchange's payload builder (`gps-design.md` phase 2) or that builder should read `consignmentsForExchange`.

### Phase 2: Booking, volume and every kind of stop

**Ships to users:** consignments can be booked before a truck exists and assigned later; fifty parcels are entered in a grid or imported; stop types are the company's own list (weighbridge, rest, customs, tank wash); packaging types carry weights so bags and drums convert; a refused, returned or transferred consignment is handled on its own while the others carry on; to-pay freight and advances are recorded; one signed sheet can cover a stop; expiring e-way bills and permits warn.

**Scope:** `bookWithoutTrip`, Unassigned tab, assign and unassign; `POST /consignments/bulk`, `ManyGrid.tsx`, import template; `stop-activity-types` and `packaging-types` masters with their migration and the label changes in `stages.tsx` and the driver app; per-consignment outcomes (`/refuse`, `/return`, `/transfer`, `/write-off`) and `CantDeliver.tsx` per consignment; `transferRevenueSplit: 'by_km'`; payment terms, `advances[]`, collected cash to the driver ledger; `podPerStopAllowed`; piece capacity (`Trailer.capacityPieces`); duplicate check; `ewayBillWarnHours`; nominations create a consignment per truck with the nomination's reference; consignee notices; removal of the old loading and delivery endpoints.

**Files:** `consignments.service.ts`, `undelivered.service.ts`, `nominations.service.ts`, `ledger.ts`, `notices.ts`, `src/modules/trips/models/stopType.model.ts` (→ activity type), `src/modules/cargo/models/product.model.ts`, `src/modules/fleet/models/trailer.model.ts`, `src/core/masters/import.ts` (template only), `starterLists.ts`; web `ManyGrid.tsx`, `ConsignmentsScreen.tsx`, `CantDeliver.tsx`, `stages.tsx`, `DriverPortal.tsx`, `Nominations.tsx`.

**Acceptance tests:** book three consignments with no trip, assign two to one trip and one to another, stops generated on both; paste 60 rows, 3 with errors saved as drafts, 57 created, stops grouped by place; a custom "Weighbridge" stop type appears on the route and does not hold the truck, a custom loading-like type does; 600 bags of 50 kg count 30 t against capacity; one of three consignments refused and returned while the other two are delivered and the trip ends correctly; a breakdown transfers two of three consignments and revenue lands by the setting; to-pay cash collected appears in the driver's ledger and on the invoice; a manifest POD attaches to every drop at the stop; a nomination of five trucks gives five trips each with a draft consignment; the old endpoints return 410.

**Depends on:** phase 1.

### Phase 3: The full rate engine

**Ships to users:** slab and tiered rates, chargeable weight, conditions on a line, custom formulas with a test box, extra charges that add themselves (detention from stop times with free time, extra pickups, toll and other costs passed through), customer-side damage deductions, cost-side charges such as a broker's commission, tariff versions with "reprice open consignments", per-line rates for mixed goods, fuel-linked surcharges, overhead in profit, and a compartment plan for tankers.

**Scope:** `src/core/formula/` (3.5.6); the rest of 3.5.2–3.5.7; `ChargeType.autoApply`, `direction: 'cost'`, `expenseCategoryIds`; `freeMinutesFor` with `DetentionPolicy` when the GPS design's phase that adds it has landed (else activity type and tariff only); tariff versioning and `/tariffs/:id/try` and `/reprice-open`; the tariff editor's slabs, conditions, formula field and "Try it"; overhead; `Trailer.compartments` plan on the loading screen.

**Files:** `src/core/formula/**`, `src/modules/freight/revenue/**`, `tariff.model.ts`, `chargeType.model.ts`, `freight.masters.ts`, `profit/profit.ts`; web `TariffEditor.tsx`, `RevenuePanel.tsx`, `StopWork.tsx`.

**Acceptance tests:** a parser and evaluator suite (precedence, every function, every error, the size limits, and a fuzz run of random strings that must never throw anything but a formula error or touch a prototype); situations 33–36 priced to the cent; progressive vs whole slabs; a `when` condition on packaging; detention: 61 h at a stop with 24 h free gives 37 h, shared-stop `each` vs `split`, a disputed dwell is held back; a toll expense approved after delivery appears as a pass-through line shared by weight; broker commission lowers profit and is not on the customer's invoice; editing a used tariff creates version 2 and frozen consignments keep version 1; a tariff with a bad formula cannot be saved.

**Depends on:** phase 1. Independent of phase 2 (can run in parallel with it by a second agent; the two touch different files except `StopWork.tsx`, where phase 3 only adds the compartment block).

### Phase 4: Billing, paper and reports for the outside world

**Ships to users:** invoices per consignment or per customer and period, gated on POD; the printed consignment note / LR in the company's layout; a monthly customer statement of consignments; profit reports by truck, customer, route, driver and month; saved report views and grouping; account codes per charge type in the accounting export; the GPS payload fields of 3.13.

**Scope:** `invoiceFrom: 'consignment' | 'customer_period'`, `invoiceWithoutPod`, to-pay invoices to the consignee; `GET /consignments/:id/note.pdf` with a Print Layout; report saved views, grouping and the PDF; `GET /reports/profit` and its screen; `export.service.ts` posting by `ChargeType.accountCodeId`; `consignmentsForExchange` wired into the exchange payload; `npm run freight:backfill` for historical profit.

**Files:** `src/modules/finance/billing/invoices.service.ts`, `invoicePdf.ts`, `export.service.ts`, `statements.service.ts`, `billing.schema.ts`, `financeSettings.model.ts`; `src/modules/operations/printouts.ts`, `pdf.ts`; `src/modules/freight/profit/reports.ts`; web `Billing.tsx`, `Report.tsx`, a new `web/src/consignments/ProfitReport.tsx`, `Overview.tsx`.

**Acceptance tests:** a multi-consignment trip for two customers drafts two invoices with the right lines; a consignment without POD is listed as not invoiceable and becomes so when the POD is recorded; a month's consignments for one customer make one invoice; a credit note against one consignment's line; the consignment note PDF carries every field of the LR list in 1.1; the profit report's totals equal the sum of the trips' profit panels; the accounting export posts detention to its own account code; the exchange payload for a split trip lists four `offloadingStopRefs`.

**Depends on:** phase 1; the per-charge-type postings need phase 3's charge types; the exchange wiring needs the GPS design's outbound phase.

| Phase | In one line | Depends on |
| --- | --- | --- |
| 1 | Many consignments per trip with their own stops, documents and POD; late split; capacity; stop gate; standard rates; trip profit; list and report; migration | none |
| 2 | Booking before a truck, grid and import, company stop and packaging types, per-consignment refusal/return/transfer, to-pay and advances | 1 |
| 3 | Slabs, conditions, formulas, automatic charges (detention, pass-through), cost charges, tariff versions | 1 |
| 4 | Invoices per consignment or period, printed consignment note, statements, profit reports, GPS payload | 1 (parts need 3 and the GPS outbound phase) |

---

## 5. Open product questions

Only business choices. Each has a recommended default, already built into the design as a setting, so nothing waits on an answer. None is taken from the 8 Nov call as given: each default is what suits most transporters and keeps the one-load case unchanged; the owner can change any of them later in Company → Freight.

| # | Question | Recommended default | Why |
| --- | --- | --- | --- |
| 1 | Is our consignment number the LR number, or do companies keep a separate LR book? | Our number is the LR / consignment note number (series and prefix are the company's), with a separate "Consignment note number" field for a company that writes its own book | One number to quote is simpler; the field covers the rest |
| 2 | When the load would exceed the truck's capacity: refuse, or warn? | Refuse, with an override for people given that permission, and the override logged | Overloading is a legal and safety risk, so the safe default is to stop it; real weighbridge differences still need a way through, and a company can choose warn or off |
| 3 | When no contract says otherwise, is the customer charged on loaded or delivered quantity? | Delivered | It is today's Billing default and the common term in fuel and bulk |
| 4 | Does the customer's invoice lose the shortage automatically, and is that the same figure the driver is charged? | Deduct beyond the allowance by default (as today), but as a separate rule from the driver's charge; a tariff can say none | Two contracts, two rules; a company often absorbs what it does not pass on |
| 5 | Who sees rates, revenue and profit? | Owner and Finance. Operations sees quantities and documents only, until the owner grants it. Drivers never | Rates are the most sensitive data a transporter has |
| 6 | What does a litre of fuel cost, for trip profit? | The price typed when fuel is issued; else a small fuel price list; else one company figure. No price at all shows the profit as incomplete | Fuel issues record litres only today; a wrong silent zero would flatter every trip |
| 7 | Must a consignment have a rate before the truck loads? | No: it may be priced later, and is listed as unpriced until then | Rates are often agreed on the phone after the truck has left |
| 8 | Must the paperwork be in before the truck may leave a loading stop? | The quantities must be recorded; the photo is required only for document types the company marks so (loading invoice, for fuel, by default) | What matters is that the trip knows what it carries; a missing photo should not strand a truck. Fully switchable |
| 9 | When a consignment moves to another truck, which trip gets the revenue? | The trip that delivers it | It matches how the customer is billed; `by_km` is there for owners who judge trucks by profit |
| 10 | Is waiting at a stop shared by several consignments charged to each customer in full, or split between them? | Each in full | Each customer's contract promises its own free time |
| 11 | One POD per consignment at every drop, or one signed sheet for a stop? | One per consignment; the single sheet is a setting for courier-style work | Customers release payment against a POD per consignment; parcel work is the exception |
| 12 | Should "Customer rates" stay as a simple screen beside Tariffs? | No: existing rates become tariffs with one line, and the tariff editor opens in that simple one-line form | Two places to set a price would disagree sooner or later |
| 13 | May a trip end with nothing loaded (an empty repositioning run)? | No, as today; "Stop the trip" already covers a trip that never loaded | Keeps "every trip has revenue or a reason" true for profit reports |
| 14 | When is revenue counted in profit: at loading, at delivery, or at invoice? | As soon as it is priced, marked Estimate until delivered and Final when frozen | The owner wants to see a trip's worth while it runs; the badge keeps it honest |
