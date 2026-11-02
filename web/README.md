# Marichi Fleet trip desk

A browser mock of one trip, end to end: plan the truck, fund it, load, drive, offload, close and settle the driver. Four desks share one set of records: Operations, Finance, Owner and Driver.

```sh
cd trip-flow
npm install
npm run dev        # http://localhost:5173
npm test
npm run build
```

## Running the demo

Open the app in several tabs. Each tab picks a desk and keeps it; the records stay in step across tabs through `localStorage` and `BroadcastChannel`. To open a desk directly, use a link:

- `/?desk=operations`
- `/?desk=finance`
- `/?desk=owner`
- `/?desk=driver&driver=D1` (Joseph Mwansa; D2 to D11 for the others)

**Reset demo** in the sidebar restores the seeded fleet. The seed contains a settled trip, an ended trip awaiting settlement, a truck at the Beira terminal waiting for the loading invoice, a copper run on the road to Dar es Salaam, funding waiting with Finance, a planned trip and a delivery note to check. It also contains two customer nominations.

## The flow

Every trip shows one next step and names whose turn it is. The desk whose turn it is sees a single button for it; the other desks see who they are waiting on and can send a reminder.

1. **Plan.** Operations starts from a truck. The truck's trailer, driver and location fill in, and a route template or stop editor sets the road distances.
2. **Funding.** The route sets a fuel and cash budget. The suggested request is the budget minus fuel already in the tank and cash the driver already holds. Finance approves and pays, and a request above the suggestion also goes to the Owner. Every approval can happen in the desk's WhatsApp.
3. **Loading.** The driver sends a photo of the loading invoice. Operations checks the reading, and fuel cargo is corrected to 20 °C from temperature and density.
4. **Transit.** Dispatch and follow the truck on the map, with a simulated drive and dashcam. Stops are stamped as the truck passes them.
5. **Offloading.** The driver sends the delivery note. The shortage beyond the product's allowance is priced and Finance charges or waives it.
6. **Close.** Operations records the fuel left and frees the truck. Receipts sent on the way go to Finance.
7. **Settle.** Finance settles a driver periodically across closed trips from **Driver accounts** and prints a statement. Every trip also prints a one-page trip sheet.

The WhatsApp phones, document reading, GPS, road camera and payments are simulations. Road distances and shapes come from OpenStreetMap routing (OSRM), fetched once into `src/domain/geo-data.ts`. The map uses OpenFreeMap tiles.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the model and the rules.

## Configuration prototype

Pick **Owner → Configuration** (under **More** on narrow screens). Create a master or add fields to an existing one, test a sample form, and review/publish. **Masters** then renders the published fields and columns. Custom records can be edited, archived/restored and exported to CSV. Configuration packages can be exported/imported from **Publish & history**.

The demo has one local company workspace. Country/currency preferences are formatting previews; current trip and settlement calculations still use ZMW/USD. Configurable trip stages, approval policies, tax, transaction fields and production tenant isolation remain open work. See the [meeting interpretation, research and full configuration inventory](../reference/planning/configuration-architecture.md).
