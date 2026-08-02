# TASK_TEMPLATE

Create a task with:

```bash
node scripts/task-ledger.mjs new <slug> --summary "<one-line observable outcome>"
```

Replace every scaffold placeholder before promotion. Use exact task stems in `Depends on`; use `none` when there is no open dependency. A task with open dependencies cannot be `ready`, `in_progress`, or `review`.

Keep the task focused on the intended delta. Link current owner documents and code paths instead of restating their contracts. For a complex or multi-session change, this same file is the execution plan and handoff log.

The authoritative classification and review-boundary list live in the [Human Review Policy](AUTONOMOUS_WORKFLOW.md#human-review-policy). Set `Human review` from that policy before promotion. A review-required change must create or use its task before implementation and finish through `review` plus explicit `complete --approved` acceptance; do not duplicate the boundary list here.

```md
# <YYYYMMDDHHMMSSmmm>-short-task-title

Status: backlog
Depends on: none
Human review: optional | required
Blocked by: none
Durable rationale: pending

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

Before review or completion, close every `Plan` checkbox, replace `Progress: - Not started.`, and replace `Decisions: - None yet.` with the actual task record (`- None.` is valid when no task-local decision was needed). Replace every planned verification checkbox with a checked result or `- Not run: <check> — <specific reason>`. Evidence containing only `Not run` entries requires `Human review: required`, the `review` status, and explicit operator acceptance.

Set `Durable rationale` to `none` when no task-local decision must survive. Otherwise use `moved to agent_docs/<owner>.md` after incorporating the lasting reason beside the current rule. `pending` blocks review and completion; owner paths must exist and cannot point into `agent_docs/tasks/`.

A task marked `Human review: required` must move to `review` after verification and is deleted only after the operator accepts it:

```bash
node scripts/task-ledger.mjs complete <task> --approved
```
