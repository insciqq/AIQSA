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

The [task queue manual](tasks/README.md) owns statuses, dependencies, commands, task shape, evidence gates, and completion deletion; `scripts/task-ledger.mjs` enforces them. A task is the executable plan and handoff artifact; do not create a parallel plan file or completed-plan archive.

## OMP Setup

Start `omp` from this repository root in WSL. Machine-local provider credentials and the `codex-lb` model definition live under `~/.omp/agent/`; the tracked `.omp/config.yml` contains no endpoint or secret. `CODEX_LB_API_KEY` must be exported in the launching shell. Project settings are discovered from the current directory only, so do not start OMP in a parent directory and `cd` here later.

No repository installer or nested `codex exec` process is part of this workflow. The project config selects only `codex-lb/gpt-5.6-sol`, permits five concurrent subagents, enables per-item effort, and automatically applies non-conflicting isolated patches. To request the full native orchestration contract, include the exact standalone lowercase word `orchestrate` in the prompt, for example: `orchestrate: take up to five independent ready tasks, implement them in parallel, integrate conflicts, verify the combined result, and complete them.` Plain parallel requests may also delegate because eager task use is enabled.

## Parallel Task Waves

When the operator asks to run queued tasks in parallel, the main OMP session is the integrating agent and uses one native `task` batch. Do not emulate it with nested CLI processes.

1. Inspect ready tasks, current dirty paths, likely write sets, dependencies, migrations, generated outputs, and stateful checks. Exclude tasks that overlap the primary checkout's uncommitted work or each other.
2. Select no more than five independent tasks and mark each one `in_progress` in the primary checkout before spawning workers.
3. Make one batch call with shared repository context and one self-contained item per task. Use `isolated: true` for every writer, select `effort: lo|med|hi` by risk, and tell workers not to edit `agent_docs/tasks`. The batch creates one background subagent per item under the configured five-agent semaphore.
4. Each worker implements and verifies only its assigned slice in its isolated workspace, then returns changed paths, exact checks, decisions, and blockers. Read-only mapping or independent hermetic checks may share a workspace only when they cannot mutate it.
5. Wait for every background job and inspect every result. OMP applies each successful non-conflicting isolation patch to the parent checkout and preserves a patch artifact when automatic application fails. A failed apply or conflict is an integration result, never permission to discard either side.
6. Resolve failed patches in the main Sol `max` session against the artifact, both task contracts, and current code. Preserve unrelated dirty work, add an interaction regression when the conflict exposes one, and rerun the affected focused checks. Leave the task `in_progress` or block it with the exact condition when safe integration is impossible.
7. Run combined verification only after successful results are integrated. Stateful and container checks remain serialized.
8. Perform the final automated diff inspection, then complete each integrated task from the primary checkout.

Five workers are a ceiling, not a target. Prefer a smaller wave when tasks share providers, run-pipeline code, schema/migrations, generated files, global configuration, or the same integration environment. Parallelize exploration and hermetic tests more freely than writes and stateful checks.

## Model Routing

Every role uses `gpt-5.6-sol` through `codex-lb`; project model allowlisting, role selectors, and agent overrides prevent another model from being selected. Route effort as follows:

- `low`: scouts, sonic searches, and narrow mechanical work.
- `medium`: ordinary bounded implementation and repository research.
- `high`: automated design and code-review specialists.
- `max`: the primary orchestrator, planning, security/schema-critical work, conflict resolution, and final integration inspection.

For a generic task item, OMP maps `lo`, `med`, and `hi` to the lowest, middle, and highest configured Sol levels: `low`, `medium`, and `max`. Use the named design or review specialists when `high` is the intended ceiling. Do not use `xhigh`, Fast mode, model fallback, or a non-Sol subagent. Escalate ambiguity rather than compensating for an underspecified task merely by increasing effort.

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

- Use `npm run check:hermetic` for deterministic host-local static/unit completion and `docker-compose.dev.yml` for container parity or integration; never point either lane at the default persistent installation.
- Prefer focused Vitest files while implementing.
- Run `npm run check:container` near completion only when the change needs PostgreSQL, container/process topology, or another integration boundary.
- Run destructive local Playwright only for browser/server workflows or an explicit task requirement.
- Development-stack data is disposable. Checks and E2E may mutate or reset only the `aiqsa-dev` database and object bucket.
- Parallel stateful/container checks are unsupported. Hermetic focused files may run independently only when they do not share generated-output writes.
- Provider smokes remain small, explicit, and conditional on operator-provided keys.

Exact commands and test selection live in `agent_docs/TESTING.md`. Security-sensitive installation boundaries remain owned by `SECURITY.md`; parallel execution does not weaken auth, tenancy, migrations, backup, persistence, or deployment requirements.

## Autonomy Boundaries

The agent may choose implementation names, conservative UI details, focused test granularity, wave membership, and small sequencing decisions. Stop for missing secrets, paid or large provider calls outside the approved smoke policy, destructive operations not requested by the operator, an unavailable required external service, missing authority, or a product decision not covered by current contracts.

## Final Task-Owned Inspection

Before completion, perform the root [Before Final Response](../AGENTS.md#before-final-response) checklist. Compare final status with the initial state; run unstaged and staged whitespace checks; inspect the complete task-owned `HEAD` diff and every new untracked task-owned file. Reject unrelated edits, secrets/private values, artifacts, generated drift, or unjustified contract/documentation changes, and distinguish preserved user changes in the task evidence and operator report.

## Done Standard

Work is complete only when the requested outcome is implemented, relevant automated checks pass, required living documents are current, final task-owned inspection is clean, and the app remains runnable or clearly verifiable. A task with unavailable-only required verification is blocked, not complete. Prefer one commit per completed queued task with subject `<task-id>: outcome in one line`.

## Operator Report

Report the outcome, material decisions, exact checks run, relevant checks not run, the integration branch or landed commit, and the distinction between task-owned and pre-existing user changes. Continue only when broad implementation was requested and the next task or wave is concrete and unblocked.
