# AGENTS

AIQSA is a self-hosted, multi-user, model-agnostic conversational web interface with Search, Knowledge, files, Memory, and MCP tools. Optimize for working functionality, clear outputs, and reliable operation.

## Autonomy

If the operator says "start implementation", "begin", "go ahead", or equivalent, proceed without asking what to do next.

A concrete same-session change may run directly without a task after scoped reading and repository inspection. Create or use a task for queued, dependency-bearing, broad, parallel, or multi-session work; follow `agent_docs/AUTONOMOUS_WORKFLOW.md`, `agent_docs/tasks/README.md`, and the selected queued task. Mark selected tasks `in_progress` before implementation. The integrating agent owns task state, review, conflicts, verification, and integration.

Implement the smallest complete slice and run proportional automated verification. Complete verified work directly; there is no human-review gate. If required evidence is unavailable, leave the work blocked. Continue beyond the current work only when broad implementation was requested and another concrete unblocked task or safe parallel wave remains.

Stop only for missing secrets, unrequested destructive work, an unavailable required service, missing authority, or a product decision not covered by current contracts. Provider-smoke permission is in `agent_docs/CRITICAL_INVARIANTS.md`; dependency-security permission is in `agent_docs/SECURITY.md`.

## Reading Map

Do not preload the whole harness. Start with `agent_docs/CRITICAL_INVARIANTS.md`, then use `agent_docs/INDEX.md` to read only the owner crossed by the change.

- Before changing a scoped directory, read its nearest `AGENTS.md`; adjacent `CLAUDE.md` files import it for Claude-compatible agents.
- When the operator leaves a product or implementation choice open, read `agent_docs/DECISION_DEFAULTS.md`.
- Before changing behavior or tests, read the verification map, applicable lane, and test-authoring rules in `agent_docs/TESTING.md`.

## Contract Authority

The current operator request defines scope and outcome. Critical invariants constrain it. Executable code, schemas, migrations, and tests define exact current behavior; routed `agent_docs` own only non-derivable rules, boundaries, and rationale.

Fix executable artifacts when they violate a durable rule unless the operator authorized changing that rule. Remove stale prose mirrors instead of synchronizing them. Use Git history only for archaeology.

## Pre-production Compatibility

Before the first production deployment, compatibility for persisted data, wire formats, environment aliases, URLs, backup formats, or local task layouts requires an explicit author decision for external state that actually exists. Development databases, disposable installations, local task files, and test fixtures are not compatibility contracts.

## Repository State And Publication

Before editing, run `git status --short` and preserve unrelated changes. If this is not a Git repository, report that and continue without Git synchronization.

`origin` is public. Queued, parked, and archived task instances and `.aiqsa/` local state must never be staged, committed, included in Docker context/images, or added to a public ref. Existing history does not justify ref rewrites. Do not push, rewrite refs, or tag releases without an explicit request; release publication also requires fresh readiness and privacy checks.

For repository sharing, export an inspected commit or tree with `git archive` to a fresh path; never archive the working directory. Attach reviewed local tasks separately only after manual review.

## Working Rules

- Prefer the smallest change that leaves the app runnable or clearly verifiable.
- Use existing code and current local contracts before inventing scope or another abstraction.
- Delete product-facing diagnostics and unused projections when they have no operational consumer. Do not retain a hidden inspection, admin, or debug surface merely to avoid removing code.
- Use the scoped `.aiqsa/handoff/` (only when explicitly requested), `.aiqsa/local-dev-profile/`, and `.aiqsa/kb-microbench/` workspaces; follow each local `AGENTS.md` and do not create sibling variants.
- Do not mirror implementation state in Markdown. Update only the routed owner when a non-derivable rule, boundary, operator contract, verification policy, or durable rationale changes.

## Before Final Response

In a Git checkout, complete this task-owned review before reporting completion:

1. Compare final `git status --short` with the initial state, then run `git diff --check` and `git diff --cached --check`.
2. Inspect the complete `HEAD` diff for every task-owned tracked path, including staged changes, and inspect every new untracked task-owned file in full.
3. Reject unrelated changes, secrets or private values, build/log/cache artifacts, generated drift, and unjustified contract or documentation changes. Preserve and report pre-existing user changes.

Documentation-only changes run `npm run docs:check`. Application changes follow `agent_docs/TESTING.md`. Report exact checks run, relevant checks not run with reasons, material decisions, and remaining blockers.
