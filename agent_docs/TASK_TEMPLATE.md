# TASK_TEMPLATE

Create a task with:

```bash
node scripts/task-ledger.mjs new <slug> --summary "<one-line observable outcome>"
```

Replace every scaffold placeholder before promotion. Use exact task stems in `Depends on`; use `none` when there is no open dependency. A task with open dependencies cannot be `ready`, `in_progress`, or `review`.

Keep the task focused on the intended delta. Link current owner documents and code paths instead of restating their contracts. For a complex or multi-session change, this same file is the execution plan and handoff log.

```md
# <YYYYMMDDHHMMSSmmm>-short-task-title

Status: backlog
Depends on: none
Human review: optional | required
Blocked by: none

## Goal

The observable outcome.

## Context

- Current owner documents and relevant code paths.
- Why this change is needed now.

## Scope

- Included work.

## Out Of Scope

- Explicit exclusions.

## Acceptance Criteria

- Observable behavior or invariant.

## Plan

- [ ] Concrete implementation milestone.
- [ ] Documentation and verification milestone.

## Progress

- Not started.

## Decisions

- None yet. Record only choices needed to continue this task and their rationale.

## Verification

- [ ] `exact focused command or scenario`
- [ ] `npm run check:hermetic`
- [ ] `npm run check:container` when the scope crosses PostgreSQL, container/process, or integration boundaries.
```

Before completion, replace planned verification checkboxes with checked results. An unavailable relevant check may be recorded as `- Not run: <check> — <specific reason>`. A task marked `Human review: required` must move to `review` after verification and is deleted only after the operator accepts it.
