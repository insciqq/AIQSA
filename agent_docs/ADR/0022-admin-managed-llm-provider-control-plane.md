# ADR 0022: Administrators Manage LLM Connections, Models, And Credentials

Status: Accepted
Amends: 0004-private-auth-entitlements-uploads-and-sharing, 0020-unified-installation-and-isolated-development, 0021-admin-managed-mcp-tools-and-isolated-runtime

## Context

AIQSA already stores its model catalog, model/search entitlements, user defaults, and run evidence in Postgres. Real provider clients are still assembled from `OPENAI_*`, `ANTHROPIC_*`, and `OPENROUTER_*` environment variables, and several routes capture that registry at module load. Adding or rotating an account, changing an endpoint, importing a model, or disabling a provider therefore requires deployment edits and a restart.

The current word `provider` also conflates product family, endpoint/account, wire protocol, model identity, entitlement target, and an OpenRouter downstream inference provider. That identity model does not safely support custom endpoints or different administrator-owned keys for groups.

The required operator workflow is:

- bootstrap the installation and sign in before configuring a paid provider;
- choose `Responses` or `Chat Completions` explicitly for a custom OpenAI-compatible model;
- configure OpenRouter through the common key -> model -> optional downstream providers path;
- use one default administrator-owned credential in the simple case and optionally assign other administrator-owned credentials to one or more groups;
- rotate or disable configuration without switching an already accepted run to another endpoint or account;
- preserve the exact account needed to retrieve or cancel an accepted native background run;
- keep ordinary users unable to submit or inspect provider keys, endpoints, protocols, headers, or definitions.

OpenAI recommends Responses for new projects while continuing to support Chat Completions. Their request, streaming, tool, output, and state contracts differ, so compatible authentication does not establish a compatible protocol. OpenRouter likewise exposes an account-filtered model catalog and model-specific downstream endpoints; its Responses surface is beta and stateless at the time of this decision. Mutable provider facts and source links live in `PROVIDER_API_NOTES.md`.

## Decision

### Ownership and adapter boundary

- Postgres becomes the sole normal-runtime authority for LLM connections, model deployments, credentials, group credential assignments, routing, testing, and enabled state.
- The environment retains infrastructure and roots of trust such as database/object-storage wiring, `AIQSA_AUTH_SESSION_SECRET`, `AIQSA_ENCRYPTION_KEY`, trusted application/proxy/cookie settings, initial-administrator and emergency-recovery inputs, global provider time/size/stream bounds, and development-only Fake QSA switches.
- Provider configuration lives behind a dedicated `/api/admin/providers` family and `Admin -> Providers`. Only an active administrator may create, test, activate, rotate, assign, disable, revoke, or delete these resources. `Model access` remains the owner of model and search entitlements.
- A server orchestration module outside `lib/server/providers/` resolves database state and constructs adapters. Provider adapters remain Prisma-free wire boundaries that receive an already validated immutable configuration.
- Adapter kind is a closed code-owned union. Initial real kinds are native OpenAI Responses, compatible Responses, compatible Chat Completions, Anthropic Messages, and OpenRouter Chat Completions. Administrators cannot install code, provide request templates, or supply arbitrary headers.
- Database state is resolved for catalog construction, run admission, execution recovery, and cancellation. Configuration changes require no application restart. Fake QSA remains authorized only by the existing deterministic test boundary and is never an administrator-created production fallback.

### Minimal identity and persistence model

AIQSA keeps stable resource identities but does not create revision history for every non-secret edit:

- `ProviderConnection` is one logical endpoint/configuration boundary. It owns a stable opaque ID, display/family metadata, enabled state, `use_default | require_assignment` policy for users without a group assignment, a nullable connection-local default credential, and bounded mutable draft plus active endpoint/network/auth configuration. External account identity belongs to the selected credential, not to the connection.
- `ProviderModel` is one selectable deployment under a connection. It owns a stable opaque ID independent of the upstream model ID, enabled state, and bounded mutable draft plus active upstream-model, adapter-kind, routing, capability, parameter, and discovery metadata. The same upstream model may exist under several connections or routing profiles.
- Connection and model rows use monotonically increasing draft and active configuration versions. Optional model diagnostics record the exact candidate tuple, while activation independently validates the still-current connection, models, and referenced credentials before atomically copying them into the active slots. Failed or stale work leaves the prior active configuration unchanged. There are no `ProviderConnectionRevision` or `ProviderModelRevision` tables and no endpoint/model rollback history.
- `ProviderCredential` is a stable administrator-owned, connection-local named resource with enabled state, one encrypted mutable draft, and an active credential-version pointer.
- `ProviderCredentialVersion` is the only immutable configuration-version resource. It owns one activation-validated purpose-bound encrypted secret, safe account-catalog evidence, and nullable `revokedAt`. Rotation keeps a new key in the mutable draft until activation validates and atomically selects a new version for future runs.
- `ProviderGroupCredentialAssignment` links one connection, one group, and one connection-local credential. A credential may be assigned to many groups, while `(connectionId, groupId)` is unique. The table has no priority and no polymorphic or reserved user principal; archived groups remain stored but are ignored by effective resolution.
- `ProviderModelCredentialCheck` stores the current authoritative `available | unavailable` result for one exact model, credential version, and active connection/model configuration-version tuple. Activation creates it from account-catalog membership; an optional exact active-tuple refresh may later replace it with bounded generation or OpenRouter route evidence, or attach only a sanitized transient-failure warning while preserving the prior result. It is availability evidence, not entitlement or billing authority, and no past result guarantees that a later request will succeed.
- `ProviderRunBinding` links one accepted model run role such as `answer` or `search` to the exact connection, model, credential, and credential version selected at admission. It also contains the bounded validated non-secret execution snapshot and safe source (`default` or `group`), plus a recovery horizon only when a provider-native handle requires it.

Provider-backed `SearchStrategy` rows reference a concrete stable search-model deployment. User/chat defaults and model-specific grants likewise move to stable deployment IDs. Catalog selection, settings, send, and regenerate contracts pass the opaque `ProviderModel.id`; provider family and upstream model strings are immutable display snapshots, never authorization or resolution identities.

Database constraints enforce the useful lineage directly: models, credentials, credential versions, defaults, assignments, checks, and run bindings cannot cross connections; active credential-version pointers remain parent-local; and `(modelRunId, role)` is unique. Bounded typed JSON may hold adapter configuration, but repository validation is not the only protection against wiring a key from one account to another endpoint.

### Drafts, testing, rotation, and deletion

- Editing an active connection, model, or credential changes only its draft and increments its draft version. An omitted secret preserves the draft value, a non-empty value replaces it, and clearing requires an explicit confirmation-gated operation; blank never means both preserve and clear.
- The credential `Test` action sends the current unsaved key to a bounded read-only account/model-catalog request. It does not persist the key or test evidence and returns only safe status, time, draft version, and model count. The browser enables Save/Rotate only while the tested input and connection draft version are unchanged; activation remains the server authority even if a caller bypasses that UI convenience.
- An optional model diagnostic snapshots the exact candidate connection/model versions and either the credential draft version being rotated or an unchanged active credential version. It performs network work outside a long database transaction and compare-and-set stores bounded candidate evidence only while that tuple is current. OpenAI, compatible, and Anthropic diagnostics make an explicitly confirmed tiny generation that may consume paid quota; OpenRouter inspects the selected model route. This evidence is advisory and never gates activation or overwrites active checks.
- Before activation, AIQSA resolves only the credentials referenced by the connection default or non-archived group assignments and calls each credential's bounded read-only model catalog exactly once. It derives every enabled model × referenced-credential `available | unavailable` row from those responses. Activation then atomically creates/selects any credential version, switches the relevant connection/model slots, and materializes the complete matching active check set. An invalid, unreadable, or unreachable credential blocks activation; a configured model absent from a valid catalog requires explicit administrator confirmation and remains unavailable for that credential. New runs see the new slots; accepted runs keep their saved snapshot and credential version.
- A current check stops matching when its credential version or active connection/model version changes. Adding or retargeting a default/group assignment performs no hidden remote call: an already matching exact check may be reused, otherwise the tuple stays unavailable until activation or an explicit active-tuple refresh creates one. That refresh uses the exact model diagnostic for the adapter; transient failure preserves a still-matching result and records only value-free attention. There is no discovery TTL, periodic refresher, catalog-triggered remote call, route-fingerprint matrix, or claim that any past check guarantees future generation or route availability.
- Ordinary Disable immediately excludes a connection, model, or credential from new catalogs and admissions. It does not interrupt an accepted run.
- Emergency credential revocation sets `revokedAt` and may clear that encrypted value after confirmation. Each outbound use briefly locks the exact credential-version row, checks `revokedAt`, and decrypts while that database transaction is open; the transaction ends before network I/O. Revocation uses the conflicting row update, so either plaintext was already loaded for that in-flight call or the use fails `credential_revoked`. No persistent use claim is created, and already loaded plaintext cannot be recalled.
- Old credential versions remain encrypted only while a non-terminal run or bounded provider-native recovery handle can still use them. A simple cleanup query may detach expired terminal bindings from live secret rows while retaining their safe snapshots. There are no per-call secret-use claims, general recovery leases, tombstone graph, or reconciliation-driven provider deletion protocol.
- Confirmation-gated deletion succeeds atomically only after grants, user/chat defaults, provider-backed search references, connection defaults, group assignments, active child configuration, and live/recoverable bindings have been explicitly removed or reassigned. Authorization/default/search references never silently cascade; bounded candidate/check evidence may. Otherwise deletion returns an actionable conflict and Disable remains available. Historical runs do not require the live resource after their safe snapshot is detached.
- Resource rows retain ordinary creation/update, test, activation, and revocation timestamps where applicable. This decision does not introduce a provider-specific append-only audit/idempotency subsystem; a future general administrator audit facility may cover sensitive mutations.

### Group credential resolution

Credential assignment is independent of RBAC entitlement: an assignment never grants a model, and a model/search grant never reveals or creates a credential. For one user and connection the resolver applies these rules:

1. Collect assignments from all current memberships in non-archived groups.
2. If every matching assignment names the same credential, collapse them to that credential.
3. If matching assignments name different credentials, return `credential_assignment_ambiguous` and make no provider call.
4. If no assignment matches, use the enabled default only under `use_default`; a missing default or `require_assignment` makes the connection unavailable to that user.
5. If the selected assigned/default credential is disabled, revoked, lacks an active version, or lacks matching activation-time catalog evidence, fail closed. Never fall through to another group or the default.

Archived groups stop contributing assignments to new catalogs and admissions. The Admin UI warns that this may move future runs to the default under `use_default` or make them unavailable under `require_assignment`. A group with any credential assignment cannot be hard-deleted until the assignment is removed; deletion never silently cascades it. Credential labels, assignment source, and private group membership remain administrator-only metadata.

The resolver accepts user and connection identities from the start, which is the future direct-user seam. A later administrator-owned `ProviderUserCredentialAssignment` may be checked before group assignments without changing model IDs, credential IDs, entitlements, or existing run bindings; an unusable direct assignment will fail closed rather than fall back to a group/default. The initial schema/API/UI contains no nullable user principal or inactive direct-user resolver branch, and ordinary users still cannot submit their own keys.

### Catalog, admission, execution, and search

- The current-user catalog combines enabled connection/model state, existing direct/group model entitlement, one unambiguous effective credential, and a current authoritative `available` `ProviderModelCredentialCheck` for that exact credential/configuration tuple. Activation-time catalog evidence or a later successful exact active-tuple refresh may supply that check. An authoritative `unavailable`, unreadable, missing, or non-matching result excludes the deployment. A transient refresh warning preserves a still-matching prior `available` result but cannot make a deployment available without one. Remote discovery is never called synchronously while reading the user catalog, and draft-only diagnostic evidence never grants availability.
- Connection-wide grants preserve the existing deliberately broad provider-grant behavior and cover present/future enabled models on that connection; model-specific grants target stable deployment IDs. Group credential assignments remain a separate dimension.
- A user or chat may legitimately have no available default model. Reconciliation does not silently select the first model.
- A provider-backed search-strategy entitlement authorizes that strategy's technical search deployment; it does not additionally require an answer-model grant for that hidden deployment. Its connection, effective credential, and model check are still resolved independently from the answer role. OpenAI native `web_search` remains part of the answer binding because it is a hosted capability of that same Responses request.
- Selecting a provider-backed search strategy creates its separate binding at admission even if the answer model may later choose not to invoke the search tool. Answer access or an answer credential never authorizes a global search key. Catalog and admission also validate the strategy against the exact answer deployment capabilities; search entitlement cannot bypass adapter or tool-calling compatibility.
- Run creation is the single authorization boundary. One `REPEATABLE READ` (or stricter) transaction with bounded conflict retry revalidates the active user, current grants, memberships, enabled connection/model/credential state, group/default resolution, successful current model checks, and all required answer/search roles, then persists the run and exact bindings before any provider call. No database transaction spans network I/O.
- Concurrent ordinary configuration or RBAC mutation may fall before or after that admission snapshot. A committed binding is accepted authority; later ordinary changes affect new runs. This avoids a global advisory/row-lock order across users, grants, memberships, assignments, and provider resources.
- Pre-admission preparation may carry bounded provider-neutral user/server context and opaque deployment IDs, but no mutable provider configuration. Admission derives one immutable execution snapshot from the same database snapshot, uses that exact object for capability/search validation and any model-dependent normalization, and persists it atomically with the run and bindings. Provider serialization, create, tool continuation, retrieve, refresh, provider-native cancellation, and recovery then use the saved snapshot and exact credential version. They do not re-resolve current grants, groups, active configuration, or another account. Provider failure never silently switches credential, connection, protocol, or downstream-routing policy.
- The existing run status/CAS and recovery boundaries coordinate provider recovery. A binding's bounded `recoverableUntil` keeps its credential version alive when needed; no provider-specific execution-claim table is introduced.
- The initial resolver constructs cheap adapter instances per accepted binding. If caching is added later, its key must include the complete non-secret execution fingerprint and credential version so different groups cannot share authenticated clients.
- The simple activation wizard may atomically create a model-specific direct grant for the active administrator performing setup. It never targets an operator group by mutable name or grants an ordinary group implicitly.

### Custom OpenAI-compatible endpoints

- A custom model requires an explicit `Responses` or `Chat Completions` dropdown choice; AIQSA does not infer protocol from authentication or endpoint shape.
- Endpoint configuration belongs to the connection, account identity to the selected credential, and adapter kind/upstream model to the model deployment. One endpoint and key may therefore support separate explicitly configured model deployments, with optional per-model diagnostics when needed.
- AIQSA stores a canonical API-root URL and derives reviewed terminal paths. URL userinfo, query strings, fragments, control characters, and embedded credentials are rejected; the UI shows the final request endpoint before testing.
- Native OpenAI Responses retains the reviewed stored/background/retrieve/cancel lifecycle. A generic Responses-compatible adapter starts stateless with manual context replay. Native storage, background recovery, hosted tools, prompt-cache hints, and other extensions require separate code-owned capability support and tests.
- Chat Completions has its own message, stream, tool-call, and response parser. It never receives OpenRouter-only routing, plugin, referrer, or session fields.
- The initial custom authentication mode is a server-owned bearer credential. Additional typed, reviewed modes may be added later; browser-supplied arbitrary headers are not supported.

### OpenRouter setup

The common Admin flow is deliberately small:

1. enter and Test an OpenRouter key, then save the write-only draft;
2. fetch the bounded account-filtered `/api/v1/models/user` catalog with that exact draft key;
3. choose and persist one model;
4. optionally fetch its endpoint list and choose one or more ordered downstream providers;
5. activate; optionally run the separate route diagnostic when exact downstream routing needs verification.

With no downstream selection, `Automatic` omits an allowlist/order and uses code-owned privacy/safety defaults. With a selection, `Only selected providers` sends the ordered provider slugs and denies fallback outside that set. There is no initial `Prefer selected providers` mode or general routing-policy editor.

Only selected models and bounded safe metadata are persisted; AIQSA never mirrors or grants the complete OpenRouter catalog. Activation checks every referenced group/default credential separately because one key's account-filtered discovery does not prove that another key can see the same model. Catalog membership does not prove a selected downstream route; the optional route diagnostic checks the configured endpoint tags without becoming an activation prerequisite. A later remote change produces a value-free provider/check failure rather than an automatic TTL-driven catalog state machine.

OpenRouter initially executes through its reviewed Chat Completions adapter. Its beta stateless Responses surface requires a later explicit adapter decision and is never selected automatically.

### Secret and egress security

- Provider and SMTP work use one server-only envelope v2: AES-256-GCM with a fresh nonce and authenticated context containing at least purpose, owning resource ID, and value/version identity. `AIQSA_ENCRYPTION_KEY` remains the base64 32-byte installation root, separate from session/flow signing and backed up separately from Postgres.
- Secret APIs are write-only and expose only safe configured/tested/activated metadata. Plaintext and ciphertext are excluded from browser contracts, normalized requests, previews, events, shares, analytics, errors, and ordinary logs.
- Existing MCP v1 envelopes are converted once while the application is stopped. The migration-only decoder decrypts each known record and re-encrypts it under its exact v2 purpose/owner/value context; unreadable input aborts the cutover. Normal runtime becomes v2-only, with no dual-read or read-repair path.
- Production external endpoints require HTTPS. A clearly warned connection policy may permit only the exact configured private/loopback origin for a reviewed local service. Metadata, link-local, multicast, unspecified, and other dangerous special-use destinations remain forbidden.
- DNS is resolved and checked immediately before each connection/reconnection, the socket is pinned to an approved address, and TLS verification stays bound to the configured hostname. Generation, discovery, test, upload, retrieve, and cancellation never follow redirects.
- Non-streaming bodies have cumulative byte and absolute-time limits. Streaming additionally bounds undecoded buffer/frame size, event count, cumulative bytes, idle time, and absolute lifetime. Remote catalog metadata and errors are untrusted and bounded; remote error text/code/body is discarded in favor of stable local codes plus HTTP status before persistence or user output.

### Offline full cutover

- This pre-production change is one stopped-application migration, not a compatibility window. A coordinated backup is taken first and the maintenance boundary holds the installation advisory lock. Old and new applications never run together.
- The migration creates the new schema, converts the existing provider/model catalog, grants, provider-backed search references, and user/chat defaults to stable connection/model identities, and leaves historical provider/model strings unchanged.
- Valid legacy provider environment values may be read only by the migration-only tools service, which receives those values and `AIQSA_ENCRYPTION_KEY` for the stopped cutover while the application runtime receives neither legacy provider secrets nor endpoints. They are imported as disabled, untested database drafts; import performs no network or paid request. Missing keys leave that provider unconfigured, while partial or structurally invalid input aborts with value-free field-class errors.
- The canonical official OpenAI API root imports as native OpenAI Responses. Any other legacy `OPENAI_BASE_URL` imports conservatively as compatible Responses with native storage, background, retrieve, and cancellation disabled. Legacy Anthropic and OpenRouter values map only to their code-owned adapter kinds.
- The same stopped migration completes the MCP v1-to-v2 envelope conversion and verifies that no v1 value remains before the new runtime starts.
- The release removes provider keys, base URLs, and OpenRouter application metadata from runtime Compose, `.env.example`, and installation documentation. The new runtime never reads them, even when database configuration is absent, disabled, or broken. Technical provider time/size limits and explicit smoke inputs remain environment-owned.
- A fresh installation starts with an administrable empty real-provider catalog; an active provider is not core readiness. Bootstrap may create code-owned adapter/model templates but never a runnable real credential.
- Failure is recovered by restoring the required pre-cutover backup, correcting the source state, and rerunning. There is no fallback, dual read/write, migration-acknowledgement setting, or permanent runtime cutover marker.

SMTP follows ADR 0023 rather than becoming a provider resource. Authentication-provider OAuth client credentials remain outside this decision.

### Required implementation evidence

Implementation is not complete without deterministic evidence for:

- active-admin authorization, ordinary-user denial, write-only v2 secrets, cross-context rejection, and offline MCP conversion;
- database-enforced connection/model/credential/check/binding lineage;
- group resolution with same-key collapse, different-key ambiguity, archived groups, both unassigned policies, and no fallback from an unusable selected credential;
- opaque deployment-ID selection, current-user catalog filtering, strategy/answer compatibility, independent answer/search admission, request-snapshot fencing, and exact saved bindings;
- draft-version fencing, rotation, Disable, revoke-versus-decrypt serialization, old-run recovery, and deletion conflicts without per-call claims;
- native Responses, compatible Responses, compatible Chat Completions, Anthropic, and OpenRouter adapter boundaries;
- write-only unsaved-key preflight, one bounded account-catalog request per referenced credential during activation, derived per-credential model checks, optional model/route diagnostics, and exclusion by unavailable/unreadable/missing/non-matching results;
- OpenRouter account-filtered discovery, Automatic/Only-selected routing, normalized downstream tags, bounded metadata, and the distinction between model-catalog presence and optional route diagnostics;
- endpoint normalization, private-network opt-in, connect-time DNS pinning, redirect rejection, body/stream bounds, and redaction;
- stopped full cutover, stable-ID data conversion, inactive env import, removal of runtime env authority, fresh empty-provider startup, and rollback without mixed authority.

Automated tests use fake transports and fixtures. A real provider smoke remains small, explicit, and subject to the standing provider-smoke rules; administrator-triggered paid tests disclose that side effect.

## Consequences

- Administrators can configure and rotate providers and models without deployment edits or restart, including separate administrator-owned keys for groups.
- Overlapping groups need no priority system: the same key collapses, while distinct keys fail visibly and safely.
- Stable identities, one credential-version history, and exact answer/search run snapshots preserve recovery and account isolation without connection/model revision tables, an availability refresher, global lock protocol, per-call leases, or a provider-specific audit subsystem.
- Custom OpenAI-compatible models choose Responses or Chat Completions explicitly, while native OpenAI Responses remains first-class.
- OpenRouter keeps the requested key -> model -> optional providers workflow and validates each referenced key once during activation rather than requiring a manual model-by-key matrix, mirroring the remote catalog, or running a freshness scheduler.
- A later administrator-owned direct-user credential assignment extends the resolver without redesigning model identity, entitlements, or historical run bindings.
