# AGENTS

AIQSA is a self-hosted, multi-user, model-agnostic conversational workspace. Optimize for working functionality, clear outputs, and reliable operation.

## Working Loop

- Treat implementation requests as permission to proceed. Concrete same-session changes need no task. For queued, dependent, broad, parallel, or multi-session work, use [Autonomous workflow](agent_docs/AUTONOMOUS_WORKFLOW.md) and the [task manual](agent_docs/tasks/README.md); mark selected tasks `in_progress` before implementation. The integrating agent owns state, conflicts, review, and verification.
- Start with [critical invariants](agent_docs/CRITICAL_INVARIANTS.md), then [INDEX](agent_docs/INDEX.md) and only the crossed owners. Read the nearest scoped `AGENTS.md` before editing; adjacent `CLAUDE.md` files import it.
- Read [Testing](agent_docs/TESTING.md) before behavior/test changes and [Environment](agent_docs/ENV_VARIABLES.md) before Compose commands. Preserve the checkout's environment selection. Use [defaults](agent_docs/DECISION_DEFAULTS.md) only for choices the operator leaves open.
- Inspect `git status --short` before editing and preserve unrelated changes. Without Git, report that and continue without synchronization.
- Implement the smallest complete slice, verify proportionally, and complete verified work directly; there is no human-review gate. Unavailable required evidence leaves work blocked. Continue beyond the current work only under broad implementation permission with another concrete unblocked task.
- Stop only for missing secrets/authority, unrequested destructive work, an unavailable required service, or an uncovered product decision. Provider-smoke and dependency-security permissions belong to Testing and [Security](agent_docs/SECURITY.md).

## Authority And Scope

The operator defines scope and outcome; critical invariants constrain them. Code, schemas, migrations, and tests define exact behavior. Documentation owns only non-derivable rules, boundaries, and rationale. Fix code that violates a durable rule unless the operator changes the rule; remove stale prose mirrors instead of synchronizing them. Use Git history only for archaeology.

Before the first production deployment, compatibility for persisted data, wire formats, environment aliases, URLs, backups, or local task layouts requires an explicit author decision for external state that actually exists. Development databases, disposable installations, local task files, and fixtures are not compatibility contracts. [Persistence](agent_docs/PERSISTENCE.md#migrations-and-bootstrap) owns the release upgrade policy.

Use existing code and contracts before adding scope or abstractions. Remove unused diagnostic surfaces and projections. Routine implementation changes need no documentation update; each durable rule has one owner.

`human_docs/**` is secondary documentation for people, not a source of truth or agent context. Do not consult it for planning, implementation, debugging, or verification. Read, create, or change it only when the operator explicitly requests work on those documents; never synchronize it as a side effect of other changes. Its scoped `AGENTS.md` and `CLAUDE.md` remain mandatory agent instructions.

Use only the scoped `.aiqsa/handoff/` (when explicitly requested), `.aiqsa/local-dev-profile/`, and `.aiqsa/kb-microbench/` workspaces under their local instructions; do not create sibling variants.

## Publication

`origin` is public. Private task instances and `.aiqsa/` state must never be staged, committed, included in Docker contexts/images, or added to public refs. Existing history does not justify ref rewrites. Pushes, ref rewrites, and release tags require an explicit request; publication also requires fresh readiness and privacy checks.

Export an inspected commit/tree with `git archive` to a fresh path, never archive the working directory. Attach local tasks separately only after manual review.

## Before Final Response

1. Compare final `git status --short` with the initial state. Run `git diff --check` and `git diff --cached --check`.
2. Inspect the complete `HEAD` diff for every task-owned tracked path, including staged changes, and every new task-owned file in full.
3. Reject unrelated changes, secrets/private values, build/log/cache artifacts, generated drift, and unjustified contract/documentation changes. Preserve and report pre-existing user changes.

Documentation-only changes run `npm run docs:check`; other changes follow Testing. Report outcome, material decisions, exact checks, relevant checks omitted with reasons, and remaining blockers.
