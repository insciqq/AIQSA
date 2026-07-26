# ADR 0028: Task-first Control Center And Direct Provider Setup

Status: Accepted
Amends: 0016-responsive-composer-disclosure, 0018-intent-gated-mobile-reading-mode, 0022-admin-managed-llm-provider-control-plane, 0024-admin-managed-run-profiles, 0025-clean-slate-research-chat-and-control-center, 0026-personal-provider-quick-setup

## Context

The first clean-slate presentation changed the visual language but retained several interaction structures from the old administration console. Provider setup was placed under a plan-like `Personal` heading, any team or custom provider state could turn a provider into an `Advanced` dead end, Users and Groups required a small row action instead of making the resource row selectable, Groups and Model access duplicated one group-owned workflow, and desktop resource pages kept an always-open master/detail split. The empty Research Chat also kept its composer at the bottom before a conversation existed.

Those choices add navigation and interpretation work without protecting a backend invariant. They are especially damaging to the common self-hosted path: an administrator who already has a provider key should be able to make their own account usable without creating a group or understanding revisions, assignments, or activation mechanics. Existing team configuration must remain safe, but its existence is not a reason to block a separate direct-user setup.

The approved raster concepts and current ChatGPT, Claude, and Open WebUI patterns are design evidence, not product contracts. AIQSA adopts their task focus, calm hierarchy, centered start state, and progressive disclosure while retaining only capabilities and data that actually exist in this repository.

## Decision

### Research Chat start state

A ready blank Research Chat centers the normal composer and a short orientation message in the available conversation stage. It does not render a second mini-composer, onboarding dashboard, suggestion grid, or alternate draft owner.

The existing composer instance and state owner move to the thread tail as soon as first-chat creation begins or any optimistic/persisted message exists. Loading, bootstrap failure, no-entitled-model, saved empty-chat, active-run, and history states retain their truthful existing availability rules; centering is a presentation state, not a second send path.

### Control Center information architecture

The Control Center uses stable subject headings rather than plans, personas, or progressive navigation tiers:

- **AI setup** — Providers;
- **Team & access** — Users, Access & groups, Invites, Access rules;
- **Operations** — Usage;
- **Infrastructure** — MCP servers, Email delivery; and
- **Safety** — Safety.

Headings orient the index and are not routes, collapsible onboarding stages, commercial plans, or authorization boundaries. `Providers` is the default destination for bare `/admin`. The active section remains directly addressable through the existing client-side section URL contract.

`Access & groups` is the one canonical destination for group identity, membership, model/search grants, and MCP grants. The old `groups` and `model-access` section values remain accepted migration aliases and normalize to canonical `access`; they do not render separate destinations or separate state owners.

### Resource index and detail composition

Users and Access & groups open as full-width resource indexes. No first row is selected automatically. The whole visible row is the primary selection target, and every row that appears selectable opens the corresponding dedicated detail state.

A selected User or Group owns a full-width detail page with explicit Back navigation to its preserved index. Peer concerns may use local tabs inside that resource detail. Group detail owns Overview, Members, Models & search, and Tools rather than forcing administrators to change global destinations or edit membership through a different User detail. Filters, draft changes, selection, and local scroll are retained when returning to the index where the existing controller state permits it.

The universal desktop master/detail split is retired. It may still be used by a specialized comparison tool only when simultaneous index and detail context is intrinsic to that task; it is not the default resource-page template. Compact layouts likewise use explicit index/detail states rather than horizontally compressed desktop tables.

### Provider Quick setup is always the primary task

Providers opens the Quick setup task directly. The supported code-owned providers are ordinary choices, never status-labelled `Advanced`. Selecting one reveals the write-only API-key field and one **Test & Save** action. Advanced configuration is a secondary link and does not have to be opened before entering the key.

Quick setup may coexist with group assignments, additional credentials, extra active models, direct grants, or other same-family custom connections. Those resources are reported only as nonblocking advanced-configuration context. Quick setup must preserve them and must not flatten, rename, disable, reassign, or adopt them.

The exact canonical code-owned connection/model subgraph still has to be safe to use. If that canonical subgraph itself was changed so that the tested official-provider key cannot truthfully prove the runtime route, or if a raced state cannot be reconciled losslessly, the server fails without writing and points to Advanced. Unrelated advanced state alone is never this failure condition.

### Direct-user provider credential assignment

The reserved ADR 0022 resolver seam is now implemented as `ProviderUserCredentialAssignment`, with one assignment per `(connection, user)` and a lineage-safe reference to a credential on the same connection.

For a non-fake provider connection, runtime credential resolution is:

1. the user's direct assignment, when present;
2. one unambiguous credential selected by the user's active, non-archived group assignments;
3. the connection default only when `unassignedPolicy = use_default`; otherwise assignment is required.

Once a tier selects a credential, that selection is final. Missing, disabled, versionless, or revoked credentials fail closed and never fall through to a lower tier. Distinct active group assignments remain ambiguous and fail closed. Accepted run bindings persist `credentialSource = user | group | default` together with the exact credential version and execution snapshot.

Entitlement and credential selection remain independent. A direct credential assignment grants no model access; a direct model grant selects no credential.

### Quick setup persistence and replacement

After bounded candidate testing completes outside a database transaction, Quick setup commits a direct acting-user path on the canonical code-owned provider subgraph:

- an enabled, immutable-versioned credential owned by the acting user's direct assignment;
- the direct `ProviderUserCredentialAssignment` for the canonical connection;
- one selected supported code-owned answer deployment in a runnable active state;
- an exact available credential-version/model-version check;
- one enabled direct model grant for the acting user; and
- the acting user's default model only when the prior default is absent or unusable, plus only the still-untouched run-profile fill already allowed by ADR 0026.

The transaction preserves connection defaults, group assignments, other users' assignments, unrelated credentials and versions, extra models, grants, custom connections, user preferences, and edited run profiles. It does not change a canonical connection's route/configuration unless that row is still an untouched code-owned bootstrap row whose activation is part of the selected Quick candidate.

Replacement rotates only the credential currently selected by the acting user's direct assignment and leaves the previous usable version active unless candidate testing and the fenced commit both succeed. Before writing, the replacement key must expose the upstream IDs of every currently available model on the canonical connection to which the acting user is already entitled. The bounded set is capped at 64; a larger set, a changed set, or one missing upstream ID fails without writes and requires Advanced. The commit records an exact `available` check for the new credential version against every preserved model version plus the selected Quick candidate. Ready is returned only when the acting user's post-commit catalog can still expose that complete preserved set and the selected model.

Ready-state removal is deliberately not credential deletion. `DELETE /api/admin/providers/quick-setup` requires the actor-relative provider and current state fence, then deletes only the acting user's matching direct `ProviderUserCredentialAssignment`. The credential/version, checks, model grants, defaults, group assignments, and team/custom configuration remain. Catalog access may continue through an applicable group/default credential or may stop; the UI requires confirmation and makes no fallback promise.

The Quick status is actor-relative. It describes whether this administrator has a ready direct path, needs a recoverable key rotation, has not configured one, or has a narrowly unsafe canonical collision that Quick cannot reconcile. The wire-compatible `advanced_required` state is reserved for that last condition; it is never inferred from unrelated advanced configuration. Its former use as the ordinary provider-card state and a mandatory disclosure gate is retired. The key task remains visible, while a setup attempt against the unsafe canonical state fails without writes and directs the administrator to Advanced.

### Advanced provider workspace

Advanced remains the complete ADR 0022 control plane. It opens as a dedicated full-width Providers subview: first a connection index, then one selected connection page with Back navigation and horizontal peer tasks such as Overview, Credentials, Models, Authentication/routing, Diagnostics, and Run profiles as supported by current capabilities. A never-activated `Not configured` connection is presented as neutral setup guidance; warning treatment is reserved for a configured or pending state that genuinely needs intervention.

The advanced workspace does not show a persistent connection list beside the selected connection and does not nest another vertical navigation rail inside the global Control Center rail. It may keep draft/test/activate safeguards and detailed evidence; only their presentation hierarchy changes.

### Accessibility scope

Dedicated accessibility implementation and conformance remain deferred until the operator approves a separate task. This decision adds no accessibility acceptance gate. Responsive layout, touch operation, safe-area/software-keyboard clearance, readable content, and overflow containment remain ordinary product behavior.

## Consequences

- A single administrator can connect a provider and start chatting without creating a group or entering the advanced control plane, even on an installation that already has team configuration.
- Team credentials and direct-user credentials can coexist on one connection with deterministic, fail-closed precedence and exact run provenance.
- Users, groups, and provider connections have predictable index-to-detail navigation instead of action-cell discovery and stacked master/detail rails.
- Existing `groups` and `model-access` links remain valid while the visible information architecture loses duplicate destinations.
- The empty Research Chat behaves like a mature conversation product without duplicating composer state or changing first-send persistence.
- Raster concepts continue to guide hierarchy and visual review, but repository contracts and runtime evidence prevent invented navigation, data, or status claims from entering the product.
