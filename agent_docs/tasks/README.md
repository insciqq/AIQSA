# TASKS

This directory contains unfinished work only. Task instances are ignored local checkout state because the repository remote is public. A task file is the single artifact for its specification, implementation plan, inter-session progress, task-local decisions, and verification plan.

This queue is intentionally checkout-local. It is not a durable roadmap or a cross-machine/worktree handoff, so irreplaceable product commitments must not exist only here.

## Selection

1. Resume the sole `in_progress` task.
2. Otherwise select the first `ready` task in natural filename order unless the operator named another scope.
3. Never start `backlog`, `blocked`, or `review` work implicitly.

## Statuses

- `backlog`: useful work, but not yet ready for autonomous execution.
- `ready`: self-contained and dependency-free.
- `in_progress`: currently owned by the integrating agent; at most one is allowed.
- `blocked`: cannot proceed; `Blocked by` must state the exact condition.
- `review`: implemented and verified; required human review remains.

There is no `done` status or completed-task directory. `node scripts/task-ledger.mjs complete <task>` deletes the verified local task and removes its stem from remaining dependency fields. Never force-add a task instance; this README is the only tracked file in this directory.

## Task Shape

`node scripts/task-ledger.mjs new` is the sole executable scaffold source. Each task has the metadata fields `Status`, `Depends on`, `Human review`, `Blocked by`, and `Durable rationale`, followed by `Goal`, `Context`, `Scope`, `Out Of Scope`, `Acceptance Criteria`, `Plan`, `Progress`, `Decisions`, and `Verification`. Replace every scaffold placeholder before promotion; use exact task stems in `Depends on` and `none` when no open dependency remains.

Keep current behavior in the owning living document rather than copying it into tasks. Link the relevant owners and describe only the delta. For complex work, make `Plan`, `Progress`, and `Decisions` detailed enough that a fresh agent can continue from the task and current checkout alone.

Task-local decisions disappear when the task completes and are not recoverable from public Git history. Any rationale that future work still needs must be incorporated into the owning current contract and attested through `Durable rationale` before review or completion.

## Human Review

The authoritative classification and boundary list live in the root [Human Review Policy](../../AGENTS.md#human-review-policy). Any review-required change uses a task before implementation and completes only through `review` plus explicit operator acceptance; this queue does not maintain a second copy.

## Commands

```bash
node scripts/task-ledger.mjs new <slug> --summary "<one-line outcome>"
node scripts/task-ledger.mjs promote <task-id-or-stem>
node scripts/task-ledger.mjs start <task-id-or-stem>
node scripts/task-ledger.mjs block <task-id-or-stem> --reason "<specific blocker>"
node scripts/task-ledger.mjs review <task-id-or-stem>
node scripts/task-ledger.mjs complete <task-id-or-stem> [--approved]
node scripts/task-ledger.mjs list
```

`new` creates an ignored local `backlog` scaffold. `promote` requires a complete executable specification and no open dependencies. `start` enforces one integrating task. `block` records the exact unavailable condition. `review` and `complete` require settled durable rationale and completed verification; review-required work must pass through `review`, and `--approved` is valid only after explicit operator acceptance.

Task filenames use a 17-digit local timestamp including milliseconds followed by a lowercase kebab-case slug, for example `20260801143025123-search-quota-guard.md`. This avoids a separate sequence ledger after completed tasks are deleted.

Before review/completion, `Plan` has no unchecked items, `Progress` and `Decisions` no longer contain their scaffolds, and `Verification` contains checked evidence or `Not run: <check> — <specific reason>` with no unchecked items. `Decisions: - None.` is valid. Unavailable-only evidence requires `Human review: required`, `review`, and `complete --approved`. `Durable rationale: pending` also blocks review/completion; use `none` or `moved to agent_docs/<owner>.md`. Completion deletes the task instead of archiving it and clears its stem from remaining `Depends on` fields.
