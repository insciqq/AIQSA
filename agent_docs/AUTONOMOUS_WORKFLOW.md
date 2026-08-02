# AUTONOMOUS_WORKFLOW

This is the operating loop for an agent changing AIQSA without step-by-step steering.

## Work Selection

The operator's latest request is primary. Before implementation, classify every change under the Human Review Policy below. A concrete review-optional change that can be completed in the current session runs directly without a ceremonial task. A review-required change creates or uses a task before implementation even when it is expected to finish in the current session. For broad implementation permission, queued work, dependencies, or work that may survive the session:

1. Inspect Git state and the relevant code and living documents.
2. Enumerate `agent_docs/tasks/*.md` in natural filename order.
3. Resume the sole `in_progress` task. If none exists, select the first `ready` task with no open dependencies.
4. Do not implement `backlog`, `blocked`, or `review` tasks without the transition or human input their status requires.
5. Create a task when human review is required, work must survive the current session, or work belongs in the autonomous queue.
6. Keep one Markdown writer in the checkout. Parallel agents may inspect or implement bounded code slices, but the root agent owns local task state and integration.

## Task Lifecycle

All unfinished work lives in one directory. `Status` is the only lifecycle source of truth:

```text
backlog -> ready -> in_progress -> review
              \          |
               -> blocked
```

- `backlog`: captured work that is not yet executable.
- `ready`: self-contained scope, acceptance criteria, plan, and verification plan; no open task dependencies.
- `in_progress`: the single task owned by the integrating agent.
- `blocked`: progress requires a named dependency, external condition, secret, or human decision.
- `review`: implementation and verification are complete, but required human review has not yet been accepted.

There is no completed status. Task instances are ignored local checkout state because the publication target is public. Completion deletes the task file and removes its stem from `Depends on` fields in the remaining queue. Tests, living documents, code commits, and release notes are the durable record; new task content under this workflow never enters Git history, and established public refs are not rewritten as routine task cleanup.

Use the task CLI directly so the workflow does not depend on optional package aliases:

```bash
node scripts/task-ledger.mjs new <slug> --summary "<one-line outcome>"
node scripts/task-ledger.mjs promote <task-id-or-stem>
node scripts/task-ledger.mjs start <task-id-or-stem>
node scripts/task-ledger.mjs block <task-id-or-stem> --reason "<specific blocker>"
node scripts/task-ledger.mjs review <task-id-or-stem>
node scripts/task-ledger.mjs complete <task-id-or-stem> [--approved]
node scripts/task-ledger.mjs list
```

`new` creates an ignored local `backlog` scaffold. `promote` requires an executable specification and no open dependencies. `start` enforces one integrating task. `review` requires settled durable rationale and completed verification. `complete` requires the same evidence; a task marked `Human review: required` must pass through `review` and uses `--approved` only after explicit operator acceptance. Verification containing only concrete `Not run` evidence always follows that reviewed path.

For complex or multi-session work, expand the selected task's `Plan`, `Progress`, and `Decisions` sections. The task itself is the executable plan and handoff artifact; do not create a parallel plan file or a completed-plan archive.

## Human Review Policy

This is the authoritative review-boundary list for every change. Use `Human review: required` for a change that affects:

- `CRITICAL_INVARIANTS.md`;
- security, privacy, secrets, authentication, tenancy, retention, or public-sharing boundaries;
- persistent schema/migrations or destructive data behavior;
- public API or stored-data compatibility;
- release or publication safeguards;
- a user-visible product contract not already decided by current living documents; or
- completion supported only by unavailable verification.

Every matching change must create or use a task and reach `in_progress` before implementation, including work expected to finish in one session. After implementation and verification, move it to `review`; delete it with `complete --approved` only after explicit operator acceptance. An unresolved product decision needed before implementation is a blocker, not an end-of-task review: record it in `Blocked by` and obtain the decision first. Routine implementation and refactoring with available verification remain review-optional and may use the direct same-session path.

## Execution Loop

1. Read only the subject documents routed by `AGENTS.md` and the code being changed.
2. Start the selected task and record a concrete first checkpoint in `Progress`.
3. Implement the smallest coherent vertical slice.
4. Add the cheapest deterministic test that would fail for the regression.
5. Update `Progress` after meaningful checkpoints and record only task-local choices in `Decisions`.
6. Run focused checks while iterating. Near completion, run the proportional hermetic or container-parity lane from `TESTING.md`; run E2E, runtime image builds, migrations, security audit, or provider smokes only when the task crosses those boundaries.
7. Update the owning living documents when architecture, environment, workflow, tests, security, or product behavior changed. Put rationale beside a current rule only when it remains useful after the task is deleted.
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

## Done Standard

Work is complete only when the requested outcome is implemented, relevant checks pass or an unavailable check is named with a reason, living documents are current, no secrets are added, and the app remains runnable or clearly verifiable. Prefer one commit per completed queued task with subject `<task-id>: outcome in one line`.

## Operator Report

Report the outcome, material autonomous decisions, exact checks that ran, and relevant checks that did not run. Continue to another task only when broad implementation was requested and the next task is concrete and unblocked.
