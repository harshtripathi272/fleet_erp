# Notes for AI assistants

Read [docs/PROJECT-CONTEXT.md](docs/PROJECT-CONTEXT.md) first: the agreed stack, how we work, the owner's decisions and the UI guidance. Setup is in [docs/SETUP-WINDOWS.md](docs/SETUP-WINDOWS.md) and the README; the API contract for the frontend is in [docs/FRONTEND.md](docs/FRONTEND.md).

- Use only the agreed stack. Ask before adding a library, service or pattern outside it.
- Keep a traditional MERN setup: standalone MongoDB, no transactions; Models → Route → Controller → Service.
- Never push to `main`; work on a branch and open a pull request.
- Run `npm run check` before pushing.
