# ADR 0044: Explicit Answer-Selectable Provider Models

Status: Accepted
Amends: 0022-admin-managed-llm-provider-control-plane, 0024-admin-managed-run-profiles, 0029-built-in-full-access-group, 0030-direct-run-controls-and-reviewed-provider-catalog, 0043-admin-managed-multi-engine-search-plans

## Context

ADR 0043 deliberately lets a Search integration reuse the provider control
plane for its technical runtime, credential precedence, tested deployment, and
immutable run binding. That technical runtime is therefore stored as a normal
`ProviderModel`. The current-user answer catalog, administrator grant catalog,
and Run-profile catalog previously treated every active available
`ProviderModel` as a possible answer deployment.

This made a dedicated Search runtime appear in Research Chat's model picker.
Disabling its Search integration did not remove it because Search availability
and provider-model availability are correctly independent lifecycle facts. A
display-name check, provider special case, or rule based on current Search
references would make that accidental coupling worse and would prevent one
deployment from intentionally serving both answer and Search roles.

## Decision

Every non-Fake immutable provider-model configuration has an explicit
`answerSelectable` boolean:

- absent legacy values normalize to `true`, so existing ordinary deployments
  retain their behavior without a schema migration;
- `true` means the deployment may be projected and admitted as an answer model;
- `false` means it is a technical runtime only. It remains an active tested
  provider deployment and may be referenced by a typed Search integration, but
  it is not an answer-model choice.

The flag is provider-neutral and independent from adapter kind, capabilities,
provider family, hostname, upstream model id, display name, entitlement, and
Search integration enabled state. An answer-selectable deployment may also be
used by Search. There is no exclusive role enum and no inference from current
references.

The normal provider draft, exact-draft test, and activation lifecycle owns
changes to this flag. The existing administrator model editor exposes
**Available as answer model**, explains the technical-runtime consequence, and
shows the configured role in the model inventory. Quick and Custom setup create
ordinary answer-selectable deployments by default.

The server enforces the same distinction at every answer boundary:

- the current-user catalog excludes technical-only deployments before
  provider/model grouping, defaults, per-model controls, and profile
  reconciliation;
- the administrator grantable model catalog and Run-profile target choices
  exclude them;
- atomic run admission revalidates `answerSelectable` and rejects a direct or
  stale technical-only answer selection as `model_not_available`; and
- `Full access` remains an entitlement wildcard, not authority to override the
  deployment role.

Search keeps a separate technical-role admission path. It resolves the same
active connection, effective credential, exact current availability check,
immutable provider snapshot, and accepted Search revision without requiring an
answer-model entitlement or `answerSelectable=true`. Admin Search compatibility
and readiness continue to see technical-only deployments. Disabling or
archiving an integration affects Search publication only; it does not rewrite
the referenced provider model or make that model an answer deployment.

Fake QSA remains a code-owned development answer model and is not editable
through this provider lifecycle. Existing invalid/inactive Run-profile targets
retain their recovery behavior, while an explicit technical-only target is not
offered as an inactive answer choice.

## Rejected Alternatives

- **Hide deployments whose name contains `Search` or `runtime`.** Names are
  mutable presentation and do not establish authority or protocol role.
- **Hide a model only while a Search integration references it.** Reference
  and integration-enabled state would silently change answer access and make
  intentional dual-use deployments impossible.
- **Disable the provider model together with Search.** A disabled model cannot
  serve an enabled Search integration and conflates two independent lifecycle
  resources.
- **Use a mutually exclusive answer/search role enum.** One reviewed
  deployment may safely support both roles; the required policy is only whether
  it may be selected as an answer.
- **Rely on frontend filtering.** Direct/stale requests and administrator
  target mutations still require server-side rejection.

## Consequences

- Dedicated Search runtimes no longer appear as chat models, grant targets, or
  Run-profile choices, even for Full-access users.
- Search continues to use the provider vault, credential resolution, tests,
  capabilities, and immutable execution snapshots without a parallel model
  registry.
- Existing installations remain compatible, but administrators must activate
  `answerSelectable=false` once for already-created dedicated Search runtimes.
- Future technical consumers may reuse the same additive property without
  adding provider or service-name branches; a broader multi-role policy would
  require a new decision.
