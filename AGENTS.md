# AGENTS

Entry point for agent-driven development in this repository.

AIQSA is a self-hosted, multi-user, model-agnostic conversational web interface with Search, Knowledge, files, Memory, and MCP tools. Optimize for working functionality, clear outputs, and reliable operation. Keep this manual current and put durable rationale beside its owning rule.

## Autonomy Trigger

If the operator says "start implementation", "begin", "go ahead", or an equivalent instruction, do not ask what to do next:

1. Follow the reading map for the requested scope.
2. Inspect repository state.
3. A concrete same-session change may run directly without a task. Create or use a task for queued, dependency-bearing, broad, or multi-session work.
4. For broad queued work, reconcile existing `in_progress` tasks and select unblocked `ready` tasks. Use the parallel-wave rules in `agent_docs/AUTONOMOUS_WORKFLOW.md` when the operator requests parallel execution.
5. Mark every selected queued task `in_progress` before implementation.
6. Implement the smallest complete vertical slice; the integrating agent owns task state, automated review, conflict resolution, and integration.
7. Run proportional checks and update an owning living document only when its durable contract changed.
8. Complete verified tasks directly; completion moves each task to the local archive and clears remaining dependency references.
9. Continue only when broad implementation was requested and another concrete unblocked task or safe parallel wave remains.

Stop only for missing secrets, unrequested destructive work, an unmockable unavailable service, or a product decision not covered by current contracts. Provider-smoke permission is in `agent_docs/CRITICAL_INVARIANTS.md`; dependency-security permission is in `agent_docs/SECURITY.md`.

## Completion Policy

There is no human-review status or acceptance gate. Complete work after automated inspection and proportional verification; block it when required evidence is unavailable.

## Reading Map

Do not preload the whole harness. Start with `agent_docs/CRITICAL_INVARIANTS.md`, then use `agent_docs/INDEX.md` to select only the owner crossed by the change. Read `agent_docs/PRODUCT_PRINCIPLES.md` only when product direction or prioritization is part of the scope.

Then read only what the scope requires:

- Before changing a scoped directory, read the nearest `AGENTS.md`; Claude-compatible scopes import it through the adjacent `CLAUDE.md`.
- Read `agent_docs/AUTONOMOUS_WORKFLOW.md` only for broad selection, queued/task-state work, dependencies, parallel waves, or multi-session work. For queued work, also read `agent_docs/tasks/README.md` and the selected task from `agent_docs/tasks/queue/`. Named same-session work does not require the full workflow.
- When the operator left a product or implementation choice open, read `agent_docs/DECISION_DEFAULTS.md`.
- Read `agent_docs/ARCHITECTURE.md` for topology or module/data/deployment boundaries; `agent_docs/BACKEND.md` for routes, auth, uploads, and server composition; and `agent_docs/PERSISTENCE.md` for schema, migration, retention, backup, restore, or deletion work.
- Read `agent_docs/RUN_CONTRACTS.md` for run admission, context, Search, Knowledge, tools, streaming, recovery, output, usage, or sharing; `agent_docs/PROVIDERS.md` for provider/Search/embedding transport; and `agent_docs/MEMORY.md` for personal Memory.
- Read `agent_docs/FRONTEND.md` for UI behavior, state, accessibility, shell, visual composition, theme, geometry, density, or motion.
- Read `agent_docs/ENV_VARIABLES.md` before environment/configuration work and `agent_docs/SECURITY.md` before dependency, trust, secret, auth, network, or security work.
- Before changing behavior or tests, read the verification map, applicable lane, and test-authoring rules in `agent_docs/TESTING.md`; consult its boundary-specific verification requirements and opt-in commands only when the scope crosses that boundary.

## Contract Authority

- The operator's current request defines intended scope.
- `agent_docs/CRITICAL_INVARIANTS.md` defines non-negotiable safety and product-semantic boundaries unless the operator explicitly requests a contract change.
- Executable code, schemas, migrations, and tests plus the owning living document define current behavior.
- When executable behavior/tests and a living contract disagree, treat it as drift. Resolve a clear mismatch from the request, observable behavior, tests, and nearby owners, updating both sides; escalate only when two plausible readings change product semantics.
- A task may change a living contract only when its goal says so and the owner is updated in the same implementation.
- `PRODUCT_PRINCIPLES.md` and `DECISION_DEFAULTS.md` guide choices that current contracts leave open.

Do not reconstruct current behavior from old plans or Git history when code and living contracts answer it. History is for archaeology.

## Pre-production Compatibility

Before the first production deployment, backward compatibility for persisted data, wire formats, environment aliases, URLs, backup formats, and local task layouts requires an explicit author decision for external state that actually exists. Development databases, disposable installations, local task files, and test fixtures are not compatibility contracts.

## Repository State

Inspect the normal worktree before making changes:

```bash
git status --short
```

If this is not a Git repository, record that in the final response and continue without Git synchronization. Preserve unrelated user changes.

## Repository Publication

`origin` is the public development/release repository. Queued, parked, and archived task instances are local ignored state and must never be staged, committed, included in Docker context/images, or added to a public ref. Older commits/tags are grandfathered archaeology and do not justify ref rewrites. Agents do not push, rewrite refs, or tag releases without an explicit request; release publication also requires fresh readiness and privacy checks.

For repository sharing, export an inspected commit/tree with `git archive`; never archive the working directory, where ignored/untracked files remain. Use a fresh output path. Attach local tasks separately only after manual review.

## Working Rules

- Prefer the smallest change that leaves the app runnable or clearly verifiable.
- Use existing code and current local contracts before inventing scope or another abstraction.
- Delete product-facing diagnostics and unused projections when they have no operational consumer. Do not preserve a hidden inspection/admin/debug surface merely to avoid removing code.
- Keep internal run data purpose-bound to execution, recovery, side-effect safety, security, retention, or aggregate accounting. Do not expose repository objects directly to the browser; serialize an explicit client-safe contract.
- Use the focused hermetic lane for deterministic static/unit work and `docker-compose.dev.yml` only for required container parity or integration. Never run destructive development or test workflows against the default persistent installation.
- Keep one task file as the specification, execution plan, progress log, and task-local decision log. Do not create a second plan document for the same work.
- Keep executable unfinished tasks in `agent_docs/tasks/queue/`, parked work outside the ledger in `agent_docs/tasks/drafts/`, and completed tasks only in `agent_docs/tasks/archive/`. Archive size never blocks validation or completion, and the harness never prunes, rotates, or overwrites archived task records. Cleanup happens only on an explicit operator request. Do not force-add any task instance or create another completion journal or decision-history directory.
- Update the owning living document only when the change modifies a durable product contract, invariant, architecture/data boundary, configuration/environment contract, operator workflow, security boundary, or verification policy. A bug fix or implementation change that restores or preserves an already documented contract does not require a documentation edit.

## Before Final Response

In a Git checkout, complete this task-owned review before reporting completion:

1. Re-run `git status --short` and compare it with the initial state.
2. Run `git diff --check` and `git diff --cached --check`.
3. Inspect the complete `HEAD` diff for every task-owned tracked path, including staged changes. Inspect each new untracked task-owned file in full because Git diff omits it.
4. Verify that the task introduced no unrelated changes, secret/private values, build/log/cache artifacts, accidental generated-file drift, or contract/documentation changes not justified by the task.
5. Preserve pre-existing user changes and distinguish them from task-owned edits in the final report.

For documentation-only changes:

```bash
npm run docs:check
```

For application code changes, run the checks routed by `agent_docs/TESTING.md`. Report exact checks run, checks not run with reasons, material decisions, and any remaining blocker.
