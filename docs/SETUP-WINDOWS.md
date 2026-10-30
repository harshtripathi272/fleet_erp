# Setting up on Windows

This gets the backend, its database and the console running on a Windows 10 or 11 laptop, without anything from another machine. It takes about 20 minutes, most of it downloads.

There are two ways to run MongoDB. Pick one:

- **A. Install MongoDB on Windows** (recommended). Nothing else to learn; MongoDB starts with Windows.
- **B. Docker Desktop.** One command runs the API, MongoDB and Redis together. Needs Docker Desktop and WSL 2.

Commands below are for **PowerShell**. Open it from the Start menu ("Windows PowerShell" or "Terminal").

## 1. Install the tools

Run these one at a time. `winget` comes with Windows 10 (since 2021) and Windows 11.

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
```

For option A, also install MongoDB and its desktop viewer, Compass:

```powershell
winget install --id MongoDB.Server -e
winget install --id MongoDB.Compass.Full -e
```

If `winget` is missing or refuses, download the installers instead: [Git](https://git-scm.com/download/win), [Node.js LTS](https://nodejs.org/en/download), [MongoDB Community Server](https://www.mongodb.com/try/download/community) (keep **Install MongoDB as a Service** ticked, and tick **Install MongoDB Compass**).

**Close PowerShell and open a new one**, so it sees the new programs. Then check:

```powershell
git --version
node --version
npm --version
```

Node must be **22 or newer**.

If `npm` says *running scripts is disabled on this system*, allow scripts for your own user once, then open a new PowerShell:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

## 2. Get the code

There are two repositories, both private. Ask Lakshya to add your GitHub account to each (**Settings → Collaborators → Add people**):

| Repository | What it holds |
| --- | --- |
| [harshtripathi272/fleet_erp](https://github.com/harshtripathi272/fleet_erp) | The backend API: this guide sets it up |
| [laksh-ya/fleet-erp](https://github.com/laksh-ya/fleet-erp) | The frontend mock in `trip-flow/`, and the client's material in `reference/` |

```powershell
cd $HOME\Documents
git clone https://github.com/harshtripathi272/fleet_erp.git
git clone https://github.com/laksh-ya/fleet-erp.git
cd fleet_erp
```

Git asks you to sign in to GitHub in a browser the first time. The two folder names differ only by `_` and `-`: `fleet_erp` is the backend, `fleet-erp` the mock.

To run the mock on its own (it keeps demo data in the browser and does not need the API yet):

```powershell
cd $HOME\Documents\fleet-erp\trip-flow
npm install
npm run dev
```

## 3. Install and configure

```powershell
npm ci
Copy-Item .env.example .env
```

`npm ci` installs the exact package versions in `package-lock.json`. The `.env` file holds local settings and is never committed. The defaults work as they are for local development. Two lines you may want to change in `.env`:

| Setting | Change it when |
| --- | --- |
| `EXPOSE_RESET_TOKEN=true` | You want to try "Forgot password" without e-mail. The reset token comes back in the API response (development only). |
| `CORS_ORIGINS=http://localhost:5173` | A React app calls the API directly from the browser. Not needed if the app uses the Vite proxy in [the frontend guide](FRONTEND.md). |

## 4. Start MongoDB

**Option A (installed):** it is already running as a Windows service. To check, open **Services** from the Start menu and look for **MongoDB Server** with status *Running*. If it is stopped, start it there, or in an administrator PowerShell:

```powershell
net start MongoDB
```

**Option B (Docker):** install [Docker Desktop](https://www.docker.com/products/docker-desktop/), start it once, then either run only the database and keep using `npm run dev`:

```powershell
docker compose up -d mongo
```

or run everything, API included (then skip step 6):

```powershell
docker compose up --build
```

Either way, MongoDB listens on `mongodb://127.0.0.1:27017`. Do not run options A and B at the same time; both want port 27017.

## 5. Load the sample data (optional)

```powershell
npm run seed
```

This loads a small, made-up Zambia–Tanzania–DRC fuel and copper operation (vehicles, trailers, drivers, customers, routes and so on), created through the same validation as the API. The README lists [what is in it](../README.md#sample-data). You can also load it later from the console.

## 6. Run the API

```powershell
npm run dev
```

Leave this window open. It restarts by itself when you save a file. When it prints `API test console available`, open:

- **http://127.0.0.1:3000/console/** for the models reference and the API test console.
- **http://127.0.0.1:3000/api/v1/health** for a quick health check.

In the console, **Test the API → Create account**. On a fresh database the **first account becomes the Owner** and can do everything. Accounts created after that get the read-only Viewer role.

## 7. Look at the data

Open **MongoDB Compass → Add new connection**, keep `mongodb://localhost:27017`, and **Connect** (no login). The `fleet_erp` database has one collection per model.

## 8. Run the checks

```powershell
npm run check
```

Type-checks, runs all the tests and builds. The tests use their own temporary MongoDB, not your `fleet_erp` database. The first run downloads that test MongoDB (about 100 MB), so it needs internet once.

## Everyday commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs the API on port 3000 and restarts on save |
| `npm run seed` | Loads the sample data into the database in `MONGODB_URI` |
| `npm test` | Runs the tests |
| `npm run check` | Type-check, tests and production build; run before every push |
| `git pull` | Gets the latest changes |

## When something goes wrong

| What you see | What to do |
| --- | --- |
| `MongooseServerSelectionError` or `ECONNREFUSED 127.0.0.1:27017` | MongoDB is not running. Start it (step 4). |
| `EADDRINUSE` on port 3000 | Another `npm run dev` is still running. Close that window, or set `PORT=3001` in `.env`. |
| `running scripts is disabled on this system` | Run the `Set-ExecutionPolicy` line in step 1. |
| `'node' is not recognized` | Open a new PowerShell after installing Node. |
| Sign-up says the account is a Viewer | Someone already created the first account in this database. Sign in as that owner, or start over (below). |
| The browser blocks requests from your React app (CORS) | Use the Vite proxy in [the frontend guide](FRONTEND.md), or set `CORS_ORIGINS` in `.env` and restart. |

To start over with an empty database, open Compass, delete the `fleet_erp` database, then run `npm run seed` again if you want the sample data.
