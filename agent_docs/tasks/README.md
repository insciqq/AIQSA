# TASKS

This namespace contains all checkout-local task state:

- `queue/` is the executable task ledger for unfinished work.
- `drafts/` parks unfinished task files outside ledger selection, validation, and dependency resolution.
- `archive/` is the sole completion archive.

Task instances are ignored checkout-local state, never public Git or a cross-machine handoff. Each task owns its specification, plan, progress, decisions and verification. Tracked READMEs define the directory contract. Irreplaceable product commitments must also reach their durable owner.

## Queue And Selection

1. Reconcile existing `in_progress` tasks in `queue/` before claiming new work.
2. For sequential work, select the first `ready` task in natural filename order within the operator-selected queue; the default queue contains only files directly in `queue/`.
3. For a requested parallel wave, select up to five dependency-free `ready` queue tasks with non-overlapping expected write sets and stateful checks.
4. Never start `backlog` or `blocked` work implicitly, and never enumerate or select `drafts/`.

The queue statuses are:

- `backlog`: useful work retained in the ledger, but not yet ready for autonomous execution.
- `ready`: self-contained and dependency-free.
- `in_progress`: claimed by an integrating agent or one of its isolated worktree workers; multiple tasks may be active.
- `blocked`: cannot proceed; `Blocked by` must state the exact condition.

There is no human-review or `done` status in the queue. `node scripts/task-ledger.mjs complete <task>` moves a verified local task to `archive/` with `Status: completed` and removes its stem from remaining queue dependency fields. Never force-add a task instance; only the task-namespace README files are tracked.

Named queues use one lowercase kebab-case subdirectory, `queue/<group>/`. They require explicit operator scope and `--group <name>` for creation, listing and lifecycle commands; ordinary `list` and selection exclude them. `list --all` is an inspection view, not permission to execute another group. `check` validates every group, and task stems/dependencies remain globally unique. Parking, restoration and completion preserve the group under `drafts/` and `archive/`; completion clears dependency references across queues. Group README files, like tasks, are ignored private state. Nested groups and symlinks are unsupported.

## Parking In Drafts

Use `Status: backlog` when a task should stay visible to ledger validation and dependency resolution but must not start automatically. Use `drafts/` when the operator wants the task excluded from the ledger entirely.

`node scripts/task-ledger.mjs park <task>` preserves the file and its status while moving it from `queue/` to `drafts/`. It refuses to hide an `in_progress` task or a task still required by another queued task; park dependents first. `node scripts/task-ledger.mjs restore <task>` moves it back only when the resulting queue is valid. Restore prerequisites before their dependents. Prefer these commands to manual moves because they prevent overwrites and broken queue dependencies.

Drafts are neither listed nor content-validated and cannot satisfy dependencies. Restored `ready` tasks become selectable within their queue.

## Task Shape

`node scripts/task-ledger.mjs new` is the sole executable scaffold source. Each task has the metadata fields `Status`, `Depends on`, `Blocked by`, and `Durable rationale`, followed by `Goal`, `Context`, `Scope`, `Out Of Scope`, `Acceptance Criteria`, `Plan`, `Progress`, `Decisions`, and `Verification`. Replace every scaffold placeholder before promotion; use exact task stems in `Depends on` and `none` when no open dependency remains.

Discover current behavior from the checkout's code, schemas, migrations, and tests. In tasks, link the relevant executable owners and durable constraints, then describe only the intended delta; do not create an implementation mirror in `agent_docs`. For complex work, make `Plan`, `Progress`, and `Decisions` detailed enough that a fresh agent can continue from the task and current checkout alone.

Task-local decisions remain inspectable in the local completion archive, but they are not durable or recoverable from public Git history. Any non-derivable rule or rationale that future work still needs must be incorporated into the appropriate `agent_docs` boundary and attested through `Durable rationale` before completion.

## Commands

```bash
npm run task:check
node scripts/task-ledger.mjs new <slug> --summary "<one-line outcome>"
node scripts/task-ledger.mjs promote <task-id-or-stem>
node scripts/task-ledger.mjs start <task-id-or-stem>
node scripts/task-ledger.mjs block <task-id-or-stem> --reason "<specific blocker>"
node scripts/task-ledger.mjs park <task-id-or-stem>
node scripts/task-ledger.mjs restore <task-id-or-stem>
node scripts/task-ledger.mjs complete <task-id-or-stem>
node scripts/task-ledger.mjs list
node scripts/task-ledger.mjs new <slug> --summary "<outcome>" --group <name>
node scripts/task-ledger.mjs list --group <name>
node scripts/task-ledger.mjs list --all
```

`task:check` validates queue/archive privacy, structure, statuses and dependencies independently of documentation checks. `new` creates `backlog`; `promote` requires a complete specification without open dependencies; `start` claims ready work; `block` records an unavailable condition. `park`/`restore` preserve status; `complete` requires settled rationale and verification.

Task filenames use a 17-digit local timestamp including milliseconds followed by a lowercase kebab-case slug, for example `20260801143025123-search-quota-guard.md`. CLI allocation prevents identifier reuse across the queue, drafts, and completion archive without a separate sequence ledger.

Before completion, `Plan` has no unchecked items, `Progress` and `Decisions` no longer contain their scaffolds, and `Verification` contains checked evidence or `Not run: <check> — <specific reason>` with no unchecked items. `Decisions: - None.` is valid. Unavailable-only evidence cannot complete a task; record the unavailable condition with `block` or add passed evidence. `Durable rationale: pending` also blocks completion; use `none` or `moved to agent_docs/<owner>.md`. Completion archives the task and clears its stem from remaining `Depends on` fields.

## Completion Archive

`archive/` is excluded from selection and dependencies; its size never blocks validation or completion. `complete` only adds evidence, never deletes or overwrites it. Cleanup requires an explicit operator request naming its scope. Archives remain private local state, never publication artifacts or durable contracts.

## Parallel Ownership

Only the integrating agent writes task state. It may claim five independent tasks with isolated workers; metadata stays in the primary checkout. Workers return changes and evidence; the integrator owns conflicts, combined verification, final inspection and completion.
