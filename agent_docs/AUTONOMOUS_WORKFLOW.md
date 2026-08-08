# AUTONOMOUS_WORKFLOW

This is the operating loop for broad autonomous selection, queued/task-state work, dependencies, parallel task waves, and multi-session work. Named same-session work follows `AGENTS.md` without loading this document.

## Work Selection

The operator's latest request is primary. A concrete same-session change may run directly. Create a task when work must survive the current session or belongs in the autonomous queue. For broad implementation permission, queued work, dependencies, or parallel execution:

1. Inspect Git state and the relevant code and living documents.
2. Enumerate `agent_docs/tasks/*.md` in natural filename order and reconcile every existing `in_progress` task before claiming more work.
3. Select `ready` tasks with no open dependencies. For sequential work, prefer the first one; for a parallel wave, select up to five tasks whose expected write sets and stateful checks do not overlap.
4. Never implement `backlog` or `blocked` tasks without the required transition or missing input.
5. Mark every selected task `in_progress` before implementation.
6. Keep task-file state in the primary checkout. Workers receive the task specification but do not edit `agent_docs/tasks`; the integrating agent is its only writer.

The [task queue manual](tasks/README.md) owns statuses, dependencies, commands, task shape, evidence gates, and the local completion archive; `scripts/task-ledger.mjs` enforces them. A task is the executable plan and handoff artifact; do not create a parallel plan file or any second completed-plan archive.

## Parallel Task Waves

When the operator asks to run queued tasks in parallel, one integrating agent owns selection, task state, and integration. Use isolated workers when the active tool supports them; never run uncoordinated writers in the primary checkout.

1. Inspect ready tasks, current dirty paths, likely write sets, dependencies, migrations, generated outputs, and stateful checks. Exclude tasks that overlap the primary checkout's uncommitted work or each other.
2. Select no more than five independent tasks and mark each one `in_progress` in the primary checkout before spawning workers.
3. Give each worker one self-contained task specification and an isolated write scope. Tell workers not to edit `agent_docs/tasks`.
4. Each worker implements and verifies only its assigned slice, then returns changed paths, exact checks, decisions, blockers, and an inspectable patch or branch when isolation is external.
5. Wait for every worker and inspect every result. Apply only non-conflicting changes; a failed apply or conflict is an integration result, never permission to discard either side.
6. Resolve conflicts in the integrating session against both task contracts and current code. Preserve unrelated dirty work, add an interaction regression when the conflict exposes one, and rerun the affected focused checks. Leave the task `in_progress` or block it with the exact condition when safe integration is impossible.
7. Run combined verification only after successful results are integrated. Stateful and container checks remain serialized.
8. Perform the final automated diff inspection, then complete each integrated task from the primary checkout.

Five workers are a ceiling, not a target. Prefer a smaller wave when tasks share providers, run-pipeline code, schema/migrations, generated files, global configuration, or the same integration environment. Parallelize exploration and hermetic tests more freely than writes and stateful checks.

## Execution Loop

1. Read only the subject documents routed by `AGENTS.md` and the code being changed.
2. Record a concrete first checkpoint in `Progress` after claiming the task.
3. Implement the smallest coherent vertical slice.
4. Add the cheapest deterministic test that would fail for the regression.
5. Update `Progress` after meaningful checkpoints and record only task-local choices in `Decisions`.
6. Run focused checks while iterating. Near completion, run the proportional hermetic or container-parity lane from `TESTING.md`; run E2E, runtime image builds, migrations, security audits, or provider smokes only when the task crosses those boundaries.
7. Update the owning living document only when the change modifies a durable product contract, invariant, architecture/data boundary, configuration/environment contract, operator workflow, security boundary, or verification policy. Put durable rationale beside the current rule.
8. Record exact passed checks and unavailable checks with reasons in `Verification`, and settle `Durable rationale` as `none` or `moved to <agent_docs owner>`.
9. Complete the verified task directly. If the only required evidence is unavailable, block it instead.

## Verification Policy

[Testing](TESTING.md) is the sole owner of lane selection, exact commands,
disposable topology, and check-concurrency rules. While implementing, use its
focused deterministic lane; before completion, select the proportional
hermetic, container, browser, dependency, or explicitly authorized provider
evidence it requires. Parallel execution does not weaken the installation and
data boundaries routed by [Security](SECURITY.md).

## Autonomy Boundaries

The agent may choose implementation names, conservative UI details, focused test granularity, wave membership, and small sequencing decisions. Stop for missing secrets, paid or large provider calls outside the approved smoke policy, destructive operations not requested by the operator, an unavailable required external service, missing authority, or a product decision not covered by current contracts.

## Final Task-Owned Inspection

Before completion, perform the root [Before Final Response](../AGENTS.md#before-final-response) checklist. Compare final status with the initial state; run unstaged and staged whitespace checks; inspect the complete task-owned `HEAD` diff and every new untracked task-owned file. Reject unrelated edits, secrets/private values, artifacts, generated drift, or unjustified contract/documentation changes, and distinguish preserved user changes in the task evidence and operator report.

## Done Standard

Work is complete only when the requested outcome is implemented, relevant automated checks pass, required living documents are current, final task-owned inspection is clean, and the app remains runnable or clearly verifiable. A task with unavailable-only required verification is blocked, not complete. Prefer one commit per completed queued task with subject `<task-id>: outcome in one line`.

## Operator Report

Report the outcome, material decisions, exact checks run, relevant checks not run, the integration branch or landed commit, and the distinction between task-owned and pre-existing user changes. Continue only when broad implementation was requested and the next task or wave is concrete and unblocked.
