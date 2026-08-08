# FRONTEND SETTINGS AND ASSISTANTS

Owner: Account and Control Center UI maintainers
Scope: Settings, MCP tools, Assistant discovery/editing/publication, focus, appearance, and project-setting interaction contracts.
Read when: Changing Settings, user MCP tools, Assistants surfaces, Assistant editing/publication, focus, appearance, or project settings.
Code owners: Settings and Assistant components, routes, stores, and client-side reconciliation.
Not owned here: Server Assistant authorization, Control Center administration, authentication, public sharing, or visual recipes.

## Settings And Assistants

### Settings and MCP tools

- Global Settings contains only Appearance and `MCP & tools`. It is reached directly from the desktop icon rail or through Account/Command palette, and remains a bounded dialog on roomy viewports and a safe-area-aware locally scrolling sheet on compact/short viewports. Unsaved MCP values require discard confirmation; an in-flight mutation blocks close or section replacement until it settles.
- MCP & tools lists only entitled enabled installation definitions with active revisions. Each row separately presents persistent Enabled/Disabled, readiness, setup/OAuth actions, administrator-enabled tool names, declared personal fields, and a safe account/workspace label. Disabled names and the complete upstream inventory are administrator-only; endpoints, commands, packages, environment/header targets, OAuth client policy, grants, and secret values never render.
- Several servers may be enabled together. The UI warns that conversation-derived data may reach tools and rejects a known effective enabled-inventory total above the 128-tool run limit, while the server remains authoritative for schemas, bytes, freshness, and races. A ready server with every discovered tool disabled remains ready but contributes zero tools.
- Readiness refreshes on entry, mutation/OAuth return, and visibility-aware polling while work is transient. `queued`, `starting`, `idle`, and `restarting` are working states; `Needs setup`, authorization, and runtime failure remain distinct actionable facts.
- The composer exposes one aggregate Tools entry. Unsupported model capability takes precedence; otherwise it reports Not configured, Disabled, Activating, a concrete blocker, or Enabled with ready-tool count. Persistent per-server enablement is edited only in Settings.

### Assistants

- Assistants is the authenticated full-screen internal discovery and sharing surface — menu label, heading, and document title all read `Assistants` — reached directly from the desktop icon rail, from Account, or from the Command palette, never a Settings subsection or rounded modal. It hosts only Assistants today; no empty future resource-type tabs render. It has explicit Back to chat, no scrim/backdrop dismissal, and browsing never applies an Assistant to the composer — only `Use` does, and `Use` navigates to the blank workspace with the exact revision selected without creating a chat until send.
- Discover and Yours share one avatar-prominent card grid with single-select filter chips (Pinned, groups, installation, unavailable; Yours adds Archived) and one bounded category filter. Cards disclose only runner-safe facts: name, description, capability fingerprint, publisher display name, authorized scope, category, exact published revision, availability, and a per-user pin toggle. An unavailable item stays visible with a privacy-neutral reason such as `Required access unavailable` and never reveals a hidden model, group, tool, or dependency name.
- Pinned Assistants are per-user server-stored preferences surfacing first in Assistants and the quick picker; pinning never changes access, publication, or the Assistant, and pin state never enters run evidence. Shared consumers get Use and Duplicate; duplication creates a private copy owned by the consumer. Owned cards additionally expose Edit, Version history, Duplicate, and Archive/Restore in an overflow menu.
- The identity-first editor owns avatar with browser-only `Generate another`, name, description (explicitly user-facing, never added to prompts), bounded category, system/developer instructions, model, run controls gated by the selected model's capabilities, the logical Search plan, the exact MCP server allowlist, up to four ordered starter prompts, and — in edit mode — Sharing. Save/create is the sole primary footer action; the header shows `Draft` before creation and `Revision N` afterward, and saving explains that existing runs keep the setup they used.
- Sharing pins exact revisions: any active user may publish an owned Assistant to groups with active membership, installation-wide publication is admin-curated, saving never advances a publication, `Publish update` moves it explicitly, and revoke neither archives the Assistant nor changes accepted runs. Version history is read-only with author, time, and changed sections; Restore creates a new revision from old content and never rewrites history.
- Loading, resource failure, no matches, and a true empty library are distinct. Editor validation attaches to its field with the stable server code; a CAS conflict reports that the Assistant changed in another session. Mutation failure preserves the list and dirty draft with readable retry/dismiss feedback.

### Focus, appearance, and project settings

- Settings uses dialog focus containment, Escape/backdrop close, opener restoration, and an inert shell. Assistants exits only through Back to chat and keeps the covered shell inert without a scrim. Both capture the exact direct-rail or Account invoker; if a responsive crossing hides that desktop-navigation opener, exit uses visible compact `Open workspace` and conditionally returns to the remembered desktop source under the shell focus-transfer rule. Nested confirmations own focus/Escape before returning to their surviving invoker.
- Appearance presents the palette registry in stable order: AIQSA, Graphite, Verdant, Classic Dark, Classic Light, Paper. It is a calm divided comparison list at every width. Selection applies immediately.
- Appearance selection delegates to the browser-local theme owner in
  [frontend implementation state](../IMPLEMENTATION_STATE.md); Settings neither
  persists an account preference nor reconstructs first-paint/hydration state.
- Project settings owns `Project instructions`, explains that they are supplied to project chats, and preserves modal focus, Escape, opener restoration, and dirty-confirmation behavior.
