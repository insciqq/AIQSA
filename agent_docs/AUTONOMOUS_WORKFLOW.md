# AUTONOMOUS_WORKFLOW

This is the operating loop for broad autonomous selection, queued/task-state work, dependencies, multi-session work, and review-required changes. Named same-session review-optional work follows `AGENTS.md` without loading this document.

## Work Selection

The operator's latest request is primary. Before implementation, classify every change under the authoritative [Human Review Policy](../AGENTS.md#human-review-policy). A concrete same-session review-optional change runs directly without a task. Review-required work creates or uses a task even when it can finish in the current session. For broad implementation permission, queued work, dependencies, or work that may survive the session:

1. Inspect Git state and the relevant code and living documents.
2. Enumerate `agent_docs/tasks/*.md` in natural filename order.
3. Resume the sole `in_progress` task. If none exists, select the first `ready` task with no open dependencies.
4. Do not implement `backlog`, `blocked`, or `review` tasks without the transition or human input their status requires.
5. Create a task when human review is required, work must survive the current session, or work belongs in the autonomous queue.
6. Keep one Markdown writer in the checkout. Parallel agents may inspect or implement bounded code slices, but the root agent owns local task state and integration.

## Task Operation

The [task queue manual](tasks/README.md) owns statuses, dependencies, commands, task shape, evidence gates, and completion deletion; `scripts/task-ledger.mjs` enforces them. For complex or multi-session work, expand the selected task's `Plan`, `Progress`, and `Decisions`. The task is the executable plan and handoff artifact; do not create a parallel plan file or completed-plan archive.

## Human Review Handoff

The root [Human Review Policy](../AGENTS.md#human-review-policy) is the sole classification list. Every matching change must reach `in_progress` before implementation and `review` after implementation and verification; delete it with `complete --approved` only after explicit operator acceptance. A product decision needed before implementation is a blocker, not an end-of-task review: record it in `Blocked by` and obtain the decision first. Routine verified implementation remains review-optional and may use the direct same-session path.

## Execution Loop

1. Read only the subject documents routed by `AGENTS.md` and the code being changed.
2. Start the selected task and record a concrete first checkpoint in `Progress`.
3. Implement the smallest coherent vertical slice.
4. Add the cheapest deterministic test that would fail for the regression.
5. Update `Progress` after meaningful checkpoints and record only task-local choices in `Decisions`.
6. Run focused checks while iterating. Near completion, run the proportional hermetic or container-parity lane from `TESTING.md`; run E2E, runtime image builds, migrations, security audit, or provider smokes only when the task crosses those boundaries.
7. Update the owning living document only when the change modifies a durable product contract, invariant, architecture/data boundary, configuration/environment contract, operator workflow, security boundary, or verification policy. A bug fix or implementation change that restores or preserves an already documented contract does not require a documentation edit. Put durable rationale beside the current rule.
8. Record exact passed checks and unavailable checks with reasons in `Verification`, and settle `Durable rationale` as `none` or `moved to <agent_docs owner>`.
9. Move required-review work to `review`; otherwise run `complete` and delete the task.

## Verification Policy

- Use `npm run check:hermetic` for deterministic host-local static/unit completion and `docker-compose.dev.yml` for container parity or integration; never point either lane at the default persistent installation.
- Prefer focused Vitest files while implementing.
- Run `npm run check:container` near completion only when the change needs PostgreSQL, container/process topology, or another integration boundary.
- Run destructive local Playwright only for browser/server workflows or an explicit task requirement.
- Development-stack data is disposable. Checks and E2E may mutate or reset only the `aiqsa-dev` database and object bucket.
- Parallel stateful/container checks are unsupported. Hermetic focused files may run independently only when they do not share generated-output writes.
- Provider smokes remain small, explicit, and conditional on operator-provided keys.

Exact commands and test selection live in `agent_docs/TESTING.md`. Security-sensitive installation boundaries remain owned by `SECURITY.md`; the lean development workflow does not weaken auth, tenancy, migrations, backup, persistence, or deployment requirements.

## Autonomy Boundaries

The agent may choose implementation names, conservative UI details, focused test granularity, and small sequencing decisions. Stop for missing secrets, paid or large provider calls outside the approved smoke policy, destructive operations not requested by the operator, an unavailable required external service, or a product decision not covered by current contracts.

## Final Task-Owned Review

Before review or completion, perform the root [Before Final Response](../AGENTS.md#before-final-response) checklist. Compare final status with the initial state; run unstaged and staged whitespace checks; inspect the complete task-owned `HEAD` diff and every new untracked task-owned file. Reject unrelated edits, secrets/private values, artifacts, generated drift, or unjustified contract/documentation changes, and distinguish preserved user changes in the task evidence and operator report.

## Done Standard

Work is complete only when the requested outcome is implemented, relevant checks pass or an unavailable check is named with a reason, required living documents are current, final task-owned review is clean, and the app remains runnable or clearly verifiable. Prefer one commit per completed queued task with subject `<task-id>: outcome in one line`.

## Operator Report

Report the outcome, material decisions, exact checks run, relevant checks not run, and the distinction between task-owned and pre-existing user changes. Continue only when broad implementation was requested and the next task is concrete and unblocked.
