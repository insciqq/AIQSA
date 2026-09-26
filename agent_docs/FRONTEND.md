# FRONTEND

Owns presentation and interaction rules. [Components](../components/AGENTS.md), [contracts](../lib/contracts/), and [tokens](../styles/tokens-v2.css) own implementation.

## State And Trust

- Keep one conversation-first presentation and one owner for each resource. Server pages authorize and send least-data props; views consume decoded client-safe contracts. Do not mirror server authority or the same async resource in component-local state.
- Key drafts, uploads, runs, and async work by their resource/chat/session. Capture the key at dispatch; abort or ignore stale results after navigation. Background refresh must preserve drafts, committed mutations, focus, selection, and scroll ownership. Malformed responses fail visibly instead of becoming guessed state.
- Identity, entitlement, catalogs, branches, lifecycle, and persisted preferences are server truth. Overlays, focus, drafts, and in-flight handles are browser state. Theme and bounded, account/resource-scoped disclosure choices are browser presentation preferences.
- Loading failure is not an empty result. Pending, unavailable, disabled, revoked, degraded, cancelled, partial, and complete remain distinct. Elapsed time and animation never invent progress, readiness, evidence, cost, or completion.

## Conversation And Workspace

Chat/composer stay primary across layouts. Models belong in the header, tools near the composer; Assistants are opt-in. Branches/previews are temporary overlays. Artifact previews open by user action in a closable side panel or compact full-screen sheet, preserving focus, draft and scroll across version changes.

The composer preserves one keyed draft and the user's explicit model, Assistant, tools, and run controls. Unavailable configuration never silently substitutes another target. MCP retry must not switch Auto to Load all without an explicit action. Editing a sent message uses its own inline draft, preserves sent attachments and the composer draft, and clearly creates a branch. Keyboard submission respects IME and multiline entry.

Continuation preserves controls/Workspace; copy drafts and settled attachments into its empty composer. Pending uploads/session work retain ownership. Focus without scrolling. Server model revalidation retains the source default for absent/unavailable selections. New chats use personal defaults; chat Search edits and sending never change them.

Upload integrity/ownership checks gate Send; slower PDF preparation does not. Successful admission immediately shows the committed message, clears its draft, and puts truthful preparation state with Stop/retry in the conversation. Counts describe accepted work, not elapsed time. Informational PDF notices neither require acknowledgement nor disable Send.

Server-confirmed final text releases Send during Workspace cleanup. Preparation belongs to the next accepted message; finished answers never appear to keep generating. Late events belong to their original answer and cannot overwrite the next request or draft. Branch/environment mutations respect execution ownership.

Answers show one process disclosure above the body, ordinary message actions below, Sources when present, and downloads. Process details show thinking, user-legible tool/server names, state, round, and duration. Past chats and Memory have bounded disclosures; counts describe context, not proven influence. Memory mutation feedback stays visible. Raw requests, tool payloads, retrieval scores, event histories, private identifiers, and per-answer usage are never inspection surfaces. Compaction exposes only server stage/outcome; settled cycles beat late progress, and the announcer speaks run phases and settled compaction outcomes. Working-context reductions are estimates, separate from provider usage.

Workspace cards show bounded output and relative paths, never runtime identities. Process/command details start collapsed, including errors/Stop; preserve manual disclosure choices. Show historical failures; overall warnings reflect unresolved answer, cleanup or export failures. Authenticated settled downloads survive sandbox loss; `sandbox:` links resolve exact files from that answer's run. Pending/failed exports never promise exhausted retries. Refresh preserves downloads; polling ends after settlement, navigation or access loss.

Each answer shows each artifact's latest successful version once, in first-appearance order. Historical cards and explicit selections never follow global current versions. Code previews stay bounded and inert until READY; thumbnails never execute scripts. Runtime repairs enter drafts through private tab state, never URLs.

Workspace is a persistent chat toggle projecting availability, session and read-only internet policy. Its chip and other controls wrap whole; no More menu or horizontal scrolling hides capabilities. Only enabled Workspace admits opaque uploads. Stop preserves files; branching/regeneration never rolls them back. Reset confirms filesystem loss while preserving messages, attachments and outputs. Download workspace is a separate non-LLM action. Saved-file reuse is explicit; matching names imply no version chain.
A continuation carrying Workspace projects its seed as pending, restored, skipped (source disk gone) or failed with a bounded reason. Failed/skipped copies open an empty Workspace, never claiming files survived; the private seed never appears as an attachment or staged input.

Agent is per-turn in personal chats, available mid-conversation with Workspace, administrator-enabled Internet and an eligible model. Explain restrictions; block incompatible sends without changing selections. Reuse chat activity/files; lifetime follows Workspace.

Project surfaces use current Project catalogs; access loss clears stale selection and synchronization without personal fallbacks. Shared refresh preserves local edits and shows only durable activity, never online presence. Internal links do not create public shares. Project chats never enter personal history/Memory.

## Management

Studio owns model behavior and resources: Assistants, Instructions, Skills, Knowledge, Memory, Files, Artifacts, MCP servers, Secrets and Chat defaults. Settings owns appearance, account, external-client permissions and personal data. Lists/editors belong on pages or sheets.

Control Center resources have URLs; add/edit sheets own focus and dirty-discard confirmation. Ordinary navigation has no global save gate. Errors preserve fields; independent saves preserve other drafts; refresh cannot undo committed mutations. Destructive actions name targets and consequences. Secret fields explain preserve/replace without echoing values.

Configuration owners: Providers for deployments, Defaults & roles for assignments, Knowledge & Memory for health/limits. Knowledge profile activation/rollback explicitly acknowledges external processing and reindexing; accepted work retains its frozen profile. Reprocess never asks ordinary users to choose infrastructure.

Knowledge management shows current documents, readiness, access, and product actions. A usable artifact remains Ready; Needs attention requires an executable recovery action. Otherwise unavailable remains unavailable. Keep technical profiles, generations, chunks, scores, raw failures, and processing internals out of ordinary surfaces; support references are opaque. Separate Base membership changes from canonical document deletion, make multi-membership restore consequences explicit, and show permanent deletion as a durable pending operation. Technical retrieval failure never becomes “the documents contain no answer.” Authenticated citations may expose exact source/locator/excerpt context, without a diagnostic inspector.

Assistant edits and Skill pins affect future runs. Auto/Off is independent of pins; personal Enabled preferences exclude Projects/Assistants. Assistant links stay read-only in the composer. Import needs no review gate. Show limits; omit revision/bundle editors.

Connected apps owns external-client permissions; consent and revocation name the resource. Memory consent covers fact read/add/change/delete, excluding chat history; revocation preserves facts. MCP enablement covers chats and authorized Hub clients. Active requires fresh protocol evidence independently of enablement; opening Studio or Settings never wakes idle servers. Admin Test & Save validates before replacement and preserves intentional disablement.

## Interaction And Visual Intent

- Preserve one navigation/state tree across widths. Respect safe areas, software keyboards, deliberate scroll ownership, and a composer that does not cover the last answer. No page-wide horizontal overflow: code, tables, math, and exceptional grids wrap or own local scrollers.
- Primary actions remain reachable without hover or precise dragging. Modals isolate the background, contain Tab, own Escape/nested-confirmation priority, and restore valid focus. Responsive transitions move hidden focus to a reachable control without losing drafts or selection.
- Dedicated WCAG certification is deferred; semantic labels, keyboard entry, touch access, readable overflow, focus safety, and reduced motion remain required.
- Keep a quiet reading workspace. Cyan is the control accent; violet marks answer activity, not controls/navigation. Hierarchy comes from placement, typography, and spacing. Avoid decorative cards around prose, badge carpets, idle animation, and diagnostic dashboards.
- Consume semantic tokens from `styles/tokens-v2.css`, not raw colors or local theme recipes. Use bundled Golos Text for prose and JetBrains Mono for code. Themes remain `system`, `light`, and `dark`; cookie state owns first paint, recognized LocalStorage may repair after hydration, and System follows the OS.
- Selection uses a readable primary foreground for ordinary text and preserves syntax colors on a softer code highlight. Interactive chrome and identity tiles are not selectable; copyable content and fields opt in. The code editor renders one text layer, with transparent input glyphs over syntax in ordinary themes and native selection colors with one readable layer in forced colors. Unsupported native selection styling needs no workaround.
- Segmented controls serve two or three fixed choices; catalogs use a select.
- Busy controls retain labels and reject duplicate submission. Errors remain associated with fields; empty/error states explain the next valid action. Motion communicates state and respects reduced motion; streaming does not animate layout.

For material UI changes, inspect affected Chat/Control Center states, light/dark, long content, narrow and short viewports, and relevant focus/breakpoint transitions using [Testing](TESTING.md). Assert behavior and geometry, not screenshots or component structure.
