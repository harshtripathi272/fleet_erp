# Notes for AI assistants

[docs/PROJECT-CONTEXT.md](docs/PROJECT-CONTEXT.md) explains what this project is, what has been decided so far and why. Use it as background, not as a specification: it records the current thinking, and parts of it are open for discussion. When a task is not covered there, or something in it looks wrong for the task, ask rather than assume.

Setup is in the README and [docs/SETUP-WINDOWS.md](docs/SETUP-WINDOWS.md); how the API behaves for a frontend is in [docs/FRONTEND.md](docs/FRONTEND.md).

Things the team has agreed and would want to be asked about before changing:

- The stack (listed in the context doc). If a task seems to need a library, service or pattern outside it, propose it and explain why.
- Changes go on a branch and into a pull request, not straight to `main`.
- `npm run check` passes before pushing.
