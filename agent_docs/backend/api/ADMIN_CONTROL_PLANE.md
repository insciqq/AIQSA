# BACKEND API — ADMIN CONTROL PLANE

Owner: Server API contract maintainers
Scope: Observable administrator transitions for team access, releases, providers, Search, Memory, and MCP.
Read when: Changing administrator users/groups/invites, release state, provider setup, Search configuration, Memory destination trust, MCP administration, or control-plane mutations.
Code owners: Administrator route handlers and repositories under `lib/server/admin/`, plus provider/Search/Memory/MCP admin owners.
Not owned here: Browser Control Center interaction, auth threat controls, current-user catalogs, or chat/run execution.

## Administrator Control Plane

All administrator routes recheck an active administrator. Non-admin users receive `403`; no administrator projection returns credential values, SMTP passwords, token hashes, secret envelopes, or raw provider/MCP diagnostics.

### Team and access

- The dashboard returns users, groups/grants, grantable catalog, rules, invites, deletion eligibility, provider-reported usage attribution, and a least-data navigation summary. Archived memberships may remain visible for attribution, while archived groups never grant effective access.
- Administrator actions own approval/rejection/disable, scoped or global session revocation, rules/invites, memberships/grants, guarded stale deletion, and group lifecycle. Disable/reject preserves owned application data. Self-disable, removal of the final active administrator, and deletion with active/owned/member/grant/invite hazards are rejected with stable structured codes. Memory-only ownership can enter deletion only through the composed account hook: admission fences first and still returns the ordinary owned-data blocker until its audited obligation succeeds; absent composition or with any unrelated owner, Memory is not mutated.
- User lifecycle settlement serializes on the user row so stale activation cannot overwrite a committed administrator decision. Approval/provisioning, access-rule replacement, invite creation, guarded deletion, membership replacement, and disable/reject with session revocation use atomic repository transitions. Group-grant replacement remains the documented sequential boundary.
- Invite mail is post-transaction. Mail unavailability or failure does not undo a created invite; the creation response still returns the only recoverable plaintext URL for manual delivery. The repository stores only its hash.

### Release awareness

- The separate release route compares the packaged version only with the fixed official AIQSA latest stable GitHub Release. It accepts no repository or URL from the caller, uses no GitHub credential, applies a bounded cached external read, and returns only current/latest/date/link facts or `unavailable`.
- Release lookup is optional and never affects liveness, readiness, or other administrator work. The route reports availability only; it cannot update, deploy, migrate, restart, or write configuration.

### Providers

- Provider configuration is administrator-only. Browser projections are write-only for secrets and expose safe connection, model, readiness, publication, and assignment facts. Exact active revisions and credential versions are accepted into runs so later configuration changes cannot alter historical execution.
- Reviewed-provider Quick setup is actor-relative and fenced by an opaque state token. Remote catalog/test work completes before one retry-bounded serializable commit. The commit creates or rotates the acting administrator's isolated credential assignment, makes that exact verified credential the connection default, and prepares reviewed deployments/checks/direct grants plus provider-owned Search configuration. A previous connection-default credential remains stored but is no longer selected as the default. The acting administrator's personal model default, the installation model default, existing connections, other users, groups, grants, credentials, models, and unrelated providers are preserved. Any preflight, stale-state, or post-write catalog-proof failure rolls back the whole mutation, including the connection-default transition.
- Quick setup replacement must preserve every existing canonical model still exposed to the actor, within the bounded policy set. Clearing Quick assignment removes only that direct assignment; it leaves the connection-default pointer, credentials, grants, model defaults, and team configuration intact.
- Custom compatible setup is discovery-first with manual fallback. Discovery is bounded, SSRF-safe, non-persistent, and returns only validated model IDs plus allowlisted hints. Setup tests every explicitly selected model before one atomic commit. Protocol, auth mode, reasoning mapping, hosted tools, answer eligibility, and private-network opt-in are explicit administrator choices rather than inferred from names.
- The singleton installation model policy is an administrator-only nullable recommendation for one exact deployment. Reads expose safe display/readiness facts and active answer-selectable candidates; version-bound set/clear mutations lock and revalidate the policy and target. Stale writes conflict, invalid/unavailable targets are rejected, and the policy grants no entitlement or credential. Individual model deletion reports the policy as a blocker; confirmed non-template connection deletion may clear a child policy reference only inside its guarded graph transaction.
- The separate singleton system model policy is administrator-only and pins one exact internal answer deployment. Its safe catalog shows the retained selection and credential-aware availability without exposing endpoint, credential, check, or entitlement data. Version-bound set/clear revalidates the saving actor as an active administrator and validates the target through its explicit installation default credential; the updater identity remains audit metadata only. Runtime resolution is independent of that actor's later status or existence and returns only the exact installation-scoped role or stable absent/unavailable state, never a fallback administrator, model, or credential tier. Model deletion reports the role as a blocker; confirmed non-template connection deletion may clear it only inside the guarded graph transaction.

### Search

- The Search control plane owns an ordered installation recommendation of zero to three active ready logical sources. A recommendation never grants access. Each source belongs to one exact provider connection; physical hosted/query-only routes are never separate preference, policy, or grant targets.
- Source changes coordinate the required physical draft, fixed query-only test, activation, and enablement lifecycle behind one administrator resource. Activation requires evidence for the exact draft and server-resolved connection/model/credential-version authority and publishes an immutable revision. The authority tuple remains server-only; safe responses expose only status, time, protocol, and normalized source count. Later draft edits do not change accepted runs. Admission persists both the requested logical option and selected exact physical route/revision.
- Technical-only provider deployments may back Search without becoming answer-model candidates. Safe projections may name dependencies but never reveal endpoints, credential identity/value, probe results, source URLs, raw provider bodies, or execution data.
- Embedding deployments are a separate immutable provider-model class. The existing Models task offers reviewed family-compatible presets and exposes native-to-target vector shape without secrets or mutable provider bodies. Activation validates embedding ids against their class-specific catalog; grants and `full_access` remain shared, while answer/default/system-model projections exclude the class.

### Knowledge

- The singleton installation Knowledge policy is administrator-only and optimistic-versioned. Its read/update projection contains only bounded retrieval candidate/result limits, score threshold, updater/time metadata, code-owned bounds, and effective read-only ingestion ceilings. It never returns private base, owner, publication, document, filename, passage, vector, generation, or receipt facts.
- Each future retrieval invocation resolves the current policy before embedding or search and persists the exact candidate limit, result limit, and threshold in its existing immutable receipt. A missing or invalid policy fails that tool invocation before provider I/O; migration, bootstrap, and seed create or repair only the missing default row and never overwrite an administrator's saved values.

### Memory

- `GET /api/admin/memory` returns a private/no-store, administrator-only,
  secret-free installation projection. Its health part uses only bounded
  `none/some/many/unknown` queue, provider-execution, lag, deletion, and
  overdue-Temporary labels; it has no owner drilldown, exact
  user activity, Memory/query/source text, or source identifiers. The same
  response retains consent mode, exact current/accepted aggregate fingerprints
  and policy versions, optimistic version, bounded acknowledgment actor/time,
  waiting-job count, and exactly four destination rows for answer provider,
  system Memory model, embedding, and remote reranker. A health-read failure
  returns an explicit unavailable aggregate without hiding the independently
  readable destination policy.
- `PATCH /api/admin/memory` accepts only `expectedVersion` and the observed `currentFingerprint`. It is available only in `ADMIN` mode, locks the singleton, recomputes current policy inside a serializable transaction, rejects stale or drifted observations, stores the canonical exact logical-role/destination set with audit metadata, increments the version, and kicks coordinator reconciliation after commit. It does not mutate provider configuration, grant access, select a model, or weaken per-call binding and compatibility checks.
- Runtime admission checks the exact role/destination needed by each external Memory call. A new or changed destination waits with the existing consent-required outcome; unchanged acknowledged destinations continue. The aggregate admin projection may remain `Review required` for additions or removals until explicitly acknowledged. `PER_USER` retains the user-owned acceptance path and makes the admin projection read-only.

### MCP

- Installation MCP definitions, shared values, revisions, enablement, deletion, exact-name disabled-tool policy, and direct/group server grants are administrator-owned. The optional bounded `disabledToolNames` set lives in draft/revision JSON; missing or empty means no names are disabled, every other valid name defaults enabled, and temporarily absent disabled names are retained. `/api/me/mcp` returns only enabled, non-deleted servers with an active revision and an effective grant; users may toggle only those servers, supply only declared personal fields, and see only the active revision's effective enabled tools/count.
- Normal activation persists the definition and one durable activation job, returns `202`, and continues through a process-local leased coordinator. Stage/evidence/publication writes are fenced to the job, claim, draft hash, and shared-configuration version. A failed or superseded update never displaces the previous active revision.
- Advanced validation resolves request-only secrets, performs SSRF-safe remote or ToolHive-backed local discovery, and persists only sanitized evidence plus the complete upstream inventory, including tools disabled by candidate policy. An inventory containing any exact known credential is rejected before policy filtering. Raw MCP/ToolHive output is discarded except for narrowly classified safe issue codes.
- OAuth uses Authorization Code with S256 PKCE, same-origin browser handoff, allowlisted discovery/authorization origins, encrypted per-user or validation tokens, serialized refresh, and policy-fingerprint invalidation. Callback settlement must finish validation/activation or user enablement before reporting `connected`; callback outcomes expose no code, token, verifier, or raw provider response.
- Each effective user/server configuration gets a fingerprinted runtime generation bound to one immutable revision. Live sessions remain process-local; readiness, sanitized errors, safe credential-source labels, and only the effective enabled inventory are durable. Start/refresh validates complete discovery first, atomically publishes the filtered subset, and installs an exact-name pre-I/O call fence; zero effective tools is still ready. Accepted-run recovery reconstructs policy from the generation's historical revision rather than current mutable/active state. MCP/ToolHive failure is feature-local and does not fail core readiness.
- Deletion immediately hides and disables the server, prevents new grants/runs, drains accepted generations, and later removes the mutable configuration graph. Immutable accepted-run bindings and the minimum recovery/side-effect-safety tool-call records remain according to retention policy; presentation-only event history does not. There is no archive/restore workflow.
