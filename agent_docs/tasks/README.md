# TASKS

This directory contains unfinished work only. Task instances are ignored local checkout state because the repository remote is public. A task file is the single artifact for its specification, implementation plan, inter-session progress, task-local decisions, and verification plan.

This queue is intentionally checkout-local. It is not a durable roadmap or a cross-machine/worktree handoff, so irreplaceable product commitments must not exist only here.

## Selection

1. Reconcile existing `in_progress` tasks before claiming new work.
2. For sequential work, select the first `ready` task in natural filename order unless the operator named another scope.
3. For a requested parallel wave, select up to five dependency-free `ready` tasks with non-overlapping expected write sets and stateful checks.
4. Never start `backlog` or `blocked` work implicitly.

## Statuses

- `backlog`: useful work, but not yet ready for autonomous execution.
- `ready`: self-contained and dependency-free.
- `in_progress`: claimed by an integrating agent or one of its isolated worktree workers; multiple tasks may be active.
- `blocked`: cannot proceed; `Blocked by` must state the exact condition.

There is no human-review or `done` status. `node scripts/task-ledger.mjs complete <task>` deletes a verified local task and removes its stem from remaining dependency fields. Never force-add a task instance; this README is the only tracked file in this directory.

## Task Shape

`node scripts/task-ledger.mjs new` is the sole executable scaffold source. Each task has the metadata fields `Status`, `Depends on`, `Blocked by`, and `Durable rationale`, followed by `Goal`, `Context`, `Scope`, `Out Of Scope`, `Acceptance Criteria`, `Plan`, `Progress`, `Decisions`, and `Verification`. Replace every scaffold placeholder before promotion; use exact task stems in `Depends on` and `none` when no open dependency remains.

Keep current behavior in the owning living document rather than copying it into tasks. Link the relevant owners and describe only the delta. For complex work, make `Plan`, `Progress`, and `Decisions` detailed enough that a fresh agent can continue from the task and current checkout alone.

Task-local decisions disappear when the task completes and are not recoverable from public Git history. Any rationale that future work still needs must be incorporated into the owning current contract and attested through `Durable rationale` before completion.

## Commands

```bash
node scripts/task-ledger.mjs new <slug> --summary "<one-line outcome>"
node scripts/task-ledger.mjs promote <task-id-or-stem>
node scripts/task-ledger.mjs start <task-id-or-stem>
node scripts/task-ledger.mjs block <task-id-or-stem> --reason "<specific blocker>"
node scripts/task-ledger.mjs complete <task-id-or-stem>
node scripts/task-ledger.mjs list
```

`new` creates an ignored local `backlog` scaffold. `promote` requires a complete executable specification and no open dependencies. `start` claims one ready task and permits other tasks to remain `in_progress`. `block` records the exact unavailable condition. `complete` requires settled durable rationale and completed verification.

Task filenames use a 17-digit local timestamp including milliseconds followed by a lowercase kebab-case slug, for example `20260801143025123-search-quota-guard.md`. This avoids a separate sequence ledger after completed tasks are deleted.

Before completion, `Plan` has no unchecked items, `Progress` and `Decisions` no longer contain their scaffolds, and `Verification` contains checked evidence or `Not run: <check> — <specific reason>` with no unchecked items. `Decisions: - None.` is valid. Unavailable-only evidence cannot complete a task; record the unavailable condition with `block` or add passed evidence. `Durable rationale: pending` also blocks completion; use `none` or `moved to agent_docs/<owner>.md`. Completion deletes the task instead of archiving it and clears its stem from remaining `Depends on` fields.

## Parallel Ownership

The integrating agent is the only task-file writer. It may claim up to five independent tasks and assign one isolated worker per task while keeping metadata in the primary checkout. Each worker returns inspectable changes and verification evidence; the integrating agent owns conflicts, combined verification, automated final inspection, and completion.
