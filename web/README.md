# Marichi Fleet web app

The desks (Owner, Operations, Finance) and the driver's phone, running against the API in this repository. Sign-in, masters, trips, money requests, documents, loading and delivery, settlement and messages all come from the API; nothing is kept in the browser except the session.

## Run it

Start MongoDB and the API first (see the main [README](../README.md)), then in this folder:

```sh
npm install
npm run dev        # http://localhost:5173
```

Vite forwards `/api` to the API on `http://127.0.0.1:3000` (set `API_URL` to point elsewhere), so no CORS set-up is needed.

To have something to show, load the sample data into the API's database (`npm run seed` in the main folder), then **Create an account** on the sign-in page: the first account on a fresh database becomes the Owner. Add more people with their own roles (for example Finance and Operations) under **Masters → Users**.

Notes:
- Each person sees the desks their permissions allow. Approvals follow the company's approval policies, so a request waits for the role or person the policy names.
- The session is kept per browser. To act as two people at once, use a second browser or a private window.
- The driver's phone (WhatsApp simulation) is on the desk picker. It is switched off when the API runs in production.
- On an existing database, money requests, expenses and settlement appear once `finance` is switched on in the company's modules.

## Build

```sh
npm run build      # type-check and build to dist/
```

## The flow

Every trip shows one next step and names whose turn it is. The trip's type decides its stages (`trip-stages` in Masters).

1. **Plan.** Operations starts from a truck, or converts an accepted nomination. The truck's trailer, driver and place fill in, and a route or the stop editor sets the road distances.
2. **Funding.** The route's budget sets the fuel and cash. The suggestion is the budget minus fuel in the tank and cash the driver already holds. Requests go through the company's approval policies, level by level; each level can approve in the app or from WhatsApp.
3. **Loading.** The driver sends a photo of the loading invoice, or Operations enters it. Fuel cargo is corrected to 20 °C from temperature and density.
4. **Transit.** Dispatch and follow the truck on the map. Stops are stamped as the truck passes them, or marked by hand.
5. **Offloading.** The delivery note gives the delivered volume; the shortage beyond the shortage policy's allowance is priced, and Finance charges or waives it.
6. **Close.** Operations records the fuel left and frees the truck. Receipts sent on the way go to Finance.
7. **Settle.** Finance settles a driver across closed trips from **Driver accounts** and prints a statement. Every trip also prints a one-page trip sheet.

Document reading, GPS positions, the road camera and the phones are still simulations; the records they produce are real API records.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for how the code is organised.
