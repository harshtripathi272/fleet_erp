# Designs

**Background, not a spec.** These are the thinking behind areas of the app, written before or while they were built.
What is built, and how it behaves, is in the code and its tests. What is next is on
[#140](https://github.com/harshtripathi272/fleet_erp/issues/140). Where a design and the app differ, the app and
Lakshya's later decisions (#23) win.

| Design | What it covers | State (15 Nov 2026) |
| --- | --- | --- |
| [consignments.md](consignments.md) | Consignments, loads and freight revenue: many consignments per trip, loads and drops anywhere on the route, documents and PODs, the revenue engine, trip profit | Phase 1 built (#144–#150). Prices now come from rate contracts (#151), not tariffs. The rest is parked |
| [consignments-api.md](consignments-api.md) | The API contract for the consignments design | As above: background for the built parts |
| [fleet-data-exchange.md](fleet-data-exchange.md) | Exchanging trips, positions and events with GPS and fleet-analytics platforms; truck availability | Parked; GPS is after V1 |

The platform design (Fleet Studio, packages, multi-cloud scripts) was dropped on 11 Nov 2026: each company is one
copy of this repository, deployed by its own DevOps (see the README).

The business calls of 8 and 11 Nov 2026 informed these designs as context, not as a specification: what they stated
as rules are company settings with defaults here.
