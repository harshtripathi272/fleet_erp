# Notes for AI assistants

Everything about this project is in [README.md](README.md): where things stand, the context behind decisions, setup, the console, how the API behaves, and the code layout. The next piece of work is [issue #2](https://github.com/harshtripathi272/fleet_erp/issues/2).

The founding principle, at the top of the README: each installation serves one company (not a multi-company system), and the codebase is a configurable base for selling to many transport companies that each work differently. Everything a company might do differently is configuration with sensible defaults, never a value fixed in code; a client's rules are that client's settings; setting up a new company should be easy without changing the core.

The README separates what is settled (the founding principle, the stack, how we work) from what is open (model grouping, screen layouts, UI guidance, code suggestions). Treat the open parts as current thinking, not a specification. When a task is not covered, or something looks wrong for the task, ask rather than assume. If a task seems to need a library, service or pattern outside the agreed stack, propose it first.

Before starting work, read [AGENTS.md](AGENTS.md) and run `scripts/inbox.sh <your-name>`. You work in your own git worktree on your own branch, open a pull request into `develop`, and the orchestrator reviews and merges it.
