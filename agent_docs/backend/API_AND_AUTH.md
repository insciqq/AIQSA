# BACKEND API AND AUTH

Owner: Server API contract maintainers
Scope: Current route-family ownership and observable server-side auth, admin, catalog, chat, run, upload, MCP, Search, settings, and share transitions.

## Backend Goals

The backend supports a transparent QSA workflow without becoming a generic agent platform. It owns:

- password and optional Google/Yandex OAuth authentication, access requests, direct invites, verification, reset, revocable sessions, and administrator recovery;
- user/group entitlements and administrator control planes for providers, Search, run profiles, SMTP, and MCP;
- backend-filtered catalogs and saved user defaults;
- persistent folders, chats, message branches, prompt presets, runs, attachments, shares, usage, and inspection evidence;
- deterministic fake-provider execution plus OpenAI, Anthropic, Gemini, OpenRouter, and compatible-provider adapters;
- private upload processing and anonymous sanitized share snapshots;
- passive administrator-only awareness of stable public GitHub releases.

## API Ownership

The executable route inventory and methods live in `app/api/**/route.ts`; shared wire contracts and route tests own exact request and response shape. Do not maintain a second endpoint manifest in prose.

Stable route families are:

- health plus password/OAuth/onboarding/recovery authentication;
- current-user identity, catalog, settings, and MCP configuration;
- administrator users, groups, grants, rules, invites, providers, Search, run profiles, SMTP, MCP, release awareness, and usage;
- folders, chats, messages, prompt presets, model runs, and uploads;
- private share management plus anonymous public-share reads.

There are no standalone current-user provider, model, or usage control planes. User projections remain entitlement-filtered and separate from administrator configuration. Public operational health returns only `ok`, `ready`, or `not_ready`; readiness checks runtime security, Postgres, and private object storage without exposing dependency errors or configuration values.

All private routes resolve an active current user through the shared request-auth boundary. Browser mutations also pass the central same-origin guard. `SECURITY.md` owns cookie/session lookup, password hashing, admission limits, proxy trust, Origin rules, recovery exposure, and threat controls. This document records observable state transitions.

## Authentication And Onboarding

### Password sessions and recovery

- Login accepts normalized email/password credentials and returns one generic unauthorized result for invalid, unverified, inactive, or denied identities. Password verification happens before settlement; settlement locks and rechecks the exact identity state before creating a revocable database session. Password reset uses the same identity lock, so an obsolete password cannot create a post-reset session.
- Logout revokes the current session before clearing its cookie. Password-reset completion consumes the selected and sibling reset tokens, changes the password, and revokes all user sessions atomically.
- Reset request is enumeration-resistant. Eligible and ineligible plausible emails share the generic response and a small SMTP-independent response floor. An eligible token is persisted before bounded asynchronous mail delivery begins.
- The bootstrap-token route is hidden behind an explicit environment gate. Disabled recovery behaves as not found; enabled recovery maps only to the active seeded operator and creates the ordinary database-backed session type.

### Authentication admission

- Password, OAuth, onboarding, invite, verification, bootstrap, and reset entry/completion routes use the shared atomic durable PostgreSQL fixed-window admission boundary. Account/token protection is independent of client identity; an additional client bucket exists only when the configured overwriting proxy chain yields an exact validated identity, and missing identity creates no shared sentinel. `SECURITY.md` owns HMAC keying, proxy-chain validation, and enumeration-resistance threat controls.

### OAuth

- Google and Yandex entry routes exist only when both credentials for that provider are configured. A signed, short-lived transaction binds provider, state, nonce, PKCE, callback, and sanitized internal destination before code exchange.
- Google requires a valid OIDC ID token and verified email. Yandex requires the authenticated profile subject/default email and the configured client identity. Callback results reveal only stable privacy-safe codes.
- First use merges by normalized email into the existing user. Later sign-in is owned by the stable provider subject even if the provider email changes. Conflicting subject/email bindings, inactive users, and disallowed new users receive no session.
- OAuth never consumes an invite by matching its email. Invite-token acceptance remains the activation proof. Provider access, refresh, and ID tokens, authorization codes, PKCE verifiers, raw errors, and profile bodies are not persisted.

### Access requests, invites, and verification

- The registration endpoint is an access request, not public signup. It accepts no password, creates or reuses only an eligible unverified identity, replaces the prior open verification token, and returns a generic result without revealing account existence.
- Direct invite acceptance trusts the token-bound email, never a browser-supplied email. One transaction consumes the open invite, creates or completes the matching identity, sets the chosen password, verifies and activates the user with invite defaults, invalidates sibling verification links, and creates the first session. All invalid, expired, revoked, accepted, raced, or already-settled cases share the stable invalid-invite outcome.
- Email verification requires the one-time token and a new valid password. One transaction consumes sibling verification tokens, establishes the password identity, and applies any current access rule or invite. Without current admission, the verified user remains pending for administrator action.
- Verification, reset, and invited-user mail resolve one active database SMTP snapshot per send. Transport enforces the selected TLS mode and bounded deadline. Test capture takes precedence over real delivery; raw transport output is not exposed.

## Administrator Control Plane

All administrator routes recheck an active administrator. Non-admin users receive `403`; no administrator projection returns credential values, SMTP passwords, token hashes, secret envelopes, or raw provider/MCP diagnostics.

### Team and access

- The dashboard returns users, groups/grants, grantable catalog, rules, invites, deletion eligibility, provider-reported usage attribution, and a least-data navigation summary. Archived memberships may remain visible for attribution, while archived groups never grant effective access.
- Administrator actions own approval/rejection/disable, scoped or global session revocation, rules/invites, memberships/grants, guarded stale deletion, and group lifecycle. Disable/reject preserves owned application data. Self-disable, removal of the final active administrator, and deletion with active/owned/member/grant/invite hazards are rejected with stable structured codes.
- User lifecycle settlement serializes on the user row so stale activation cannot overwrite a committed administrator decision. Approval/provisioning, access-rule replacement, invite creation, guarded deletion, membership replacement, and disable/reject with session revocation use atomic repository transitions. Group-grant replacement remains the documented sequential boundary.
- Invite mail is post-transaction. Mail unavailability or failure does not undo a created invite; the creation response still returns the only recoverable plaintext URL for manual delivery. The repository stores only its hash.

### Release awareness

- The separate release route compares the packaged version only with the fixed official AIQSA latest stable GitHub Release. It accepts no repository or URL from the caller, uses no GitHub credential, applies a bounded cached external read, and returns only current/latest/date/link facts or `unavailable`.
- Release lookup is optional and never affects liveness, readiness, or other administrator work. The route reports availability only; it cannot update, deploy, migrate, restart, or write configuration.

### Providers and run profiles

- Provider configuration is administrator-only. Browser projections are write-only for secrets and expose safe connection, model, readiness, publication, and assignment facts. Exact active revisions and credential versions are accepted into runs so later configuration changes cannot alter historical execution.
- Reviewed-provider Quick setup is actor-relative and fenced by an opaque state token. Remote catalog/test work completes before one retry-bounded serializable commit. The commit creates or rotates only the acting administrator's isolated credential assignment, reviewed deployments/checks/direct grants, conditional default, and at most one untouched profile recipe. Existing connections, other users, groups, grants, credentials, models, defaults, and unrelated providers are preserved. Any preflight, stale-state, or post-write catalog-proof failure rolls back the whole mutation.
- Quick setup replacement must preserve every existing canonical model still exposed to the actor, within the bounded policy set. Clearing Quick assignment removes only that direct assignment; it does not delete credentials, grants, defaults, or team configuration.
- Custom compatible setup is discovery-first with manual fallback. Discovery is bounded, SSRF-safe, non-persistent, and returns only validated model IDs plus allowlisted hints. Setup tests every explicitly selected model before one atomic commit. Protocol, auth mode, reasoning mapping, hosted tools, answer eligibility, and private-network opt-in are explicit administrator choices rather than inferred from names.
- Run profiles are the fixed Fast/Balanced/Deep slots. Updates submit all three versioned rows, revalidate each enabled deployment/reasoning tuple, and commit atomically. Missing/duplicate slots are invalid, unsupported targets are unprocessable, stale versions conflict, and a referenced deployment cannot be deleted.

### Search

- The Search control plane owns an ordered installation recommendation of zero to three active ready logical sources. A recommendation never grants access. Each source belongs to one exact provider connection; physical hosted/query-only routes are never separate preference, policy, or grant targets.
- Source changes coordinate the required physical draft, fixed query-only test, activation, and enablement lifecycle behind one administrator resource. Activation requires evidence for the exact draft and server-resolved connection/model/credential-version authority and publishes an immutable revision. The authority tuple remains server-only; safe responses expose only status, time, protocol, and normalized source count. Later draft edits do not change accepted runs. Admission persists both the requested logical option and selected exact physical route/revision.
- Technical-only provider deployments may back Search without becoming answer-model candidates. Safe projections may name dependencies but never reveal endpoints, credential identity/value, probe results, source URLs, raw provider bodies, or execution data.

### MCP

- Installation MCP definitions, shared values, revisions, enablement, deletion, and direct/group server grants are administrator-owned. `/api/me/mcp` returns only enabled, non-deleted servers with an active revision and an effective grant; users may toggle only those servers and supply only declared personal fields.
- Normal activation persists the definition and one durable activation job, returns `202`, and continues through a process-local leased coordinator. Stage/evidence/publication writes are fenced to the job, claim, draft hash, and shared-configuration version. A failed or superseded update never displaces the previous active revision.
- Advanced validation resolves request-only secrets, performs SSRF-safe remote or ToolHive-backed local discovery, and persists only sanitized evidence plus the complete inventory. An inventory containing any exact known credential is rejected. Raw MCP/ToolHive output is discarded except for narrowly classified safe issue codes.
- OAuth uses Authorization Code with S256 PKCE, same-origin browser handoff, allowlisted discovery/authorization origins, encrypted per-user or validation tokens, serialized refresh, and policy-fingerprint invalidation. Callback settlement must finish validation/activation or user enablement before reporting `connected`; callback outcomes expose no code, token, verifier, or raw provider response.
- Each effective user/server configuration gets a fingerprinted runtime generation. Live sessions remain process-local; readiness, sanitized errors, safe credential-source labels, and bounded complete tool inventories are durable. MCP/ToolHive failure is feature-local and does not fail core readiness.
- Deletion immediately hides and disables the server, prevents new grants/runs, drains accepted generations, and later removes the mutable configuration graph. Immutable accepted-run bindings, snapshots, events, and tool-call evidence remain. There is no archive/restore workflow.

## Current-User Catalog And Settings

- The catalog returns only entitled active answer models, ready entitled Search options, prompt presets, enabled system run profiles, saved defaults, resolved Search preference, presentation toggles, and client-safe capabilities. Technical-only models stay available to Search dependency resolution but are invalid answer-grant and admission targets and do not appear as answer choices, defaults, or profiles even for `full_access` members.
- An unavailable saved model remains persisted but projects as no default; the server never leaks its hidden identity or silently selects the first visible model. Unavailable configured profiles expose only a generic reason, not an undisclosed deployment.
- The organization Search recommendation is intersected with entitlement and never grants access. User Search state distinguishes inherited (`null`), explicit Off (empty plan), and an ordered personal preference. Model compatibility derives an ephemeral effective plan without mutating the durable preference.
- Settings updates validate providers, models, prompts, Search, and per-model control drafts against the same filtered catalog. The transaction locks the latest settings row and merges independent model keys, so concurrent accepted patches cannot overwrite unrelated drafts. Presentation toggles never enter normalized provider requests.

## Chats, Messages, And Runs

### Workspace and prompts

- Chat list/create/update/branch mutations return lightweight summaries with `messageCount` and `pinned`, not messages or usage. Detail reads own the message DAG, active leaf, safe artifacts, and latest assistant run IDs. Archived chats are hidden and non-operational; unarchive is not exposed.
- Folder operations are current-user scoped. Moves validate ownership and cycles in the same serializable transaction; deleting a folder promotes child folders and unsets chat folders through database relations.
- Prompt presets are current-user scoped. The current default cannot be deleted. Default, delete, settings, and chat-creation validation share a per-user advisory protocol so a run cannot persist a concurrently deleted preset. Selecting a prompt for one run does not change the user's persisted default.

### Send, branch, edit, and regenerate

- Send and regenerate share one server-only preparation boundary for ownership, branch context, entitlement, content/capability, prompt, controls, Search, attachments, MCP, context budget, and redacted preview. The resulting plain-data snapshot is isolated from adapter services and is not rebuilt after validation.
- Run creation locks and rechecks the chat, archive state, expected active leaf, active-run gate, settings, prompt, Search/provider configuration, credentials, and MCP generations before atomically creating messages, attachment links, run bindings, active leaf, and accepted defaults. Stale leaf or active-run races return stable conflicts without partial graph creation. External execution starts only after commit.
- Exactly one active run is allowed per chat; different chats remain independent. Edit, subtree delete, branch-chat, send, and regenerate use the same chat-first lock order and reject same-chat active-run conflicts.
- Editing creates a same-role branch fork. Subtree deletion moves the active leaf to a valid ancestor. Branch-chat clones the selected ancestor path and attachment rows while reusing protected private object bytes. Regenerate creates a sibling assistant branch from an assistant or unanswered user source and follows the same preparation/execution path as send.

### Tool execution and recovery

- Search and MCP share a provider-neutral continuation loop. The complete requested batch is persisted before bounded parallel dispatch and provider-order replay. Completed calls may be reused during recovery; a call left running across a crash is outcome-unknown and is never automatically repeated.
- MCP plans snapshot exact revisions, generations, fingerprints, schemas, namespaced tools, and safe account/source labels. Insert-time fencing rejects stale readiness or access atomically rather than silently dropping tools.
- Preferred Search intent and model-compatible effective execution are distinct. Run creation revalidates entitlement, compatibility, integration revisions, provider/model/credential state, and deterministic credential resolution before persisting immutable answer and Search bindings. Each actual engine invocation is a separate execution record.
- Provider continuations retain their accepted native transcript/checkpoint where supported. Private signatures and raw provider payloads never enter previews. Hosted-answer Gemini native grounding switches the run to live-only answer persistence; grounded content and signatures remain transient while neutral provenance/usage placeholders remain durable. Query-only Gemini client Search retains only its normalized findings/citations in the ordinary settled tool result and Search evidence.
- Live events provide immediate tool activity; authenticated chat/run reads project the same bounded, redacted durable tool-call evidence. Cancellation propagates best-effort abort but never claims external rollback.

### Inspection, terminal settlement, and cancellation

- Model-run reads reconcile stale/background state unless a live foreground controller owns the run. They expose only the shared client-safe preview, normalized events, usage, Search/tool evidence, artifacts, and stable errors. Provider refresh requires explicit provider-specific completion proof.
- Terminal completion, recovered failure, and cancellation compete through status-guarded database settlement so only one writer finalizes run/message/usage state. Retriable refresh contention falls back to the current persisted projection rather than failing the read.
- Cancellation first wins durable `cancelled`. Only the winner aborts the process-local controller and attempts bounded provider-native cancellation. A later provider ID is not published after cancellation; the discovering path performs the missing native cancel. If another terminal state won, cancellation returns a stable non-cancelable conflict and changes nothing.
- Foreground send/regenerate emits transient `chat_update` only after persistence and before `done`, allowing the browser to reconcile summary and canonical messages without another detail fetch.

## Uploads And Shares

- Upload authenticates before body consumption, acquires a non-queueing process-local permit, and byte-bounds the complete multipart envelope before platform parsing. It then validates ownership context, file size, extension/type, magic bytes or text content, and image/PDF complexity before persisting. Stable overflow/busy outcomes are `413 file_too_large` and `429 upload_busy`; permits release on every terminal path. Stored MIME derives from validated content, not the browser declaration. Text-like extraction is local and bounded; PDF work is page/time bounded and terminable.
- Object keys are unique per upload. If row creation fails after object storage, a durable cleanup job is staged before immediate best-effort deletion; failed cleanup remains retryable.
- Public shares are immutable sanitized snapshots. The token is hashed for lookup; create/read/revoke never exposes live private state. Missing, invalid, expired, or revoked tokens share one generic unavailable response.
- Public API/page reads reauthorize against the repository on every request, are force-dynamic, use private no-store and noindex/noarchive policy, and never cache revocation behind the framework or an intermediary. Hosted-answer native Gemini live-only grounded answers cannot be shared as placeholder content.

## Change Rules

- Preserve the shared auth/origin guards and least-data projections.
- Keep exact wire shape in `lib/contracts/**`, exact route inventory in source/generated reference, and exact transaction behavior in repositories/tests.
- Add behavior to existing domain, handler, repository, adapter, or coordinator owners before creating another runtime.
- Update this document only for durable route-family behavior or ownership. Implementation filenames and exhaustive endpoint details belong in source, generated inventories, and focused tests.
