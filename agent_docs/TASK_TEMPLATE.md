# TASK_TEMPLATE

Create a task with `npm run task:new -- <slug> --summary "<summary>"`, replace every placeholder, then activate it with `npm run task:promote -- <task>`. Use a full task stem in `Depends on`; use `none` when there is no dependency.

Keep task specs short. Put durable current behavior in the owning living document, not in the task.

```md
# <task-id>-short-task-title

Status: backlog | ready | pending | blocked
Depends on: <full-task-stem> or none

## Goal

The observable outcome.

## Scope

- Included work.

## Out Of Scope

- Explicit exclusion.

## Acceptance Criteria

- Observable result.

## Tests

- Focused command or scenario.
- `npm run check:hermetic` near completion for deterministic static/unit work.
- `npm run check:container` when the scope crosses PostgreSQL, container/process, or integration boundaries.

## Done Notes

Fill this in with the outcome and checks before `task:complete`.
```
