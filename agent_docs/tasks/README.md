# TASKS

This namespace contains all checkout-local task state:

- `queue/` is the executable task ledger for unfinished work.
- `drafts/` parks unfinished task files outside ledger selection, validation, and dependency resolution.
- `archive/` is the sole completion archive.

Task instances in all three directories are ignored local state because the repository remote is public. A task file is the single artifact for its specification, implementation plan, inter-session progress, task-local decisions, and verification plan. The tracked README files define the directory contract and are not task instances.

This state is intentionally checkout-local. It is not a durable roadmap or a cross-machine/worktree handoff, so irreplaceable product commitments must not exist only here.

## Queue And Selection

1. Reconcile existing `in_progress` tasks in `queue/` before claiming new work.
2. For sequential work, select the first `ready` queue task in natural filename order unless the operator named another scope.
3. For a requested parallel wave, select up to five dependency-free `ready` queue tasks with non-overlapping expected write sets and stateful checks.
4. Never start `backlog` or `blocked` work implicitly, and never enumerate or select `drafts/`.

The queue statuses are:

- `backlog`: useful work retained in the ledger, but not yet ready for autonomous execution.
- `ready`: self-contained and dependency-free.
- `in_progress`: claimed by an integrating agent or one of its isolated worktree workers; multiple tasks may be active.
- `blocked`: cannot proceed; `Blocked by` must state the exact condition.

There is no human-review or `done` status in the queue. `node scripts/task-ledger.mjs complete <task>` moves a verified local task to `archive/` with `Status: completed` and removes its stem from remaining queue dependency fields. Never force-add a task instance; only the task-namespace README files are tracked.

## Parking In Drafts

Use `Status: backlog` when a task should stay visible to ledger validation and dependency resolution but must not start automatically. Use `drafts/` when the operator wants the task excluded from the ledger entirely.

`node scripts/task-ledger.mjs park <task>` preserves the file and its status while moving it from `queue/` to `drafts/`. It refuses to hide an `in_progress` task or a task still required by another queued task; park dependents first. `node scripts/task-ledger.mjs restore <task>` moves it back only when the resulting queue is valid. Restore prerequisites before their dependents. Prefer these commands to manual moves because they prevent overwrites and broken queue dependencies.

Draft files are not listed, selected, content-validated, or accepted as dependency targets. A restored `ready` task is immediately eligible for normal selection.

## Task Shape

`node scripts/task-ledger.mjs new` is the sole executable scaffold source. Each task has the metadata fields `Status`, `Depends on`, `Blocked by`, and `Durable rationale`, followed by `Goal`, `Context`, `Scope`, `Out Of Scope`, `Acceptance Criteria`, `Plan`, `Progress`, `Decisions`, and `Verification`. Replace every scaffold placeholder before promotion; use exact task stems in `Depends on` and `none` when no open dependency remains.

Keep current behavior in the owning living document rather than copying it into tasks. Link the relevant owners and describe only the delta. For complex work, make `Plan`, `Progress`, and `Decisions` detailed enough that a fresh agent can continue from the task and current checkout alone.

Task-local decisions remain inspectable in the local completion archive, but they are not durable or recoverable from public Git history. Any rationale that future work still needs must be incorporated into the owning current contract and attested through `Durable rationale` before completion.

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
```

`task:check` explicitly validates current queue/archive privacy, structure, statuses, and dependencies; documentation checks do not inspect local task state. `new` creates an ignored local queue task with `Status: backlog`. `promote` requires a complete executable specification and no open dependencies. `start` claims one ready task and permits other tasks to remain `in_progress`. `block` records the exact unavailable condition. `park` and `restore` cross the queue/draft boundary without changing status. `complete` requires settled durable rationale and completed verification.

Task filenames use a 17-digit local timestamp including milliseconds followed by a lowercase kebab-case slug, for example `20260801143025123-search-quota-guard.md`. CLI allocation prevents identifier reuse across the queue, drafts, and completion archive without a separate sequence ledger.

Before completion, `Plan` has no unchecked items, `Progress` and `Decisions` no longer contain their scaffolds, and `Verification` contains checked evidence or `Not run: <check> — <specific reason>` with no unchecked items. `Decisions: - None.` is valid. Unavailable-only evidence cannot complete a task; record the unavailable condition with `block` or add passed evidence. `Durable rationale: pending` also blocks completion; use `none` or `moved to agent_docs/<owner>.md`. Completion archives the task and clears its stem from remaining `Depends on` fields.

## Completion Archive

`archive/` retains completed task files and does not participate in queue selection or dependency resolution. Its size never blocks ledger validation or task completion. `complete` only adds the newly completed task: it never deletes, rotates, or overwrites archived evidence. Cleanup happens only after an explicit operator request and removes only the files the operator selected. Archived task files remain ignored local state and must not be staged, committed, shipped, or treated as a durable contract.

## Parallel Ownership

The integrating agent is the only queue task-file writer. It may claim up to five independent tasks and assign one isolated worker per task while keeping metadata in the primary checkout. Each worker returns inspectable changes and verification evidence; the integrating agent owns conflicts, combined verification, automated final inspection, and completion.
