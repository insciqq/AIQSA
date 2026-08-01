# TASKS

This directory contains unfinished work only. Task instances are ignored local checkout state because the repository remote is public. A task file is the single artifact for its specification, implementation plan, inter-session progress, task-local decisions, and verification plan.

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

There is no `done` status or completed-task directory. `node scripts/task-ledger.mjs complete <task>` deletes the verified local task and removes its stem from remaining dependency fields. Never force-add a task instance; only this README and `agent_docs/TASK_TEMPLATE.md` are tracked.

## Task Shape

Use `agent_docs/TASK_TEMPLATE.md`. Keep current system behavior in the owning living document rather than copying it into tasks. Link the relevant owners and describe only the delta. For complex work, make `Plan`, `Progress`, and `Decisions` detailed enough that a fresh agent can continue from the task and current checkout alone.

Task-local decisions disappear when the task completes and are not recoverable from public Git history. Any rationale that future work still needs must be incorporated into the owning current contract and attested through `Durable rationale` before review or completion.

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

Task filenames use a 17-digit local timestamp including milliseconds followed by a lowercase kebab-case slug, for example `20260801143025123-search-quota-guard.md`. This avoids a separate sequence ledger after completed tasks are deleted.

`Verification` must contain checked evidence or `Not run: <check> — <specific reason>` with no unchecked items before review/completion. Unavailable-only evidence requires `Human review: required`, `review`, and `complete --approved`. `Durable rationale: pending` also blocks review/completion; use `none` or `moved to agent_docs/<owner>.md`.
