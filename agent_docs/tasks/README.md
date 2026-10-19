---
paths:
  - "agent_docs/tasks/**"
  - "scripts/task-ledger.mjs"
---
# Tasks

The task ledger holds queued, multi-session and parallel work. Same-session work needs no task. `scripts/task-ledger.mjs` creates, validates and moves tasks; use it instead of moving files by hand, and run `npm run task:check` after every change.

- `queue/` holds unfinished work, `drafts/` parks files outside selection and validation, and `archive/` is the only completion record.
- Task files are private checkout-local state. Only the README files in these directories are tracked; never force-add a task, and never treat tasks as public documentation or a cross-machine handoff.

## Statuses and selection

- `backlog`: kept in the ledger but not ready to start. `ready`: self-contained, no open dependencies. `in_progress`: claimed (several may be active). `blocked`: `Blocked by` states the exact condition. There is no review or "done" status: completion moves the task to `archive/`.
- Reconcile existing `in_progress` tasks before claiming new ones.
- Work sequentially through the first `ready` task in natural filename order of the selected queue. The default queue is the files directly in `queue/`. A named queue (`queue/<group>/`) needs explicit operator scope and `--group <name>` on every command; `list --all` is for looking, not permission to run another group.
- For a requested parallel wave, take up to five dependency-free `ready` tasks whose expected write sets, shared schema or generated files, and stateful checks do not overlap.
- Never start `backlog` or `blocked` work implicitly, and never select from `drafts/`.

## Working a task

1. Inspect Git state, the operator's scope, the relevant code and the area documents named in the root `AGENTS.md`.
2. Claim the task with `start` before implementing. Record the verification scope you intend to use (`agent_docs/TESTING.md`), then implement the smallest complete slice.
3. Keep progress, decisions, exact evidence and blockers in the task. For complex work, make `Plan`, `Progress` and `Decisions` detailed enough that a fresh agent can continue from the task and the checkout alone.
4. Do the root final review, then `complete` the verified task yourself. If required evidence is unavailable, `block` the task with the exact condition instead.
5. Continue with another task only under broad implementation permission and only if one is concrete and unblocked.

## Parallel work

One integrating agent owns the ledger, conflicts, review and the combined verification. Workers get bounded specifications and disjoint write scopes, run focused checks only, and never edit the ledger. Inspect every worker's result and full diff, resolve conflicts against both contracts without dropping unrelated work, add a regression where the interaction warrants one, and rerun the affected checks after integrating. Failed integration is not completion. Stateful and container checks stay serialized.

## Task shape

`node scripts/task-ledger.mjs new <slug> --summary "<outcome>"` creates the only valid scaffold: metadata `Status`, `Depends on`, `Blocked by`, `Durable rationale`, then `Goal`, `Context`, `Scope`, `Out Of Scope`, `Acceptance Criteria`, `Plan`, `Progress`, `Decisions`, `Verification`. Replace every placeholder before `promote`; use exact task stems in `Depends on`, or `none`.

In `Context`, link the code and documents that matter and describe only the intended change; current behavior lives in the code.

`Durable rationale` is `none` for almost every task. Use `moved to agent_docs/<FILE>.md` only when the task produced something future work needs and the code cannot show: an operator decision, an accepted risk, or an invariant with its reason. Write it into that document under the rules in the root `AGENTS.md` ("Writing agent docs"); a description of the new feature does not belong there.

Before `complete`: `Plan` has no unchecked items, `Progress` and `Decisions` have no scaffold text (`- None.` is fine), `Verification` lists checked evidence or `Not run: <check> — <reason>`, and `Durable rationale` is no longer `pending`. Unavailable-only evidence cannot complete a task.

## Drafts and archive

- `park` moves a task to `drafts/` keeping its status; it refuses an `in_progress` task or one another queued task depends on. `restore` moves it back only if the queue stays valid. Drafts are not listed, validated or usable as dependencies. Use `backlog` instead when the task should stay visible to validation and dependencies.
- `complete` archives with `Status: completed` and removes the stem from other tasks' `Depends on`. The archive only grows: never prune or overwrite it automatically; cleanup needs an explicit operator request naming its scope.

## Commands

```bash
npm run task:check
node scripts/task-ledger.mjs new <slug> --summary "<one-line outcome>" [--group <name>]
node scripts/task-ledger.mjs promote|start|park|restore|complete <task-id-or-stem>
node scripts/task-ledger.mjs block <task-id-or-stem> --reason "<specific blocker>"
node scripts/task-ledger.mjs list [--group <name> | --all]
```

Task filenames are a 17-digit local timestamp with milliseconds and a kebab-case slug, for example `queue/20260801143025123-search-quota-guard.md`; the CLI allocates them and prevents reuse.
