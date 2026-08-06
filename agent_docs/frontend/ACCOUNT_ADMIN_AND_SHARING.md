# FRONTEND ACCOUNT ADMIN AND SHARING

Owner: Account and Control Center UI maintainers
Scope: Functional interaction contracts for authentication, public shares, Control Center, Settings, the Assistants Library, and guarded navigation.

Visual tokens, geometry, and reusable recipes belong to `DESIGN_SYSTEM.md`. Server authorization, secret handling, and transactional outcomes belong to `SECURITY.md` and `backend/API_AND_AUTH.md`.

## Authentication Workspace

### Structure and modes

- `/login` is one restrained auth workspace on the answer-paper canvas, not a marketing page or generic SaaS card. Each sign-in, access-request, invite, verification, reset-request, reset-completion, and request-result mode owns the sole `<h1>`, its primary action, and only relevant secondary routes.
- Active bearer-proof precedence is verification, then reset, then invite. A completed proof or explicit return to ordinary sign-in removes the consumed parameter with history replacement while preserving a safe internal destination. A genuinely new proof tuple may activate a new mode; unchanged props never resurrect a retired proof.
- Access request collects no password. Direct invite acceptance collects display name and a new password without displaying or asking for the token-bound email. Verification and reset completion collect a new password. Successful invite acceptance enters the workspace through the returned session; verification may finish active or pending; reset success returns to sign-in.
- Sign-in and every password-establishing form provides a visible Show/Hide password control. Toggling preserves the value, mode changes conceal it, and autocomplete distinguishes current from new passwords.
- The normal workspace never exposes bootstrap tokens, recovery hints, fake open-registration promises, raw OAuth material, or server policy controls.

### OAuth and account continuity

- Normal sign-in shows Google and/or Yandex only when the server advertises that provider. OAuth preserves the same sanitized internal destination and is absent from invite, verification, and reset modes.
- Privacy-safe OAuth cancellation, provider failure, pending/denied state, or binding conflict returns to clean login UI with readable feedback. Raw provider errors, codes, tokens, and profile data never render.
- Password and OAuth identities for the same accepted normalized email resolve to the same account data and entitlements. The frontend never presents OAuth linking as a second workspace or parallel account.

### Mutation, error, and responsive behavior

- A pending mutation disables its fields, visibility toggle, submit, and mode navigation, and shows one specific working label. Duplicate submission and mode replacement are impossible until it settles.
- Local validation and backend/network failures use readable announced alerts while retaining stable backend codes in parentheses. Attributable credential fields are marked invalid and associated with the alert. Retryable failures preserve the active mode and applicable entered values.
- Access-request and reset-request success language stays enumeration-safe. It never claims that an account exists or mail was sent unless the server contract explicitly says so.
- Initial sign-in leaves focus under browser/user control. Deliberate mode changes and settled operations move focus to the next useful control. Mutation feedback remains in document flow near the owning action.
- At 390x844, short desktop, and landscape mobile, the workspace stays top-aligned, safe-area aware, vertically scrollable under the software keyboard, and free of page-level horizontal overflow. Primary and back actions remain reachable; semantic palette tokens preserve autofill contrast.

## Public Share

- `/s/[shareToken]` is anonymous and resolves the hashed token server-side. Missing, revoked, expired, and invalid links all render the same `Shared snapshot unavailable` result without owner, token, or reason detail.
- The page identifies AIQSA, `Shared conversation`, and `Read-only snapshot`; it renders one title and explains that the immutable branch neither updates nor changes the original. Blank titles safely become `Shared chat`.
- User turns keep the private thread's compact question treatment; answers remain full-measure document flow. The page has no provider/model metadata, message actions, composer, Details, branch controls, share management, authenticated-shell dependency, or promotional call to action.
- Rendering consumes only sanitized user/assistant text plus sanitizer-produced attachment-omission text. It never reads private message/share/run/object identifiers, raw provider material, secrets, or user/group data. Shared Markdown keeps safe links/citations and inert raw HTML/unsafe URLs.
- A branch containing hosted-answer Gemini grounded live-only provenance cannot be shared. The UI explains the limitation and never publishes a neutral storage placeholder as an answer; normalized query-only Gemini Search evidence follows the ordinary client-Search projection instead.
- Empty snapshots and empty turns use neutral deliberate fallbacks. Long prose, titles, links, tables, and code stay within the page; only table/code owners may scroll horizontally.

## Control Center

### Shell and navigation

- `/admin` is a dense operational Control Center using the product surface hierarchy, not a chat clone or consumer KPI dashboard. Loading and failure are explicit; last-good data survives refresh failure. Save, refresh, and error feedback stays with its owner and never exposes underscore codes or secret material.
- Navigation order is fixed:
  - AI setup: `Providers`, `Search`;
  - Team & access: `Users`, `Access & groups`, `Invites`, `Access rules`;
  - Operations: `Usage`;
  - Infrastructure: `MCP servers`, `Email delivery`;
  - Safety: `Safety`.
- Canonical section IDs are `providers`, `search`, `users`, `access`, `invites`, `access-rules`, `usage`, `mcp`, `email`, and `safety`. Legacy `groups` and `model-access` normalize to `access`; bare `/admin` opens Providers.
- Desktop has a persistent rail. Compact layouts show either the current task or a vertical All sections index with explicit Back navigation and browser-history ownership. There is no compact horizontal tab strip or topology-derived disclosure.
- Active administrators receive one discreet Account-menu route to Providers. Non-admin sessions get a centered denial state and do not request administrator resources.
- The header owns identity, administrator email, installed version when available, Return to chat, dashboard refresh, last-update, and global loading state. A strictly newer stable release may add a quiet fixed-repository release-notes link; unavailable/current state stays silent and the UI performs no update. Global session revocation belongs only to Safety.
- There is no Overview/KPI/attention dashboard. Pending users, missing access, open invites, and setup problems appear in their owning destinations.

### Shared resource interaction

- Users, Access & groups, provider Connections, Search, MCP, Invites, and Access rules use an index followed by a dedicated detail task. Index selection is explicit; no first row is auto-selected and no permanent split detail is required. Back restores the index context.
- A shared Control Center resource workspace retains index and detail together only when its own inline size meets the design-system split threshold; below it the explicit navigation state shows one pane. Opening an exclusive detail moves focus to its Back action, and Back restores the latest opening row or header action when it still exists. If a mutation removed that owner, recovery uses a live index action or the existing section-level operational fallback when an external dialog owns the transition.
- Long labels, addresses, technical IDs, and errors wrap in their owner. Wide comparisons may own a named local horizontal scroller, but compact Usage and resource navigation use native rows and never make the page itself horizontally scroll.
- Binary runtime resources use consistent facts: `Enabled` is positive, `Disabled` is a strong neutral status, and Enable/Disable are separate actions. Readiness, publication, grants, approval, archive, and selection remain independent concepts. A prerequisite action never hides the factual Disabled state.
- Destructive confirmation names the affected user/group/invite/session/server scope. The server remains authoritative for self-protection, final-admin, ownership, active-run, reference, and concurrency guards.

### Users, groups, invitations, and usage

- Users supports explicit status filtering/sort, pagination, group/access summaries, and last-session facts. Detail owns pending approval/rejection, memberships, effective entitlements, direct MCP/personal-slot grants, stale assignment cleanup, deletion eligibility, and scoped account/session actions. The acting administrator is marked and normal UI omits self-destructive actions.
- Pending approval shows verified identity and allows default-group selection before approval; rejection is destructive and confirmation-gated. Membership drafts state saved/unsaved status and only present Save as primary while a real valid change exists.
- Access & groups owns group Overview, Members, Models & search, and Tools. Ordinary groups support membership, rename/archive/delete, provider/model/Search/MCP grants, and scoped clearing. Archived groups stay inspectable but immutable and grant nothing.
- Exactly one `Full access` group is visibly built-in. Its membership remains editable, but lifecycle/resource coverage is read-only automatic current/future access. New users are not automatically enrolled; credential assignment and personal/OAuth secret ownership remain separate from entitlement.
- Invites owns one-off creation, email-by-default with explicit link-only delivery, the fresh one-time link, filters, default groups, open-invite revocation, and stale revoked/expired deletion. Delivery states are truthful, and every creation outcome keeps the unrecoverable-later URL available for immediate copy.
- Access rules owns durable exact email/domain admission, normalized preview, default groups, search, and confirmation-gated deletion. It explicitly distinguishes durable policy from one-off invites.
- Usage is read-only provider-reported operational attribution, not billing reconciliation. It shows input/output/cached/cache-write/reasoning/total/last-use facts where available. Failed/cancelled runs count only when usage was reported; detached historical usage may outlive run-count rows; users in multiple groups contribute to each current group attribution.

### Providers

- Providers has two persistent peer tasks: Quick setup and Connections. They retain independent lazy resource owners. Quick setup does not mount the full Connections controller; returning to Quick setup clears write-only drafts and refetches its actor-relative projection.
- Quick setup starts with OpenAI, Anthropic, Gemini, OpenRouter, and Custom/OpenAI-compatible choices plus a least-data configured-connections summary. Reviewed providers use an empty write-only key and one Test & Save flow. One feedback owner announces Test & Save, model choice, refresh/reconciliation, ready, failure, and assignment-clear outcomes once; visual receipts remain readable without becoming competing live regions. A provider credential/catalog rejection is associated with the write-only key field, while network, stale-state, authorization, and other global failures are not. Provider change, task exit, success, and unmount clear the secret; retryable failure may retain it locally.
- Successful OpenAI, Anthropic, and Gemini Quick setup creates one friendly provider-owned Search source and immediately publishes its hidden hosted/query-only routes from the reviewed capability declaration, pinning query-only execution to an exact eligible deployment. The visible sources are `OpenAI Search`, `Anthropic Search`, and `Google Search`; no flow performs a paid Search request or creates a second Search card during replacement, credential rotation, or recovery.
- Reviewed setup displays only server-returned candidate choices and readiness facts. `Not configured`, `Disabled`, `Needs attention`, and `Ready` remain distinct. A candidate-selection response moves focus into the choice and resubmits the retained secret; Ready names installed models and exact server-reported default/profile consequences. Removing My key assignment is confirmation-gated and states that shared access may remain or disappear.
- Custom setup is discovery-first with manual fallback. It accepts an API root, explicit auth, selected model IDs, protocol, and bounded reviewed capability controls. Discovery evidence is tied to the current endpoint/auth/secret inputs and is discarded when they change. Up to 32 explicitly ordered models may be selected; every model is tested and nothing is saved unless all pass. Hosted search requires Responses and its declared capability directly creates the one connection-scoped Search source; image-generation capability is recorded as future-only, not advertised as runnable chat behavior. Private/local keyless Chat or Responses requires explicit opt-in.
- Connections is the complete provider control plane. Its detail owns credentials, authentication policy, models, diagnostics, activation, lifecycle, and destructive deletion. Secrets remain write-only; credential assignment does not grant model entitlement. Model drafts explicitly choose answer eligibility, protocol, reasoning mapping, and hosted tools. Deletion names all removed configuration and returns to the index; Assistant-revision, Search, and accepted-run references remain explicit server blockers.

### Search, MCP, email, and safety

- Search is a top-level peer of Providers. One catalog/detail card represents one exact provider-backed source, while the hosted/query-only route choice stays hidden and server-owned. Its tasks are Overview, Configuration, and Diagnostics. Save publishes eligible configuration immediately; a fixed-query connectivity check is optional diagnostics and never unlocks, disables, or activates the source. Rows keep separate availability and readiness facts; access mutation remains in Access & groups.
- Search configuration may select an eligible model on that same source connection and owns bounded result, query, and timeout controls. Its compact `Advanced Search execution` disclosure additionally owns the technical model, query-only output budget, reasoning policy when that adapter supports one, and maximum Search invocations per answer. These controls describe one logical source in user terms and never expose credentials, credential versions, hosted/client modes, provider-neutral wording, adapter/route identity, or cross-source fallback. They affect only cross-provider query-only execution; same-connection hosted Search remains part of the selected answer request and uses that request's controls. The provider vault resolves each user's current effective credential and availability at catalog/admission time, then the accepted run pins the exact authority. The core route is `User source → admitted hidden route/revision → answer model`.
- Search labels name the source, not its transport. Users and administrators see one official `OpenAI Search`, one `Anthropic Search`, one `Google Search`, and one `<connection name> Search` entry for each custom OpenAI-like connection; they never choose or inspect hosted/query-only modes, route ids, or revision ids in ordinary controls. Provider setup owns those sources, so the manual Add flow does not ask administrators to create a duplicate. The server resolves all selected sources as one complete hidden route assignment: it prefers eligible same-connection hosted execution only when the requested mode and every client Search/MCP tool can coexist, otherwise it uses that same source's exact active query-only route and sends only the bounded generated query. Thus any query-only source can serve Anthropic, OpenAI, Gemini, OpenRouter, or another entitled tool-capable answer model and can participate in multi-source plans without becoming a second card. Missing readiness never substitutes another connection or silently drops a source.
- MCP servers is the sole installation-definition editor. Import parses supported URL/JSON/package/container forms but never executes pasted text. Imported secret fields become write-only review values and raw paste clears after successful parse. Normal activation is one durable commit that returns while background setup continues; the detail/catalog show its real stage and permit navigation.
- MCP detail keeps Overview, Definition, Validate & tools, Revisions, Runtime, and Delete as one horizontally scrollable peer-task line; it never adds another vertical task rail beside the server catalog and global Control Center rail. It owns lifecycle, OAuth, rebuild/rollback where artifacts exist, and irreversible deletion. Previous active revisions remain usable during a failed/pending update. Raw process output is never rendered. Local runtime copy warns that trusted Docker-host administrators can inspect effective environment and that local workloads have unrestricted outbound networking.
- Email delivery owns one installation SMTP draft and active snapshot. Draft, active lifecycle, and health are distinct. Before activation it is `Not configured`, not falsely Disabled. Passwords remain write-only; Save, one-recipient Test, Activate, and Clear are explicit version-bound actions. Plaintext SMTP requires a fresh exact-relay acknowledgement after every draft change.
- Safety isolates global session revocation and states that the acting administrator's current session may be included. User-level revocation stays in user detail.

## Settings And Library

### Settings and MCP tools

- Global Settings contains only Appearance and `MCP & tools`. It is a bounded dialog on roomy viewports and a safe-area-aware locally scrolling sheet on compact/short viewports. Unsaved MCP values require discard confirmation; an in-flight mutation blocks close or section replacement until it settles.
- MCP & tools lists only entitled enabled installation definitions with active revisions. Each row separately presents persistent Enabled/Disabled, readiness, setup/OAuth actions, discovered tool names, declared personal fields, and a safe account/workspace label. Endpoints, commands, packages, environment/header targets, OAuth client policy, grants, and secret values never render.
- Several servers may be enabled together. The UI warns that conversation-derived data may reach tools and rejects a known inventory total above the 128-tool run limit, while the server remains authoritative for schemas, bytes, freshness, and races.
- Readiness refreshes on entry, mutation/OAuth return, and visibility-aware polling while work is transient. `queued`, `starting`, `idle`, and `restarting` are working states; `Needs setup`, authorization, and runtime failure remain distinct actionable facts.
- The composer exposes one aggregate Tools entry. Unsupported model capability takes precedence; otherwise it reports Not configured, Disabled, Activating, a concrete blocker, or Enabled with ready-tool count. Persistent per-server enablement is edited only in Settings.

### Library

- The Library is the authenticated full-screen internal discovery and sharing surface, reached from Account or the Command palette, never a Settings subsection or rounded modal. Its only shipped resource type is Assistants; no empty future type tabs render. It has explicit Back to chat, no scrim/backdrop dismissal, and browsing never applies an Assistant to the composer — only `Use` does, and `Use` navigates to the blank workspace with the exact revision selected without creating a chat until send.
- Discover and Yours share one avatar-prominent card grid with single-select filter chips (Pinned, groups, installation, unavailable; Yours adds Archived) and one bounded category filter. Cards disclose only runner-safe facts: name, description, capability fingerprint, publisher display name, authorized scope, category, exact published revision, availability, and a per-user pin toggle. An unavailable item stays visible with a privacy-neutral reason such as `Required access unavailable` and never reveals a hidden model, group, tool, or dependency name.
- Pinned Assistants are per-user server-stored preferences surfacing first in the Library and quick picker; pinning never changes access, publication, or the Assistant, and pin state never enters run evidence. Shared consumers get Use and Duplicate; duplication creates a private copy owned by the consumer. Owned cards additionally expose Edit, Version history, Duplicate, and Archive/Restore in an overflow menu.
- The identity-first editor owns avatar with browser-only `Generate another`, name, description (explicitly user-facing, never added to prompts), bounded category, system/developer instructions, model, run controls gated by the selected model's capabilities, the logical Search plan, the exact MCP server allowlist, up to four ordered starter prompts, and — in edit mode — Sharing. Save/create is the sole primary footer action; the header shows `Draft` before creation and `Revision N` afterward, and saving explains that existing runs keep the setup they used.
- Sharing pins exact revisions: any active user may publish an owned Assistant to groups with active membership, installation-wide publication is admin-curated, saving never advances a publication, `Publish update` moves it explicitly, and revoke neither archives the Assistant nor changes accepted runs. Version history is read-only with author, time, and changed sections; Restore creates a new revision from old content and never rewrites history.
- Loading, resource failure, no matches, and a true empty library are distinct. Editor validation attaches to its field with the stable server code; a CAS conflict reports that the Assistant changed in another session. Mutation failure preserves the list and dirty draft with readable retry/dismiss feedback.

### Focus, appearance, and project settings

- Settings uses dialog focus containment, Escape/backdrop close, opener restoration, and an inert shell. The Library exits only through Back to chat and keeps the covered shell inert without a scrim. Nested confirmations own focus/Escape before returning to their surviving invoker.
- Appearance presents the palette registry in stable order: AIQSA, Graphite, Verdant, Classic Dark, Classic Light, Paper. It is a calm divided comparison list at every width. Selection applies immediately.
- Theme is browser-local UI state: LocalStorage is primary after hydration, mirrored to the same-site theme cookie for server first paint. Invalid local state yields to the validated server theme; runtime updates set theme and color-scheme together. Theme is not account, prompt, or conversation data.
- Project settings owns `Project instructions`, explains that they are supplied to project chats, and preserves modal focus, Escape, opener restoration, and dirty-confirmation behavior.

## Change Rules

- Preserve authorization and least-data boundaries; client affordances never replace server enforcement.
- Keep resource facts, readiness, publication, entitlement, and action state distinct.
- Keep compact navigation and focus recovery operable at 390x844 and 844x390 without page-level horizontal overflow.
- Update this document for durable account, admin, share, Settings, or Library behavior. File wiring and implementation chronology belong in source and focused tests.
