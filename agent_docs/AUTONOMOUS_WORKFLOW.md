# AUTONOMOUS_WORKFLOW

Use this loop for queued, dependent, parallel, or multi-session work. Concrete same-session work follows root [AGENTS](../AGENTS.md). The [task manual](tasks/README.md) and `scripts/task-ledger.mjs` own task shape, statuses, dependencies, transitions, and archive rules; do not create a second plan or completion archive.

## Selection And Execution

1. Inspect Git state, the operator's scope, relevant code, and the owners in [INDEX](INDEX.md).
2. Reconcile existing `in_progress` queue tasks before claiming more. Select dependency-free `ready` tasks in natural filename order; drafts are outside selection. Do not implement `backlog` or `blocked` work without its required transition/input.
3. Mark selected tasks `in_progress` before implementation. Record the slice's verification scope and executor using [Testing](TESTING.md), then implement the smallest complete slice.
4. Keep task-local progress, decisions, exact evidence, and blockers in that task. Move only durable non-derivable rationale to its document owner; otherwise record `none`.
5. Perform root [final review](../AGENTS.md#before-final-response), then complete verified work directly. Required-but-unavailable evidence leaves the task blocked. Archive through the ledger; never prune archives automatically.

## Parallel Work

One integrating agent owns queue state, review, conflicts, verification, and integration. Workers receive bounded specifications and disjoint write scopes; they do not edit the queue. Prefer isolated workers and never allow uncoordinated writers.

Select at most five independent tasks after checking dirty paths, shared schema/generated files, dependencies, and stateful environments. Parallel reads and hermetic checks are easier to isolate than writes. Stateful/container checks remain serialized.

Workers run focused checks; the integrating agent owns one combined slice qualification. Inspect every worker result and complete diff. Resolve conflicts against both contracts without discarding unrelated work, add a regression when an interaction warrants one, and rerun affected checks after integration. Failed integration is not completion.

Report outcomes, material decisions, exact checks, omitted evidence and reasons, and preserved user changes. Continue beyond the current task only under broad implementation permission with another concrete unblocked task or wave. Stop only at the authority, safety, missing-input/service, or uncovered product-decision boundaries in root AGENTS.
