# The test copy on Render (#139)

One copy of Marichi Fleet that everyone can open and try: every desk, a made-up company, the simulated driver
phone, and a Reset button. It runs from the `develop` branch and updates itself when work merges.

**Cost:** about US$7 a month (Render Starter) plus US$0.25 for a 1 GB disk. The database is MongoDB Atlas's free M0.
**Time:** about 20 minutes.

## 1. The database (MongoDB Atlas, free)

1. Sign in at <https://cloud.mongodb.com> and create a **free M0** cluster. A region near Frankfurt is best.
2. **Database Access** → add a user with a password, with "Read and write to any database".
3. **Network Access** → add `0.0.0.0/0`. Render's Starter plan has no fixed address, so Atlas has to accept any.
   The user and password are what protect the database.
4. **Connect → Drivers** → copy the connection string. Put the password in, and add the database name before the
   `?`, like this: `mongodb+srv://fleet:PASSWORD@cluster0.xxxxx.mongodb.net/fleet?retryWrites=true&w=majority`.

## 2. The app (Render)

1. Sign in at <https://render.com> with the GitHub account that can read this repository.
2. **New → Blueprint** → choose this repository and the `develop` branch, which holds `render.yaml`. Render reads `render.yaml` and shows one web service,
   `marichi-fleet-test`, with a 1 GB disk.
3. Render asks for three values:

   | Setting | What to put |
   |---|---|
   | `MONGODB_URI` | The Atlas string from step 1.4 |
   | `OWNER_EMAIL` | The e-mail address you'll sign in with as the Owner |
   | `OWNER_PASSWORD` | Your Owner password: at least 8 characters, with a letter and a digit |

4. **Apply.** The first build takes about 5 minutes. When it says **Live**, open the address Render gives
   (`https://marichi-fleet-test.onrender.com` or similar).

Keys and passwords go only into Render and Atlas, never into chat or GitHub. `JWT_SECRET` is made by Render.

## 3. The made-up company and its sign-ins

1. Sign in with `OWNER_EMAIL` and `OWNER_PASSWORD`. The app asks you to choose a new password straight away. That's the one you keep, and `OWNER_PASSWORD` is never read again.
2. Go to **Masters → This installation → Reset this demonstration** and press **Reset**. The first time there's no company yet, so the box stays empty. From then on, type the company's name to confirm.
   It loads the made-up haulier (trucks, drivers, customers, routes, rate contracts) and shows **a sign-in for each
   desk**: Operations, Finance, Viewer and a driver. Each password is shown **once**, so copy them.
3. Give the tester those sign-ins. Reset again whenever you want a clean start; it hands out new passwords.

## 4. Optional: real e-mail

The copy starts with e-mail **simulated**: messages appear in the app's message log, marked "simulated". To send real
e-mail, add a mail service in **Masters → Sending messages → Connections** (Resend, SendGrid, Mailgun or any mail
server). No change on Render is needed. Sending to any inbox needs a domain you own, with the records the service asks for.

## What the settings in render.yaml do

| Setting | Why |
|---|---|
| `COPY_PURPOSE=demo`, `DEMO_IN_PRODUCTION=true` | A demonstration copy: made-up data that can be reset. To onboard a real company instead, set `COPY_PURPOSE=trial` and remove `DEMO_IN_PRODUCTION`. |
| `DRIVER_PHONE_SIMULATOR=true` | Staff can act as a driver's WhatsApp, labelled "simulated". It's allowed on a demo or trial copy only. |
| `FILE_STORAGE_DIR=/data/files` | Uploaded photos and papers live on the disk, so they survive restarts and deploys. |
| `TRUST_PROXY=1` | Render's proxy sits in front of the app. Sign-in limits count the real visitor. |
| `CONSOLE_ENABLED=false` | The developers' API console is off on a copy people use. |

The public address comes from Render (`RENDER_EXTERNAL_URL`). Set `APP_URL` only for your own domain.

## When something is wrong

- **The deploy fails at start:** Render → the service → **Logs**. A missing or wrong setting is named in the first lines.
- **"MongoServerSelectionError":** Atlas Network Access doesn't include `0.0.0.0/0`, or the password in the string is wrong.
- **Forgot the Owner password:** add `OWNER_PASSWORD_RESET` with a new password in Render → Environment, and save.
  The service restarts, and the Owner signs in with it and must change it.
