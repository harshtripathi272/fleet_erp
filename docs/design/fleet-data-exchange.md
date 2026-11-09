# Fleet data exchange: design for talking to any GPS / telematics / fleet-analytics platform

Status: proposal. Treat the open parts as current thinking. Repo paths are relative to the repository root.

## 0. Where things stand today (verified in the repo)

There is no `src/modules/tracking`. Tracking is spread over these places:

| What | Where | Notes |
| --- | --- | --- |
| Connection kinds and the provider interface | `src/core/connections/types.ts`, `registry.ts`, `index.ts` | `KINDS` includes `gps` (`PositionSource`: `positions()` returns `{deviceId, lat, lng, at, speedKmh, heading}`). Secrets are env-var NAMES (`SECRET_ENV` allow-list in `registry.ts`), never values. |
| GPS providers | `src/core/connections/providers/gps.ts` | `simulated`, `webhook` (field-mapped JSON), `traccar` (polled). Position only. Nothing consumes them yet (#60 is "Coming soon" in `docs/FEATURES.md`). |
| Inbound webhooks | `src/modules/connections/connections.service.ts` (`receiveInbound`, `onInbound`), `connections.router.ts` (`hooksRouter`, `POST /api/v1/hooks/:id`, raw body) | HMAC-SHA256 over `"<ts>.<body>"`, headers `X-Signature-Timestamp` and `X-Signature`, 5-minute window (`registry.ts`: `signBody`, `verifySignature`). Secret lives in `webhookSecretEnv`. `InboundResult` only carries `positions`. The `onInbound` listener hook exists and has no GPS consumer. |
| Connection record | `src/modules/connections/connection.model.ts` | A unique partial index allows ONE enabled connection per kind. |
| Outbox | `src/modules/messaging/dispatcher.ts`, `models/connection.model.ts` (`OutboundMessage`, collection `outbox`) | Queue, lease, `RETRY_MINUTES = [1,5,15,60,240]`, worker via `startOutboxWorker()` in `src/server.ts`. The schema is message-only (`channel` enum email/sms/whatsapp), so it can't carry exchange payloads as it stands. |
| Domain events | `dispatcher.ts` `notify()` and `onEvent()`; `EVENTS` in `src/modules/messaging/models/messaging.model.ts` | Events already include `trip.dispatched`, `trip.arrived_loading`, `trip.loaded`, `trip.arrived_offloading`, `trip.delivered`, `trip.closed`. Listeners are the natural trigger for outbound pushes. |
| Trip | `src/modules/operations/models/trip.model.ts` | `number`, `vehicleId`, `stops[{placeId, kind, arrivedAt, arrivedVia ('office','driver','simulator','gps'), leftAt, legKm, legHours}]`, `plannedStart`, `dispatchedAt`, `endedAt`, `active`, `tracking{km, speed, heading, at, source}`. A unique partial index gives one active trip per vehicle. |
| Position handling | `src/modules/operations/trips.service.ts`: `reportPosition` (line ~575), `arriveAt` (~561), `arriveAtStop` (~616); route `POST /trips/:id/position` in `operations.router.ts`; schema in `operations.schema.ts` | The position is KILOMETRES ALONG THE ROUTE (`km`), not lat/lng. `arrivalRefusal` and the load/offload gates keep the physical order of events. |
| Stage machine | `src/modules/operations/stages.ts` (`EVENT_ORDER`, `recordEvent`, `fireEvent`) | Stages are configured per trip type and complete on events `dispatched`, `loaded`, `arrived_offloading`, `delivered`, `ended`. |
| Place | `src/modules/geography/models/place.model.ts` | `location`, GeoJSON `geo` (2dsphere), `geofenceRadiusM` (default 300), `type` (depot, terminal, refinery, border, customer_site, ...). Circle only. |
| Vehicle | `src/modules/fleet/models/vehicle.model.ts` | `gpsDeviceId`, `gpsVendor`, `registrationKey`, `operationalStatus` (available, on_trip, in_workshop, breakdown, impounded, sold), `odometerKm`, `homeBranchId`. |
| Web | `web/src/tracking/FleetMap.tsx` (hand-drawn SVG, positions from `positionAt(data, trip, km)`), `Tracking.tsx` (MapLibre + openfreemap tiles, per trip), `sim.tsx` (drive simulator), `web/src/desks/Overview.tsx` | `web/src/domain/turn.ts` decides the next step of a trip in the browser. Trucks in the web store have only `placeId` as location, and there is no `navigator.geolocation` anywhere (driver phone location is a fallback we will have to build). |
| Consignments / LR | `src/modules/operations/cargo.service.ts`, `models/cargo.model.ts` | Being redesigned (many per trip). The exchange payload must therefore carry `consignments: []`, not one LR number. |

Consequences that shape the design:

1. Positions are not lat/lng anywhere in the database today. We need a position store, and a way to reduce a lat/lng to "km along the route" so `trip.tracking.km` and the existing guards keep working.
2. The existing `gps` kind is "positions in". The dashboard product is a two-way relationship: trips and places out, events in, and a pull API. That is a different capability, so it gets its own kind. The one-enabled-per-kind rule then lets a company run raw trackers (`gps`) and a dashboard (`fleet-exchange`) side by side.
3. The outbox is message-only. Reuse its pattern (queue, lease, back-off, worker) in a sibling collection and share the retry helper; don't stretch `OutboundMessage`.

---

## 1. Research summary (web search, Nov 2026; check each vendor's docs again before building its adapter)

What I could confirm from public docs, and what is from general knowledge (marked "unverified"):

| Platform | Outbound (ERP to platform) | Inbound (platform to ERP) | Auth |
| --- | --- | --- | --- |
| **Wialon (Gurtam)** (very common in Southern and East Africa through resellers) | Remote API: `resource/update_zone` creates and edits geofences (type 1 line, 2 polygon, 3 circle, radius `w`, points `p`); `resource/update_route` builds routes from geofences (flags for generating events); `order/route_update` creates, updates and deletes orders with a `callMode` | Poll unit messages and events, or notifications that call a URL (unverified) | Token login giving a session id (`eid`) |
| **Samsara** | REST: addresses (geofences), routes and stops | Webhooks 2.0 with a management API; geofence entry and exit alerts; the signature is in `X-Samsara-Signature` (`v1=<hex>`) with a timestamp header | API token (bearer) |
| **Geotab** | `Add`/`Set` of `Zone` entities by JSON-RPC | No webhook. `GetFeed` is a polled feed with a `fromVersion` token (`toVersion` returned), limits about 60 requests a minute and 50,000 rows; `ExceptionEvent` (rules on zones) and `LogRecord` (positions) | Session via `Authenticate` |
| **Flespi (Gurtam; Teltonika devices)** | REST for geofences, devices and calculators (trip and dwell calculators); a geofence can be attached to a stream or calculator | Streams push to an HTTP URL or MQTT; webhooks fire from MQTT topics. Each message is independent, so state such as "arrived" is best computed with a calculator | Token header |
| **Traccar** | REST: `/api/geofences`, `/api/devices`, `/api/permissions` | `event.forward.url` posts JSON for events, `forward.url` for positions, `event.forward.header` for auth headers; WebSocket for a user's devices. Geofence entry and exit are events. Already partly in `providers/gps.ts`. | Basic or token |
| **LocoNav** | REST for trips, geofences (polygons), alerts | Webhooks for alerts and live location (from a published API index; check the real docs) | Token |
| **Fleetx, Intangles, Cartrack, MiX Telematics** | All offer REST APIs. MiX Integrate: assets, drivers, events (event type ids to cache). Intangles advertises APIs and webhooks. Cartrack and Fleetx: I found no public detail, so treat as unverified. | MiX and Cartrack are mostly polled by "since last id/time" cursors | Basic or API key |
| Other Africa-popular (unverified) | Tracker/Ctrack, Mobiliti, Fleetcheck, Nedtrack, Trackmatic, local Wialon or Teltonika/Flespi resellers | Mostly Wialon-compatible or REST pull | Varies |

Patterns that recur, and so are our design inputs:

1. **Two inbound shapes.** Push (webhook, MQTT, stream) and pull with a cursor (Geotab `toVersion`, MiX last-event id, Traccar positions). The adapter interface must support both.
2. **Geofences are first-class objects on the vendor side.** The ERP creates or updates a zone per place, and remembers the vendor's id. Radius, polygon and "circle by centre" all appear.
3. **Trips are rarely a native concept.** Wialon has orders and routes; Samsara has routes with stops; LocoNav has trips; Geotab and Traccar have none. So the portable unit is "a trip record the vendor can store as a job/route/notes", and we must work when the vendor only has zones plus a vehicle. The vendor-neutral model therefore pushes the data, and each adapter says what it can do with it (`capabilities`).
4. **Signing.** Webhooks are signed with HMAC and a timestamp. Our scheme (`X-Signature-Timestamp` + `X-Signature: sha256=`) is the same family. The "Standard Webhooks" convention (`webhook-id`, `webhook-timestamp`, `webhook-signature`) is a de facto standard; I propose accepting it as an alternative header set later (see Phase 6), not a new library.
5. **Idempotency.** Vendors send at-least-once, out of order, with a stable event id (or none). Receivers must dedupe on that id or a derived hash.
6. **Standards.** There is no accepted standard for ERP-to-telematics trip exchange. ISO 15143-3 (AEMP 2.0) covers heavy-equipment telematics and the EU/US "FMS" standards are on-board bus data; neither fits road freight dispatch. So Marichi defines its own small versioned canonical schema (`marichi.fleet-exchange/1`) and maps to vendors in adapters. That is the main risk-reducer: a new vendor is one adapter file.

---

## 2. The "fleet data exchange" connection type

### 2.1 New kind `fleet-exchange`

Edit `src/core/connections/types.ts`:

- Add `'fleet-exchange'` to `KINDS` and to `KIND_INFO`: label "Fleet data exchange", description "Send trips, trucks and places to a GPS or fleet-analytics platform; take back positions and geofence events.", whenNone "Simulated: nothing leaves this server; the simulated partner keeps what would have been sent."
- Add to `Capabilities`: `'fleet-exchange': FleetExchangeClient` (below).
- Add `exchange` to `Provider` alongside the existing `inbound`: `inbound` already reads one signed push (`InboundResult`). Widen `InboundResult` to carry canonical events:

```ts
export interface InboundResult {
  accepted: number;
  positions?: Position[];            // existing, kept
  events?: FleetInboundEvent[];      // new
  note?: string;
}
```

The existing `onInbound(listener)` fan-out in `connections.service.ts` stays; the new consumer is `src/modules/fleet-exchange/inbound.ts` (section 2.5). `SECRET_ENV` already allows `CONNECTION_*` names, so no change to the secret rules. Remember the secret-name check: an adapter never reads `process.env` directly; it asks `ctx.secret(key)`.

### 2.2 The adapter interface (one per vendor, one file each)

```ts
// src/core/connections/types.ts
export interface FleetExchangeCapabilities {
  places: boolean;          // vendor can hold geofences
  trips: 'native' | 'as-notes' | 'none'; // does it store a trip/job/order
  vehicleStatus: boolean;   // accepts our truck status
  inbound: 'push' | 'pull' | 'both' | 'none';
  geofenceEvents: boolean;  // vendor computes enter/exit itself
  maxBatch: number;
}
export interface PushItem { key: string; type: FleetOutType; entityId: string; body: FleetOutPayload }
export interface PushOutcome { key: string; ok: boolean; vendorRef?: string; retryable?: boolean; message?: string; simulated?: boolean }
export interface FleetExchangeClient {
  capabilities: FleetExchangeCapabilities;
  /** Sends a batch; one outcome per item. Never throws for a single item's refusal. */
  push(items: PushItem[], signal?: AbortSignal): Promise<PushOutcome[]>;
  /** Pull-style vendors: events since the cursor. */
  poll?(cursor: string | undefined, signal?: AbortSignal): Promise<{ events: FleetInboundEvent[]; cursor: string }>;
  /** Vendor-specific: turn one push body into canonical events (Samsara, Traccar forward, Flespi stream...). */
  readInbound?(headers: Record<string, string>, body: unknown): FleetInboundEvent[];
}
```

Providers (each registered with `registerProvider`, file per provider under `src/core/connections/providers/fleet-exchange/`, or a flat `fleet-exchange.ts` first):

| Key | What | Phase |
| --- | --- | --- |
| `simulated` | The simulated partner (section 5.2). `simulated: true`; always labelled. | 2 |
| `marichi-json` | The native format below to any URL we configure: base URL, one path per message type (with defaults), auth style (`bearer`, `header`, `basic`, `none`), extra static headers. Covers any vendor whose engineers will accept our schema, or sit behind a small translation function on their side. | 3 |
| `generic-mapped` | Like the existing `webhook` GPS provider: JSON path mapping both ways, for vendors with a flat REST API. Reuses `pick()` from `gps.ts` (move to a shared helper). Outbound uses a small `{{placeholder}}` template per message type (not eval). | 6 |
| `traccar` | Extend the existing provider: geofence push (`/api/geofences`), event forward as inbound | 6+ |
| `wialon`, `samsara`, `geotab`, `flespi`, `loconav`, `mix`, `cartrack`, `fleetx` | One file each when a vendor is chosen. Each maps canonical to its calls, declares `capabilities`, reads its signature scheme | after vendor is known |

Each vendor's secrets are declared in `secrets: SecretSpec[]` (for example `apiToken`), and the Connections screen asks for the env-var NAME. Nothing new is stored in the database. The signing secret for inbound is `webhookSecretEnv` as now. Outbound signing (the vendor verifying us) uses a second name, `outboundSecretEnv`, only for `marichi-json` and `generic-mapped`; add it to `connection.model.ts` as a plain string name (validated with the same `SECRET_ENV` regex), same as `webhookSecretEnv`.

### 2.3 Canonical outbound messages (`marichi.fleet-exchange/1`)

Common envelope (also what the pull API returns, item by item):

```json
{
  "schema": "marichi.fleet-exchange/1",
  "id": "01JC8Z...ULID",
  "idempotencyKey": "trip:67f1...:v7:upsert",
  "type": "trip.upsert",
  "occurredAt": "2026-11-10T07:42:11.000Z",
  "sentAt": "2026-11-10T07:42:12.000Z",
  "company": { "code": "ACME", "name": "Acme Haulage" },
  "data": { }
}
```

Transport: `POST` JSON, headers `Content-Type: application/json`, `Idempotency-Key: <idempotencyKey>`, `X-Signature-Timestamp: <unix seconds>`, `X-Signature: sha256=<hex>` (the same `signBody` we verify inbound, in `src/core/connections/registry.ts`), `X-Marichi-Attempt: <n>`, `User-Agent: MarichiFleet/<version>`. Batch form: `{ "schema": ..., "messages": [ ...envelopes ] }`, up to `capabilities.maxBatch`. A 2xx per item means accepted; 409 with the same key means "already have it" and counts as success; 429 and 5xx retry; other 4xx are permanent failures shown on the Connections screen.

**`trip.upsert`** (created, updated, dispatched, stages moved, stops changed; a snapshot, so the receiver just stores the latest) and **`trip.cancel`** and **`trip.close`**:

```json
{
  "tripNumber": "TRP-2026-00412",
  "version": 7,
  "status": "in_transit",
  "stage": { "code": "transit", "name": "In transit" },
  "cancelled": false,
  "vehicle": { "registration": "ALC 4821", "registrationKey": "ALC4821", "gpsDeviceId": "358480081234567", "externalId": null },
  "trailer": { "registration": "ZT 112" },
  "driver": { "name": "Joseph Banda", "phone": "+260971234567" },
  "customer": { "name": "Zambia Fuels Ltd" },
  "plannedStart": "2026-11-10T06:00:00Z",
  "dispatchedAt": "2026-11-10T06:10:00Z",
  "product": { "name": "Diesel", "quantity": 36000, "unit": "L" },
  "consignments": [
    { "number": "CN-0091", "lrNumber": "LR-5521", "invoiceNumber": "INV-884", "product": "Diesel", "quantity": 36000, "unit": "L",
      "loadingStopRef": "stop-1", "offloadingStopRefs": ["stop-4"] }
  ],
  "stops": [
    { "ref": "stop-0", "seq": 0, "kind": "start",   "place": { "code": "DEP-NDOLA", "name": "Ndola depot", "externalId": null } },
    { "ref": "stop-1", "seq": 1, "kind": "load",    "place": { "code": "REF-NDL", "name": "Ndola refinery" },
      "plannedArrival": "2026-11-10T08:00:00Z", "arrivedAt": null, "leftAt": null },
    { "ref": "stop-2", "seq": 2, "kind": "border",  "place": { "code": "BRD-NAKONDE", "name": "Nakonde border" } },
    { "ref": "stop-3", "seq": 3, "kind": "offload", "place": { "code": "DEP-DAR", "name": "Dar es Salaam depot" } }
  ],
  "route": { "totalKm": 1890, "loadedKm": 1650 },
  "demurrage": { "freeHours": { "load": 6, "offload": 6 } },
  "custom": { }
}
```

Rules: it carries every field above that the company has switched on (section 2.6), the optional ones may be omitted, and `lrNumber` is repeated per consignment, with a convenience top-level `lrNumbers: []`. `stops[].ref` is stable for a stop for the life of the trip, because vendors correlate arrivals with it. `status` is the trip's own state (`planned`, `dispatched`, `loading`, `in_transit`, `offloading`, `delivered`, `closed`, `cancelled`), derived from `events` and stops in `stages.ts`, not from a stage code, so renamed stages never break receivers.

**`place.upsert` / `place.delete`** (geofences):

```json
{ "code": "REF-NDL", "name": "Ndola refinery", "type": "refinery", "role": ["load"],
  "lat": -12.9587, "lng": 28.6366, "geofence": { "shape": "circle", "radiusM": 300 },
  "address": "Ndola, Zambia", "externalId": null }
```

`geofence.shape` is `circle` or `polygon` (`coordinates`: GeoJSON ring). `role` is derived from stops used (load, offload, border, other), so the vendor can filter. Places are pushed only when used on a trip or when "send all places" is on.

**`vehicle.upsert`** (identity) and **`vehicle.status`** (our derived availability, section 3):

```json
{ "registration": "ALC 4821", "registrationKey": "ALC4821", "vin": "...", "gpsDeviceId": "3584...", "vehicleType": "Tanker 36kL",
  "capacity": { "value": 36000, "unit": "L" }, "homeBranch": "Ndola",
  "status": { "key": "loaded_in_transit", "label": "Loaded, in transit", "since": "2026-11-10T08:55:00Z",
              "exportCode": "ONWARD", "tripNumber": "TRP-2026-00412", "nextPlace": { "code": "DEP-DAR" } } }
```

`exportCode` is the company's chosen vendor-facing label for the status (section 3.4), since the dashboard's own status names ("Available returning", "Onward near destination") will not match ours.

A `sync.snapshot` message (full list of active trips, vehicles, places) is sent on "Resync" and after reconnecting, so a vendor that missed pushes can recover. A `sync.snapshot` is also what the pull API (2.7) returns.

### 2.4 Canonical inbound events

All inbound arrive at `POST /api/v1/hooks/:connectionId` (unchanged, signed), or from `poll()`.

```json
{ "schema": "marichi.fleet-exchange/1",
  "events": [
    { "id": "evt-9f3a", "type": "position", "at": "2026-11-10T09:01:00Z",
      "vehicle": { "registration": "ALC 4821", "deviceId": "3584...", "externalId": "w-8812" },
      "lat": -12.97, "lng": 28.64, "speedKmh": 54, "heading": 120, "odometerKm": 184233.4, "ignition": true,
      "source": "device", "accuracyM": 8 },
    { "id": "evt-9f3b", "type": "geofence.enter", "at": "2026-11-10T09:12:40Z",
      "vehicle": { "registration": "ALC 4821" }, "place": { "externalId": "zone-77", "code": "REF-NDL" }, "tripNumber": "TRP-2026-00412" },
    { "id": "evt-9f3c", "type": "geofence.exit",  "at": "2026-11-10T13:55:10Z", "vehicle": { "registration": "ALC 4821" }, "place": { "code": "REF-NDL" } },
    { "id": "evt-9f3d", "type": "ignition", "at": "...", "vehicle": { "registration": "ALC 4821" }, "ignition": false },
    { "id": "evt-9f3e", "type": "odometer", "at": "...", "vehicle": { "registration": "ALC 4821" }, "odometerKm": 184301.2 },
    { "id": "evt-9f3f", "type": "halt", "at": "...", "vehicle": { "registration": "ALC 4821" }, "durationMin": 47, "lat": -13.0, "lng": 28.7 },
    { "id": "evt-9f40", "type": "trip.metrics", "at": "...", "tripNumber": "TRP-2026-00412", "distanceCoveredKm": 612.4, "distanceLeftKm": 1277.6, "idleMin": 95 },
    { "id": "evt-9f41", "type": "device.status", "at": "...", "vehicle": { "registration": "ALC 4821" }, "state": "offline" }
  ] }
```

`source` on a position is `device` (tracker), `phone` (driver's mobile fallback) or `partner` (the platform's own fusion). Event `id` is required for dedupe; if a vendor has none, the adapter derives a stable hash (section 2.8). Vendors can send their own shape: `readInbound` (adapter) or the field mapping (`generic-mapped`) converts to this.

Server handling lives in a new module `src/modules/fleet-exchange/` (the repo style: `*.model.ts`, `*.service.ts`, `*.schema.ts`, `*.router.ts`, `*.controller.ts`), registered from `src/app.ts` and `src/server.ts` (worker). Pipeline for one batch: verify (existing) -> parse to canonical -> dedupe -> resolve ids -> apply:

- `position`: upsert `VehicleState` latest (if newer than what is held) and append to the history collection (TTL, default 14 days, a setting); update `Vehicle.odometerKm` only if the policy says so (default: store `gpsOdometerKm` separately and show the difference; the workshop reading stays authoritative, as the code comment in `vehicle.model.ts` says).
- `geofence.*`: section 4.
- `trip.metrics`: store on `VehicleState.metrics` and on the trip's `gps` summary subdocument (new, optional, strict).
- `ignition`, `halt`, `device.status`: into `VehicleState` (`ignition`, `lastHalt`, `deviceOnline`), used by the status rules and the device-failed fallback (2.9).

### 2.5 Mapping vehicle ids and place ids

New collection `ExternalRef` (`src/modules/fleet-exchange/models/externalRef.model.ts`), not new columns on masters, so any number of vendors and a vendor change are possible:

```ts
{ connectionId, entity: 'vehicle'|'place'|'trip', localId, externalId, lastSentHash, lastSentAt, source: 'auto'|'manual' }
// unique: (connectionId, entity, externalId) and (connectionId, entity, localId)
```

Resolution order for an inbound vehicle: `ExternalRef.externalId` -> `Vehicle.gpsDeviceId` -> normalised registration (`Vehicle.registrationKey`, the same strip-spaces key already unique) -> else park the event in `UnmatchedEvent` (TTL 7 days, shown on the Connections screen with a "Match to a truck" action that creates the `ExternalRef`; a later event for it resolves, and parked ones can be replayed). Places: `ExternalRef` -> `place.code` echoed back in the vendor zone's name or external reference (we put the code in the vendor zone's name, e.g. `REF-NDL | Ndola refinery`, or its external-id field where one exists) -> unmatched (nearest place within its radius is only a SUGGESTION on the screen). Vendor ids returned by `push()` (`vendorRef`) are saved straight into `ExternalRef`. The Connections screen shows both directions: matched, unmatched trucks, trucks with no device id.

### 2.6 Configuration (never hard-coded)

Two layers, so changing vendor doesn't change business rules:

1. **Per connection** (`settings`, zod fields on the provider, drawn by `describeFields`): base URL, auth style, paths, which message types to send (toggles: trips, places, vehicle status), what personal data to include (driver name, driver phone default off), batch size, pull cursor, interval, `placeRoles` to push, geofence radius override, vendor's units.
2. **Per company policy** (new `fleetPolicy` section on the company record, shipped in the setup kit `src/modules/setup/kit.ts` with defaults so `COMPANY_CONFIG` can set it): the truck status rules (section 3), the status export map, the arrival/departure source priority and tolerance (section 4), position freshness thresholds, history retention, whether GPS events auto-apply or wait for confirmation, detention policies (section 4.3). The `tracking` company area (`src/modules/company/areaList.ts`) switches the whole thing on or off, using the existing `requireModule('tracking')` from `src/modules/operations/settings.ts`.

### 2.7 Pull API for the GPS side

Read-only, for platforms that prefer to fetch (or to resync). Mounted separately from the signed hooks and the staff API: `src/modules/fleet-exchange/pull.router.ts` at `/api/v1/exchange/v1/*`, not behind user login.

| Endpoint | Returns |
| --- | --- |
| `GET /trips?active=true&updatedSince=<iso>&cursor=` | `trip.upsert` payloads for active trips, paged, newest `updatedAt` last |
| `GET /trips/:tripNumber` | one trip |
| `GET /trucks?status=&updatedSince=` | `vehicle.upsert` + `vehicle.status` per truck, including last position and source |
| `GET /places?role=load,offload` | `place.upsert` payloads |
| `GET /snapshot` | everything above in one document (`sync.snapshot`) |
| `GET /health` | schema version, server time, counts |

Auth: `Authorization: Bearer <token>`. The token is NOT stored in the database (house rule). The connection holds `pullTokenEnv` (name of an env var / Secret Manager entry, same `SECRET_ENV` rule) and optionally `pullTokenNextEnv` so a token can be rotated without downtime (either is accepted; compared with `timingSafeEqual`). The caller is resolved to the one enabled `fleet-exchange` connection, so the connection's `enabled` flag, its "what to include" toggles (no driver phone unless on) and its `placeRoles` apply, and `lastUsedAt` is recorded. Safety: GET only (anything else 405), per-token rate limit (use whatever `src/middleware` already has; propose before adding a package), `ETag`/`If-None-Match` and `updatedSince` so polling is cheap, responses never include money, costs, driver pay or customer rates, a fixed `fields` allow-list, `Cache-Control: no-store`, and the audit log (`src/modules/audit`) records pulls as a counter, not one row each.

### 2.8 Signing, retries through the outbox, idempotency

**Outbound queue:** new collection `ExchangeOutbox` (`src/modules/fleet-exchange/models/outbox.model.ts`, collection `exchange_outbox`) copying `OutboundMessage`'s lifecycle: `status: queued|sending|sent|failed|simulated|skipped`, `attempts`, `nextAttemptAt`, `leaseUntil`, plus `connectionId`, `type`, `entityId`, `idempotencyKey` (unique per connection), `payload`, `vendorRef`. Differences:

- Coalescing: when a new `trip.upsert` is queued for a trip whose earlier `trip.upsert` is still `queued`, replace its payload (latest snapshot wins) instead of adding rows. `trip.cancel` is never coalesced away.
- Ordering: items of one entity are sent in order of `version`; a failed item blocks only its own entity (so a bad trip never stalls the others).
- Retry: reuse `RETRY_MINUTES` from `dispatcher.ts` (move to a small shared `src/core/retry.ts`); after the last, `failed`, shown on the Connections screen with "Retry" and "Retry all failed" buttons (same behaviour as `resend` for messages). A 410/404 for a deleted vendor object triggers a re-create once.
- Worker: `startExchangeWorker()` next to `startOutboxWorker()` in `src/server.ts`, and stopped on shutdown the same way. Claim with `findOneAndUpdate` + lease, exactly like `deliver()`, so two API instances don't double-send.
- A vendor outage never fails the action that caused it: producers call `enqueue()` inside the listener and swallow errors with a log, as `notify()` does.

**Producers (triggers):** one listener file `src/modules/fleet-exchange/triggers.ts` using `onEvent` for the trip events already in `EVENTS` (created, dispatched, arrived_*, loaded, delivered, closed, load_returned, ...), plus trip edits and cancellation (add a `trip.cancelled` and `trip.updated` event to `EVENTS` if missing, with a matching `EVENT_NAMES` entry and `areaOfEvent` mapping), vehicle `operationalStatus` change, place edit, and `VehicleState.status` change. Triggers only enqueue; building the payload happens when it is sent (so a snapshot is never stale).

**Idempotency**
- Outbound: `idempotencyKey = <entity>:<id>:v<version>:<type>`; trips already have `version` (`updateTripSchema` carries it); vehicles and places use `updatedAt` epoch. Replays are safe because the receiver upserts by `tripNumber` / `code`.
- Inbound: collection `ExchangeInboxLog` with a unique index `(connectionId, eventKey)` and a TTL (default 7 days), where `eventKey = event.id` if present, else `sha1(vehicle|type|at|place|lat|lng)`. A duplicate is counted and skipped; the response is still 200 (so vendors stop retrying). Out-of-order: positions older than `VehicleState.position.at` go to history only; a geofence `exit` whose `enter` was never seen is accepted (arrival time unknown, flagged); an `enter` after a later `exit` for the same visit is paired by time.
- Replay protection is the existing 5-minute signature window; the dedupe log covers legitimate re-sends.
- Response: `{ accepted, duplicate, unmatched, rejected }` counts (extends today's `{accepted, note}`).

### 2.9 Device failed: fallback to the driver's phone

Add `source: 'phone'` for positions. The driver app (`web/src/driver`, `web/src/phone`) gets an opt-in "Share my location while on a trip" using `navigator.geolocation` and a new authenticated `POST /api/v1/driver/trips/:id/location` (staff API, same auth as other driver routes, in `driverApp.service.ts`), sending lat/lng, accuracy, time (queue offline like `driver-app-offline.test.ts` does for other actions). Policy in `fleetPolicy.positionSources`: ordered list (default `['device','partner','phone']`), `staleAfterMinutes` (default 15) after which a lower source is used, and `phoneAllowedOnlyWhen` (`deviceStale` default, or `always`). Every position displayed carries its source ("Tracker", "Driver phone", "Simulated"), and `VehicleState.deviceOnline` is set false when the partner says offline or when no device position arrives for `staleAfterMinutes`.

---

## 3. Truck availability status model

### 3.1 Principle

One server-side function derives a status per vehicle from ERP data plus the latest position, with a configurable rule list. The browser does not re-derive it (today `web/src/domain/turn.ts` derives the NEXT STEP of a trip in the browser; this is about trucks, so it is served, not recomputed, so the map, the board, the exported status and the pull API always agree).

New module `src/modules/fleet-status/`: `derive.ts` (pure function, unit-testable with no database), `fleetstate.model.ts` (collection `vehicle_states`, one document per vehicle: `status`, `since`, `tripId`, `placeId`, `nextPlaceId`, `lat/lng` + GeoJSON `geo` (2dsphere), `position{at, source, speedKmh}`, `ignition`, `deviceOnline`, `metrics`, `reason`), `fleetstatus.service.ts` (recompute and list), router, controller.

Recompute is event-driven, not a loop: after any of trip created/updated/dispatched/stop arrival or departure/loaded/delivered/ended/cancelled, vehicle `operationalStatus` change, trailer pairing change, an inbound position or geofence event, and a slow safety sweep every few minutes (position gone stale, time-based statuses). Each recompute writes only on change and queues `vehicle.status` for the exchange when `status.key` changes.

### 3.2 Inputs

- `Vehicle.operationalStatus` (`in_workshop`, `breakdown`, `impounded`, `sold` stop a truck being available; `on_trip` is not trusted on its own, the active trip is) plus open maintenance work orders (`src/modules/maintenance`) when that module is on.
- The vehicle's active trip (unique partial index on `vehicleId, active`), its `stops[]` with `arrivedAt/leftAt`, its `events` (`dispatched`, `loaded`, `arrived_offloading`, `delivered`, `ended`), and its consignments' `delivered` flags.
- The latest position (lat/lng, age, speed, ignition) and the places' geofences.
- Base: `Vehicle.homeBranchId` and the branch's place, or the vehicle's last trip end place.
- Driver availability and trailer pairing, only for "nearest available" ranking.

### 3.3 Default list (a company can rename, reorder, disable, add)

Rules are evaluated in order, first match wins. Each rule has a `key`, a `label`, a colour token (a design token name, not a hex), `group`, `isAvailable` (counts as available for dispatch), `exportCode` and `when` (a list of predicates, all must be true).

| Key | Label | Computed as (defaults) | Available |
| --- | --- | --- | --- |
| `in_maintenance` | In maintenance | `operationalStatus` in (`in_workshop`, `breakdown`) OR open work order marked "truck down" | no |
| `unavailable` | Out of service | `impounded` or `sold` or inactive | no |
| `at_unloading` | At unloading | active trip, some `offload` stop has `arrivedAt` and no `leftAt` (GPS: inside that place's geofence) | no |
| `at_border` | At border | active trip, a `border` stop arrived and not left, OR inside a place of type `border` while the trip is loaded | no |
| `at_loading` | At loading | active trip, a `load` stop arrived and not left | no |
| `loaded_in_transit` | Loaded, in transit | active trip, event `loaded` recorded, not yet `delivered`, not in any stop's geofence | no |
| `empty_returning` | Empty returning | active trip, consignments all delivered (or event `delivered`) and trip not ended, moving away from the offload place; or no trip, last trip ended at a place that is not base, last 48 h (`returnWindowHours`) | soon (see below) |
| `en_route_to_load` | En route to load | active trip, dispatched, no `loaded` yet, a `load` stop ahead | no |
| `assigned` | Assigned | active trip, not dispatched yet | no |
| `available_returning` | Available, returning | no active trip, `operationalStatus` available, and the position is outside `nearOriginKm` of any base/loading place but heading back (previous trip ended, or distance to base decreasing), i.e. free but not yet home | yes |
| `available_near_origin` | Available near origin | no active trip, available, within `nearOriginKm` (default 50) of base or any `load`-role place | yes |
| `available_at_base` | Available at base | no active trip, available, inside the base place's geofence or position unknown but last trip ended at base | yes |
| `available_elsewhere` | Available (other place) | fall-through for no active trip, available, not matched above | yes |
| `unknown` | Position unknown | needed position and none within `staleAfterMinutes` | no (flagged) |

Also exposed: the "onward near destination" status the business uses is a REFINEMENT of `loaded_in_transit`: `loaded_near_destination` = `loaded_in_transit` and within `nearDestinationKm` (default 100) of the next `offload` stop (by straight line, or `distanceLeftKm` from the GPS side). It appears as a rule so the company can switch it on, name it, or merge it into `loaded_in_transit`. Nearly-available trucks (`empty_returning` heading to a base, or `loaded_near_destination` after offloading) are tagged `availableSoon` with an ETA (route distance via the `routing` connection's `RouteFinder`, or `straight line × roadDistanceFactor`, which is the fallback the company already uses; see `whenNone` for routing in `KIND_INFO`).

### 3.4 Configuration shape (company record `fleetPolicy.statuses`)

```jsonc
{ "statuses": [
  { "key": "available_near_origin", "label": "Available near origin", "colour": "status-ok", "isAvailable": true,
    "exportCode": "AVAIL_NEAR_ORIGIN", "enabled": true,
    "when": [ { "p": "noActiveTrip" }, { "p": "vehicleStatusIn", "v": ["available"] },
              { "p": "withinKmOf", "v": { "of": "loadPlaces", "km": 50 } }, { "p": "positionFresh" } ] }
 ],
 "thresholds": { "nearOriginKm": 50, "nearDestinationKm": 100, "staleAfterMinutes": 15, "returnWindowHours": 48, "atPlaceMeansInsideGeofence": true },
 "vendorMaps": { "<connectionId>": { "available_near_origin": "Available Near Origin" } } }
```

Predicates are a closed, whitelisted set implemented in `derive.ts` (no `eval`, no free-form scripting): `noActiveTrip`, `hasActiveTrip`, `tripEventSeen(name)`, `tripEventNotSeen(name)`, `atStopKind(kind, state: arrived|left)`, `insidePlaceType(types)`, `withinKmOf({ of: loadPlaces|offloadPlaces|base|nextStop|place:<code>, km })`, `vehicleStatusIn`, `workOrderOpen`, `positionFresh`, `speedAbove/Below`, `ignition`, `headingToward(base)`. Rules are validated by zod on save (`src/modules/company/*`), previewed live on screen ("these 3 trucks would be in this status"), and the defaults ship in the setup kit so a new company starts with a sensible list. A company adds a status ("Waiting for documents at border") by adding a rule from the same predicates. `exportCode` per status, and per connection `vendorMaps`, translate to what the dashboard calls it.

### 3.5 Edge cases decided

- Position gone: trucks keep the status the ERP data gives; the rules needing position fall to `unknown` only when they cannot be answered from ERP data alone.
- Multi-load trips (many consignments, loads at several places): `at_loading` is any load stop arrived and not left; `loaded_in_transit` means at least one consignment loaded and the truck is between stops. Splits at offload: after the last offload, `empty_returning`.
- Reload at the destination ("backload"): a new trip is created, the status moves to `assigned`/`at_loading` at once; the old trip's end does not matter.
- Trailer swap: status belongs to the vehicle (the trailer pairing is shown beside it).
- Simulator: when a vehicle's position source is `simulator`, its `VehicleState` carries `simulated: true` and everything shown or exported from it says so.

---

## 4. Demurrage / detention readiness

Goal now: capture trustworthy arrival and departure times at load and offload (and border) places, with their evidence, and make dwell time easy to read. Charging is billing's job later (`src/modules/finance/billing/`); we prepare the data, do not hard-code rates or free time.

### 4.1 Data

Keep the existing trip stop fields as the CONFIRMED times, and add evidence beside them (`trip.model.ts`, in `stopSchema`, optional, `strict: 'throw'` so each new field is declared):

```ts
visits: [{            // every raw observation, any source
  kind: 'arrive'|'depart', at: Date, source: 'gps'|'device'|'phone'|'driver'|'office'|'simulator',
  eventId?: string, connectionId?: ObjectId, accepted: boolean, note?: string
}],
dwell: { minutes, freeMinutes, excessMinutes, basis: 'gps'|'manual'|'mixed', status: 'open'|'confirmed'|'disputed' } // computed, cached
```

`arrivedAt`, `arrivedVia` and `leftAt` stay and remain what the rest of the code reads. `ARRIVAL_SOURCES` gets `'phone'` added. A GPS `enter` at a stop's place goes through the SAME `arriveAt()` (`trips.service.ts`) used by the driver and the office, with `via = 'gps'`, so announcements, stage events and the `arrivalRefusal` guards still apply: if the truck would pass a gate that is not yet satisfied (for example offloading before loading is recorded), the GPS event is kept as a visit with `accepted: false` and a note ("GPS saw the truck at X; waiting for loading to be recorded"), and the office sees it in the trip's queue.

Matching an event to a stop: the vehicle's active trip, then the first stop of that trip with that place and no `arrivedAt` (an `exit` closes the open visit of that place). Events with no active trip are kept as `VehicleState.visits` for the status board but change no trip.

### 4.2 Source priority and conflicts (company policy, defaults)

`fleetPolicy.visits`: `priority` (default `['gps','device','driver','office']`), `autoApplyGps` (default true), `toleranceMinutes` (default 15), `onConflict: 'prefer-priority' | 'flag'` (default flag). Behaviour: GPS time wins when present and accepted; a manual time that differs from GPS by more than the tolerance is accepted only with a reason, the trip is marked `disputed` for the detention review, and the audit log (`src/modules/audit`) records who changed what. Where no GPS exists, manual stays the only time. A GPS `exit` sets `leftAt`; if the exit is missing but the next stop is arrived, `leftAt` is estimated and marked "estimated" (never silently).

### 4.3 Detention policy master and readiness view

A new master `DetentionPolicy` (uses the masters engine `src/core/masters/*`, so custom fields and layouts come free): `appliesTo` (place type, place, customer, product), `stopKind` (load, offload, border), `clockStartsAt` (arrival | gate-in | loading-start), `clockStopsAt` (departure | loading-end), `freeMinutes`, `calendar` (24 h or working hours of the place: `Place.openingHours` exists but is a string, so a structured version is proposed), `rounding`, and an optional `ratePerHour` / `rateBasis` left empty until billing uses it. A read-only "Detention" tab on the trip and a report (`GET /api/v1/fleet/detention?from=&to=&customerId=&status=`) list: trip, vehicle, place, arrival (source), departure (source), dwell, free time, excess, status, and an export to CSV. Billing can later turn excess into a charge line; it reads `trip.stops[].dwell`, so no change to GPS code.

---

## 5. Overview map improvements

Today: `web/src/tracking/FleetMap.tsx` is a hand-drawn SVG of places with a truck dot per active trip placed by `positionAt(km)`; it can't show a truck that has no trip and can't show real GPS. `Tracking.tsx` already uses MapLibre with `https://tiles.openfreemap.org/styles/positron` (a dependency already in the app). Proposal:

1. **Data:** one query `GET /api/v1/fleet/overview` (TanStack Query, refetch every 30 s, no new library): per vehicle `{ id, registration, status key/label/colour, isAvailable, lat, lng, positionAt, source (device|phone|simulator), stale, tripNumber, from, to, nextPlace, etaMinutes, driverName }`. SSE push can come later if wanted (a proposal, not assumed).
2. **Map:** `FleetMap` switches to MapLibre (reuse the `tint`/style helpers from `Tracking.tsx`, extracted to `web/src/tracking/mapStyle.ts`), a GeoJSON source with a layer per status colour, clustering at low zoom, place geofences as circles (radius from `geofenceRadiusM`), routes of the selected trip, a stale-position marker style, and a "Simulated" label when any shown position is simulated. Keep the SVG map as the no-tiles fallback (offline or tiles blocked), since the SVG already works without a network.
3. **Truck-status board** (desktop first, a table, not cards-with-hover; follow `docs/ui-rules.md` and the UI taste memory: no pills, side stripes or icon tiles): a grouped table by status with counts at the head; columns registration, driver, trip, place/next place, since, distance to go/ETA, source. Click a row selects the truck on the map; the map click highlights the row. Counts per status are a one-line summary above the table, each a filter. Nothing from today's information is dropped: planned trucks (today shown as parked dots) appear as `assigned`.
4. **Nearest available trucks to a place:** a control "Trucks near [place]" (a place picker, default: the next loading place of an unassigned nomination): server `GET /api/v1/fleet/nearest?placeId=&limit=&types=` uses `$geoNear` on `VehicleState.geo` for `isAvailable` statuses (and `availableSoon` shown separately with ETA), filtered by compatibility (vehicle type, trailer type, capacity, product class when the company has set it), ranked by straight distance, then the top N re-ranked by road distance via the routing connection when configured (cached per pair). Result table: rank, truck, km away, ETA, status, driver, trailer, "Assign" (opens the existing trip-from-truck flow). Place not needed when the user clicks a point on the map.
5. **Filters** (kept in the URL and, per user, in `localStorage` with try/catch): status group, available only, vehicle type, trailer type, branch, customer, product, driver, "stale position", source, "on a trip for customer X". All filters apply to map, board and counts.
6. **Truck detail** panel: current status and why (the rule that matched and the facts it used, so staff can trust or correct it), last position and age, ignition, today's halts and idle, trip stops with arrived/left and the source of each time.

---

## 6. Simulated GPS partner (for development, demos and tests)

Real, not placebo: it exercises the real code paths and says it is simulated everywhere.

1. **Outbound side:** provider `fleet-exchange:simulated` (labelled Simulated on the Connections screen like every `simulated: true` provider). `push()` writes each message to a visible "Simulated partner inbox" (collection `simulated_partner_log`) and returns `{ ok: true, simulated: true }`. A screen lists what would have been sent, with the exact JSON and signature headers, which doubles as the payload preview for a real vendor's engineers. Outbox rows end `simulated` like `OUTBOX_STATUSES` already does.
2. **Inbound side:** `scripts/sim-gps-partner.ts` (and the same logic callable from tests): reads active trips from the pull API (so it tests the pull API too), "drives" each truck along its route (reusing the position maths in `web/src/domain/calc.ts` as shared pure functions, or a copy in `src/modules/fleet-exchange/simulate.ts`), and POSTS signed `position`, `geofence.enter/exit`, `halt` and `trip.metrics` events to `/api/v1/hooks/:id` with a real HMAC (`signBody`), with duplicates, out-of-order events and a device outage on request. Switch: `DRIVER_PHONE_SIMULATOR` already exists in `env.ts` as the guard for simulator positions; reuse it (`FLEET_SIMULATOR` only if needed, proposed).
3. Every position it makes has `source: 'simulator'`; the status engine marks it `simulated`; the map shows "Simulated" in the legend; nothing simulated is ever pushed to a real vendor or counted in the detention report (a `simulated` visit is accepted only when the installation is in demo mode).

---

## 7. Phasing: PR-sized steps

Branch per phase, PR into `develop`, tests in `tests/*.test.ts` (`tsx --test`, `tests/setup.ts` provides mongodb-memory-server) following the existing style (`tests/connections.test.ts`, `tests/arrival-order.test.ts`). Each phase works on its own and leaves the system shippable. Docs: update `docs/FEATURES.md` rows for #60 and add a short section in `README.md` (API behaviour).

| # | PR | Scope | Acceptance criteria | Tests |
| --- | --- | --- | --- | --- |
| 1 | Position store and vendor-neutral kind skeleton | Add kind `fleet-exchange` (+ `KIND_INFO`), `FleetExchangeClient` types, `VehicleState` model (latest position, `geo` index), `ExternalRef`, `ExchangeInboxLog` (dedupe, TTL), widen `InboundResult`. Wire the existing `gps` webhook/Traccar positions into `VehicleState` through `onInbound`. Add Place polygon geofence (optional `geofence`). | Existing `gps` webhook call updates the truck's latest position by plate or `gpsDeviceId`; a repeated event id changes nothing; an older timestamp doesn't overwrite a newer position; unmatched device is parked, not lost; nothing is stored that is secret. | position upsert and ordering; dedupe; id resolution order; unmatched list; connections test for new kind validation. |
| 2 | Simulated partner, outbound spine | `ExchangeOutbox` + worker + `simulated` provider + `marichi-json` envelope/signing; canonical payload builders for `trip.upsert/cancel/close`, `place.upsert`, `vehicle.upsert`; triggers on trip events; Connections screen shows outbox, "Resync", payload preview; simulated inbox screen. | Creating, dispatching, editing and cancelling a trip each produce exactly one coalesced queued message; vendor failure retries on `RETRY_MINUTES` and never fails the trip action; restart does not lose queued items; two workers never double-send; every screen row says Simulated. | payload shape snapshots (trip with 0, 1, many consignments; LR numbers), coalescing, lease/retry (fake clock), signature verifies with `verifySignature`, no secret in outbox row or error (`scrub`). |
| 3 | Inbound events and GPS arrival/departure | `src/modules/fleet-exchange/inbound.ts` consuming `geofence.enter/exit`, `ignition`, `odometer`, `halt`, `trip.metrics`, `device.status`; `visits[]` on stops; GPS time through `arriveAt`; source priority and conflict flag; `'phone'` source; `sim-gps-partner.ts` driving a trip end to end. | A simulated drive makes load/offload `arrivedAt/leftAt` with `arrivedVia: 'gps'` and the trip's stage events fire as with a manual arrival; an enter that would break the arrival order is kept as `accepted: false` and shown; manual time differing from GPS beyond tolerance needs a reason and flags the trip. | extend `arrival-order.test.ts` scenarios with gps; duplicate/out-of-order; exit without enter; wrong place for trip; no active trip. |
| 4 | Truck status engine | `src/modules/fleet-status/` (pure `derive.ts`, state, recompute triggers, API `GET /fleet/status`, `/fleet/nearest`), `fleetPolicy.statuses` + thresholds on the company record with defaults in the setup kit, validation and live preview endpoint; `vehicle.status` outbound. | Default list gives the expected status for each scenario in section 3.3; renaming, reordering, disabling or adding a status by configuration changes results with no code change; `vehicle.status` queued only on change; setup package includes the policy. | table-driven tests on `derive.ts` (every default status, stale position, multi-load, backload, maintenance); nearest-truck ordering and compatibility filter; setup kit round trip. |
| 5 | Pull API | `pull.router.ts`, token via env name (`pullTokenEnv`, `pullTokenNextEnv`), allow-listed fields, `updatedSince`, ETag, paging, rate limit, `/snapshot`. | 401 without/with wrong token; token rotates without downtime; GET only; no money or driver phone unless switched on; works only while the connection is enabled; the simulated partner reads trips through it. | auth cases, field allow-list snapshot, paging and `updatedSince`, rotation, disabled connection. |
| 6 | Generic adapters and security hardening | `generic-mapped` provider (templated outbound, mapped inbound), Standard-Webhooks-style header acceptance (`webhook-id`, `webhook-timestamp`, `webhook-signature`) as an option, `outboundSecretEnv`, `poll()` loop for pull vendors with stored cursor, Traccar geofence push and event forward. | A vendor with a flat REST API can be connected by configuration only; pull-style vendor cursor survives restart; secrets only by env name (the `SECRET_ENV` check applies). | mapping both directions with fixture payloads from each researched vendor, cursor persistence, signature variants. |
| 7 | Detention readiness | `DetentionPolicy` master, `stops[].dwell`, Detention tab and `/fleet/detention` report with CSV, dispute flow. | Dwell shows for every load/offload/border stop with the source of each time; free time and clock rules come from configuration; disputed rows are listed; no charges computed unless a rate is configured. | dwell maths (calendar, free time, rounding), GPS vs manual conflict, estimated exit. |
| 8 | Overview: status board, map, nearest, filters | MapLibre `FleetMap` with status layers and SVG fallback, board table, "trucks near a place", filters, truck detail, simulated label. | Desktop-first layout, nothing from today's Overview removed; every position shows its source and age; filters apply to map, board and counts; nearest list matches the API; works with no tiles. | web component tests as the repo does for desks; the nearest and filter logic as pure functions; manual check on screenshot at desktop width. |
| 9 | Driver phone fallback | `navigator.geolocation` opt-in in the driver app, location endpoint, offline queue, policy for when the phone position is used. | Phone position appears with source "Driver phone" only when the device is stale (default); off by default until the driver opts in. | endpoint auth, staleness switch-over, offline replay. |
| 10 | First real vendor adapter(s) | One file per chosen vendor (Wialon, Samsara, Geotab, Flespi, Traccar, ...) with its `capabilities`, mapping and docs; contract test against recorded fixtures. | The vendor's zones appear for our places; trip data reaches the dashboard; its events arrive; verified against the vendor's sandbox where one exists. | recorded-fixture contract tests; no live calls in CI. |

Suggested order: 1, 2, 3 (these make the simulated end-to-end loop), then 4 and 5 in parallel, 8 once 4 lands, 7, 9, and 6/10 as soon as a vendor is known.

---

## 8. Decisions that need a human's call

1. A new kind `fleet-exchange` beside `gps`, rather than widening `gps` (recommended, reasons in section 0). It adds a connection card for the company.
2. Whether GPS arrivals auto-apply to the trip (default yes, with the guard rules) or wait for confirmation. This is exposed as a setting; the default is a product call.
3. Whether trucks' status counts should include `empty_returning` in "available soon" by default.
4. New libraries: none proposed. MapLibre is already used. Server-side `$geoNear`, HMAC and `fetch` are already available; Wialon/Geotab/Samsara clients are plain `fetch`. Point-in-polygon for polygon geofences needs about 20 lines of our own code (we only need it for our own simulated tests, since the vendor reports enter/exit) and `$geoWithin` in MongoDB covers the server's own checks, so no geometry library is required.
5. Whether to rename the missing `src/modules/tracking` area: today it is code in `operations`; this design adds `src/modules/fleet-exchange` and `src/modules/fleet-status` and leaves `operations` alone, only reading and writing through `arriveAt()`.
6. Confirm each vendor's current API in its own docs when one is chosen; items marked unverified above came from search snippets or general knowledge, not from reading the vendor's reference.

## Sources consulted

- Wialon: https://sdk.wialon.com/wiki/en/pro/remoteapi/apiref/resource/update_zone , https://sdk.wialon.com/wiki/en/pro/remoteapi/apiref/resource/update_route , https://sdk.wialon.com/wiki/en/kit/remoteapi/apiref/order/route_update
- Samsara: https://developers.samsara.com/docs/webhooks , https://developers.samsara.com/docs/geofenceexit
- Geotab: https://developers.geotab.com/myGeotab/guides/dataFeed , https://developers.geotab.com/myGeotab/apiReference/methods/GetFeed/
- Flespi: https://flespi.com/kb/webhooks-actions-triggered-by-specific-events , https://flespi.com/kb/flespi-api-basics
- Traccar forum (event/position forwarding): https://traccar.org/forums/topic/how-to-forward-traccars-events-to-web-api
- LocoNav (API index), MiX Integrate: https://providers.apievangelist.com/providers/loconav/ , https://www.media.mixtelematics.com/downloads/uk/products/mix_integrate_international_online.pdf
