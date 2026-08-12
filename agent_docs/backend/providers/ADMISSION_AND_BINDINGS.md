# PROVIDER ADMISSION AND BINDINGS

Owner: Provider runtime maintainers
Scope: Current provider control-plane authority, entitlements, credential resolution, immutable bindings, and run-input admission.
Read when: Changing provider setup, grants, credentials, deletion, catalogs, run preparation, binding snapshots, revocation, parameters, or attachment admission.
Code owners: `lib/server/admin/providers/`, `lib/server/providers/providerConfiguration.ts`, and `lib/server/runs/runPreparation.ts`.
Not owned here: HTTP/SSE limits, provider-neutral client Search execution, provider-specific wire mapping, or mutable upstream facts.

## Provider Admission And Bindings

Provider-specific code stays behind internal adapters. OpenAI and OpenRouter are decomposed by wire responsibility behind unchanged provider facades without changing the common adapter boundary.

Postgres is the normal-runtime authority for provider connections, explicit adapter protocol/authentication mode, deployments, routing, credentials, direct-user/group assignments, availability checks, and enabled state. Administrator edits use mutable draft slots with optimistic versions; credential activation creates an immutable validated version. Unsaved-key `Test` performs one bounded read-only account/model-catalog request without persistence or secret echo. Activation independently tests each referenced default, direct-user, or group credential once, derives the complete model × credential check set from catalog membership, and atomically switches only a still-current draft. Explicitly confirmed generation diagnostics use the current bounded request with at most 1,000 output tokens and discard its output. Optional draft model/route diagnostics use candidate-version CAS but never gate activation or replace active evidence; the separate exact active-tuple refresh may update that tuple's current evidence. Bearer secrets are write-only purpose-bound envelopes; an explicit tested private/local no-auth version has a real null envelope and still participates in the immutable-version/revocation guard. The saved Custom Models task may call `discover_compatible_models` with one stored credential id. The server resolves its exact draft-or-active bearer source, or the explicit active no-auth null source, and reuses the same bounded SSRF-safe `/models` probe. It returns at most 1,000 ordered unique IDs plus only allowlisted bounded context/output-token and reasoning support/options/default hints. It returns no credential, endpoint, provider body, routing, pricing, arbitrary metadata, or tool declaration and persists nothing. Protocol and hosted tools remain explicit administrator choices; selecting a row may apply only those safe hints to the local draft.

Entitlement and credential assignment remain independent. `ProviderUserCredentialAssignment` has one row per `(connection, user)` and its composite foreign key guarantees that the selected credential belongs to that connection. Effective credential resolution first selects the direct-user assignment when present; otherwise it collapses identical assignments across non-archived groups and fails `credential_assignment_ambiguous` for distinct overlaps; only then may it use the connection default when policy permits. A selected missing, disabled, versionless, or revoked credential fails closed without falling through to a lower-precedence tier. Catalog reads require enabled active configuration, the user's model/search grant, one usable effective credential, and a current exact `available` check; they perform no remote discovery and may legitimately return no default model.

Reviewed-provider Quick Setup atomically makes its exact verified credential the connection default after activation and keeps the acting administrator's direct assignment. This changes only the connection-default pointer: prior credential rows and assignments remain intact, while personal and installation model defaults remain independent and unchanged. Clearing the direct Quick assignment does not clear that connection default.

Answer catalog and admission require an active immutable model configuration declared answer-selectable. A technical-only deployment remains available only to its separate typed Search authority and is invalid for answer grants, profiles, defaults, catalogs, and direct answer admission even through `full_access`.

Provider deployments additionally carry an immutable persisted `answer` or
`embedding` class. Answer and technical Search reads filter the persisted
answer class before parsing active configuration. Embedding deployments reuse
the same connections, credential precedence, exact availability tuples, and
grant rows, but resolve through the separate embedding boundary; `full_access`
is still a wildcard and explicit provider/model grants still apply. An
embedding deployment can never become an answer default, Assistant target, or
system-model candidate. Embedding dimension and transport rules are owned by
[provider embeddings](EMBEDDINGS.md).

The installation system model resolver reuses answer admission's exact
connection/model snapshot and current credential/model check without applying
model entitlement. It resolves only the connection's explicit installation
default credential, regardless of ordinary unassigned-user policy; direct-user
and group assignments are never considered. The policy atomically stores an
optional reasoning effort with the selected deployment. A non-null effort must
be one of that deployment's currently advertised reasoning levels; retained
capability drift reports `system_model_unavailable` before utility execution
rather than silently using a different effort. Provider-default reasoning is
represented by null. The policy updater is audit
metadata and need not remain active, an administrator, or present. An empty
selection reports `system_model_absent`; any unusable exact target, default
credential, or check reports `system_model_unavailable`. No fallback model,
administrator, or credential tier and no catalog disclosure are allowed. This
boundary exposes the exact role, policy version, and reasoning choice for
internal consumers but does not itself create a run or define usage
attribution.

The secret-free administrator projection includes safe direct-user assignment identity and display facts alongside group assignments, so readiness and activation blockers cover the same referenced-credential set as the activation service. A tested replacement remains a credential draft until the administrator activates its connection; **Activate replacement** is the contextual UI action for that existing exact activation, not a key-only protocol. Confirmed deletion of a non-template `openai_compatible` connection runs as one retry-bounded serializable graph mutation: it clears user/chat model defaults, child installation-default and system-model policies with optimistic version advances, model grants, connection defaults, direct/group credential assignments, checks, versions, credentials, and models before the connection. Live/recoverable run bindings and per-call Memory execution bindings, Assistant-revision targets, provider-model-backed Search integrations, and code-owned templates remain hard blockers. Expired terminal Memory bindings detach only after their exactly-once usage row is durable; `OUTCOME_UNKNOWN` remains attached until honestly recovered. Other provider families retain conservative explicit child/reference removal.

Run admission revalidates this state in the same repeatable-read transaction that creates the run and stores the exact answer binding, ordered logical Search-option bindings with their selected physical route/revision, and any separately keyed technical Search provider bindings. Each provider binding contains the immutable non-secret endpoint/model/protocol/routing/reasoning-mapping snapshot, connection response deadline, optional model deadline override, and exact credential version. Connection deadlines are whole 5–900 seconds at the Admin boundary and integer milliseconds in versioned JSON; legacy/missing connection values normalize to 300 seconds, while a missing model value means inherit. The effective answer/provider-Search deadline is always resolved from the accepted snapshot as `model override ?? connection default`, never from current mutable configuration. Before every outbound provider or client-Search request, execution briefly locks/checks the credential version and decrypts it, then ends the transaction before network I/O; long-lived adapters retain only a non-secret placeholder. Ordinary RBAC/config changes affect only future admissions; emergency revocation serializes against that check and fails later outbound use closed. Saved bindings and Search revisions, not current configuration, drive continuation, provider-native cancel, and bounded recovery.

The model run input is created only after backend validation of opaque connection/deployment IDs, the complete Search plan, provider parameters, and attachment content blocks against the current user's catalog. Preparation starts from the answer deployment's active server-owned defaults and recursively overlays only validated per-run controls; for OpenRouter the complete routing/fallback/privacy object is server-authoritative and cannot be weakened by a direct request. Atomic run admission closes the preparation race and persists every exact binding before dispatch. PDF validation accepts either extracted-PDF support or `nativePdfInput`; original PDF bytes are loaded from private storage only for selected answer models with `nativePdfInput` and never copied into client Search requests. Run-route parameter validation rejects out-of-range, unsupported, ambiguous alias, or unknown posted params with `400 { "error": "invalid_run_params" }`; settings drafts are the only path that clamps operator-entered control values before saving.
