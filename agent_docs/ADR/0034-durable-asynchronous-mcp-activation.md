# ADR 0034: MCP Activation Is One Durable Asynchronous Trust Decision

Status: Accepted
Amends: 0021-admin-managed-mcp-tools-and-isolated-runtime, 0033-unified-providers-workspace-and-lifecycle-state-language

## Context

The original MCP administration path exposed implementation phases as three
operator decisions: create a draft, wait for a synchronous validation request,
then activate the tested revision. In practice the first button stayed pending
while registry resolution, ToolHive materialization, MCP startup, handshake,
tool discovery, and cleanup ran inside one HTTP request. The interface did not
say which work was happening, could not recover that work after an application
restart, and asked the administrator to confirm activation a second time.

The first activation still has a real security consequence: an administrator
trusts the server and every valid tool it exposes as one unit. Validation must
therefore finish before the configuration becomes usable, but the long-running
mechanical work does not need another human decision after that trust decision
has already been made.

Ordinary-user enablement is a separate lifecycle. It already persists desired
enablement and lets the MCP runtime coordinator prepare a user-scoped runtime
asynchronously. Its transient `queued` and `starting` projections were being
presented as `Needs setup`, incorrectly turning normal progress into an
actionable configuration warning.

## Decision

### One activation decision

- A normal non-OAuth import is `Paste -> Parse -> Review -> Activate`. Parse is
  local and non-executing. Activate is the one explicit server-level trust
  decision and atomically creates the installation definition plus its current
  activation operation.
- The activation HTTP response acknowledges persisted work immediately. It
  never waits for package resolution, workload preparation, connection, tool
  discovery, or revision publication, and the administrator may safely leave
  the page after acknowledgement.
- Successful validation automatically publishes and enables the exact tested
  revision. There is no second activation click in this happy path. Advanced
  explicit Test, revision inspection, update, rollback, and rebuild controls
  remain available for later lifecycle work.
- OAuth remains an honest prerequisite: the definition is created first so its
  validation authorization can be bound to an exact server and policy. A
  successful administrator validation callback queues activation instead of
  waiting for network validation inside the callback.

Clicking Activate authorizes publication only if all validation and fencing
checks succeed. It does not make the mutable draft, an untested artifact, or a
partial tool inventory available to users.

### Durable installation activation operation

- The current activation attempt is a dedicated one-row-per-server control
  plane record. It is not a general job framework and does not reuse
  `McpRuntimeGeneration`, which remains the user-scoped runtime lifecycle after
  an active revision exists.
- The record owns an opaque attempt id, exact draft hash, shared-configuration
  version, requesting validation identity when needed, a reclaimable claim
  lease, a persisted local validation workload token, bounded safe failure
  information, and timestamps.
- Observable stages are deliberately bounded to real server boundaries:
  `queued`, `resolving`, `preparing_runtime`, `connecting`,
  `discovering_tools`, `publishing`, `ready`, and `failed`. A source skips
  stages that do not apply. The product does not invent percentages, ETAs, or
  phases that the backend cannot observe.
- A process-local coordinator starts with the Node application, is kicked after
  enqueue, periodically sweeps Postgres, caps parallel activation work, and
  heartbeats its claim. A stale lease is reclaimable after a process or Docker
  restart. Compare-and-set updates fence every progress, failure, evidence, and
  publication write to the current attempt and lease.
- The persisted validation workload token is included in ToolHive orphan
  retention while its claim is live. Stale-lease reclaim rotates the token so
  late cleanup from the old claimant cannot delete the new claimant's workload;
  the released old token and terminal work return to ordinary orphan cleanup.
- Repeating Activate for the same live draft/configuration returns the current
  attempt. A changed draft or shared-configuration version supersedes the old
  attempt. Late work may finish cleanup but cannot store evidence or publish.

The final publication transaction rechecks the current attempt and lease,
draft hash, shared-configuration version, live server, and validation identity;
then it stores sanitized evidence, creates or reuses the immutable revision,
switches `activeRevisionId`, enables the server, invalidates affected desired
user runtimes, and marks the attempt ready. Failure never creates a usable
revision. An existing active revision remains active while an update is queued
or fails.

The asynchronous happy path uses only persisted shared values and persisted
OAuth state. A one-time value for a required personal-only validation slot
retains ADR 0021's request-only contract: it is accepted only by the explicit
advanced Test flow and is never persisted merely to make background activation
possible. Such a draft must be explicitly tested before its quick publication
path can be used.

### Truthful user-runtime readiness

- `queued`, `starting`, `idle` while reconciliation is being requested, and
  `restarting` are transient runtime work. Compact UI calls the aggregate state
  `Activating`; detail may say preparing, starting, or reconnecting.
- `Needs setup` is reserved for the exact `needs_setup` projection caused by a
  missing or invalid configuration value. Authorization and reauthorization
  retain their own language, and runtime failure is `Unavailable` or
  `Activation failed`, not setup work.
- A relevant enable mutation starts short-lived, visibility-aware catalog
  polling until enabled servers leave transient readiness. The existing slower
  visible-tab refresh remains a fallback; background polling does not replace
  or flicker the current catalog.

## Consequences

- Administration gives an immediate, observable response while preserving the
  tested immutable-revision trust boundary.
- Restart recovery and stale-worker fencing add one small persisted coordinator
  lifecycle to the supported single-host modular monolith; they do not add a
  worker service, broker, or multi-replica claim architecture.
- Administrators review discovered tools as evidence and can revise or disable
  the server after activation, rather than being forced through a second
  confirmation in the normal import path.
- Terminal failure must expose only stable codes and bounded issue paths. Raw
  registry, ToolHive, MCP, OAuth, stdout/stderr, and secret material remain
  outside the browser projection and logs governed by the existing MCP trust
  contract.
- Installation activation progress and user runtime readiness remain separate
  concepts even when both use the human word Activating.

## Verification

Automated coverage must prove immediate acknowledgement, idempotent enqueue,
exclusive claim, heartbeat and stale-lease recovery, changed-draft/configuration
fencing, retained validation workloads, bounded stages/failures, and atomic
publication without losing a previous active revision. Component/browser
coverage must prove the one-click Parse-to-Activate path, progress after
navigation/reload, terminal failure recovery, and the distinction between
Activating, Needs setup, authorization, and unavailable runtime states.
