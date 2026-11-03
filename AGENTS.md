# How we work: people and coding agents

Several coding agents, and people, work on this repository at once, sometimes two on the same computer and under the same GitHub account. This page is the contract that keeps them out of each other's way. Read it at the start of every session; it is short on purpose.

The **orchestrator** (today: `lakshya-desktop`) creates and assigns issues, reviews every pull request, merges, and keeps `develop` green. **Lakshya** decides product questions and approves releases to `main`.

## 1. Who you are

Every agent has a fixed name. Use it everywhere, because the GitHub account does not say who you are.

| Name | Who runs it | Folder (git worktree) | API port | Web port | Database |
| --- | --- | --- | --- | --- | --- |
| `lakshya-desktop` | Claude desktop app, Lakshya's MacBook Air | `../fleet_erp-lakshya-desktop` | 3010 | 5110 | `fleet_erp_lakshya_desktop` |
| `lakshya-t3` | T3, Lakshya's MacBook Air | `../fleet_erp-lakshya-t3` | 3020 | 5120 | `fleet_erp_lakshya_t3` |
| `harsh-desktop` | Claude desktop app, Harsh's laptop | `../fleet_erp-harsh-desktop` | 3030 | 5130 | `fleet_erp_harsh_desktop` |
| `harsh-t3` | T3, Harsh's laptop | `../fleet_erp-harsh-t3` | 3040 | 5140 | `fleet_erp_harsh_t3` |

A new agent or person: the orchestrator adds a row before you start.

Your name appears on:

- **issues and pull requests:** the label `agent:<name>`;
- **branches:** `<name>/<issue>-<short-slug>`, e.g. `harsh-t3/19-message-channels`;
- **commits:** a last line `Agent: <name>`;
- **comments:** they start with `[<name>]`. To address someone, write `@<name>` (e.g. `@harsh-t3`); the inbox picks it up.

## 2. Your own folder, ports and database

Two agents on one computer never share a folder. Each works in its own [git worktree](https://git-scm.com/docs/git-worktree), so nobody's files, branch or uncommitted work is touched by anyone else:

```bash
# once, from the main clone
git fetch origin
git worktree add ../fleet_erp-<name> -b <name>/<issue>-<slug> origin/develop
cd ../fleet_erp-<name> && npm ci && (cd web && npm ci)
```

Run servers on your own ports and database from the table:

```bash
PORT=<api port> MONGODB_URI=mongodb://127.0.0.1:27017/<database> npm run dev
cd web && API_URL=http://127.0.0.1:<api port> npm run dev -- --port <web port>
```

Never stop another agent's servers or drop another agent's database.

## 3. Your inbox: run it first, and after every push

```bash
scripts/inbox.sh <name>
```

It reads GitHub and prints what is yours: issues assigned to you, your pull requests with their CI result and review state, and comments that mention you since you last ran it. This is how agents with no memory of earlier sessions pick up correctly. Act on it in this order: **changes requested on your PR → red CI on your PR → your `in progress` issue → a new `ready` issue.**

## 4. The flow: issue → branch → pull request → review → merge

1. **Issues.** The orchestrator writes them with the issue form: goal, acceptance criteria, area, out of scope, decisions needed. Status labels:

   | Label | Meaning |
   | --- | --- |
   | `status: ready` | Fully written, nobody on it |
   | `status: in progress` | An agent is on it (its `agent:` label says who) |
   | `status: in review` | Its pull request is ready for review |
   | `status: blocked` | Waiting on something else; the issue says what |
   | `status: needs decision` | A question for Lakshya, also listed in the pinned **Decisions for Lakshya** issue |

   Area labels say which part of the code an issue touches. Two agents are never given issues in the same area at the same time:

   | Label | Code |
   | --- | --- |
   | `area: operations` | `src/modules/operations/*`: trips, money requests, cargo, expenses, settlements |
   | `area: web desks` | `web/src/desks/*`, `web/src/domain/*`, `web/src/docs/*`, `web/src/tracking/*`, `web/src/phone/*` |
   | `area: masters` | `src/core/masters/*`, `src/modules/{configuration,users,roles,auth,meta,company}/*`, `web/src/masters/*` |
   | `area: finance` | `src/modules/finance/*`: currencies, exchange rates, payment methods |
   | `area: messaging` | `src/modules/messaging/*`, `src/core/mail/*`, `src/core/sms/*`, `web/src/settings/*` |
   | `area: driver app` | `src/modules/operations/driverApp*`, `web/src/driver/*` |
   | `area: deploy` | `Dockerfile`, `deploy/*`, `docs/*`, `.env.example` |
   | `area: tooling` | `.github/*`, `scripts/*`, `AGENTS.md` |

   Shared files (`web/src/api/*`, `web/src/ui/*`, `web/src/styles/*`, `src/app.ts`, `package.json`) may be touched by any issue in small, focused changes; say so in the PR.

2. **Taking work.** Work on what the orchestrator assigned you (`agent:<name>` + `status: in progress`). With nothing assigned, take the oldest `status: ready` issue in an area nobody else is in: add your `agent:` label, switch it to `status: in progress`, and comment `[<name>] Taking this` with a three-line plan.

3. **Branch.** One issue, one branch, from the latest `develop`: `<name>/<issue>-<slug>`. Commit small and often; push your branch whenever you like (it touches nobody else).

4. **Pull request into `develop`, opened early as a draft.** Fill in the template: `Closes #<issue>`, what changed, how you tested it. CI runs on every push to it. Keep it to one issue; split anything bigger.

5. **Ready for review** when CI is green and the acceptance criteria are met: mark the PR ready, switch the issue to `status: in review`. Don't review anyone else's PR unless the orchestrator asks.

6. **Review and merge (orchestrator only).** The orchestrator reviews with GitHub's review (Approve, or Request changes with comments on the lines). On changes requested, fix and push to the same branch. Approved and green → squash-merged into `develop`, the branch deleted, and the issue closed by the orchestrator with the PR's number. (GitHub closes issues from `Closes #…` only on merges into `main`, the default branch, so the orchestrator does it for `develop`.)

7. **Keeping up.** If `develop` moved, merge it into your branch (`git fetch && git merge origin/develop`) and resolve conflicts yourself before asking for review.

## 5. Tests: the gate

- `npm run check` (type-check, every test, the API build, the web build) passes locally before you mark a PR ready.
- CI (`.github/workflows/check.yml`) runs the same check on every pull request and on every merge into `develop` and `main`. A run's summary page shows the test counts and the failing tests; the full log is attached as `test-log`.
- The run on `develop` after each merge is the **integration test**: everything merged so far, together. If it goes red, nothing else is merged until it is green again, and fixing it is the next job of whoever merged last.
- New behaviour comes with a test (`tests/*.test.ts`). A bug fix comes with the test that would have caught it.
- Screen changes: say in the PR what you checked in the browser and as which role; add a screenshot.

## 6. Talking to each other

- About a piece of work: on its issue or pull request, `[<name>] @<other> …`. Never in side channels; the next agent can't see those.
- The pinned **Agent room** issue is the status board the orchestrator keeps. Post there only when blocked.
- Questions for Lakshya go on the issue with `status: needs decision`; the orchestrator lists them in **Decisions for Lakshya**. Meanwhile build the current behaviour as a setting with a sensible default and carry on with the rest. Never hard-code a client's rule (see the founding principle in the README).

## 7. Running out of time or usage

Push your branch, leave the PR as a draft, and comment on it `[<name>] Handoff:` with what is done, what is left and anything surprising. Switch the issue back to `status: ready` and remove your `agent:` label. Whoever picks it up continues on the same branch.

## 8. Releases

`develop` → `main` goes through one pull request that only Lakshya approves. Nothing reaches `main` any other way.

## Done means

The acceptance criteria are met, CI is green, the orchestrator approved and merged it into `develop`, and closed the issue.
