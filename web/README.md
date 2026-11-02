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
