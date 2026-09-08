# FRONTEND

Owns presentation intent and interaction boundaries. Exact components, stores, copy, layout values, and test cases belong in [components](../components/AGENTS.md), [client-safe contracts](../lib/contracts/), and [design tokens](../styles/tokens-v2.css).

## State And Trust

- Keep one conversation-first presentation and one owner for each resource. Server pages authorize and send least-data props; views consume decoded client-safe contracts. Do not mirror server authority or the same async resource in component-local state.
- Key drafts, uploads, runs, and async work by their resource/chat/session. Capture the key at dispatch; abort or ignore stale results after navigation. Background refresh must preserve drafts, committed mutations, focus, selection, and scroll ownership. Malformed responses fail visibly instead of becoming guessed state.
- Identity, entitlement, catalogs, branches, lifecycle, and persisted preferences are server truth. Overlays, focus, unsent drafts, and in-flight handles are browser state. Theme is a browser presentation preference, not account/chat content.
- Loading failure is not an empty result. Pending, unavailable, disabled, revoked, degraded, cancelled, partial, and complete remain distinct. Elapsed time and animation never invent progress, readiness, evidence, cost, or completion.

## Conversation And Workspace

Chat and composer remain primary, navigation secondary. Preserve one reachable path to supported capabilities across desktop, compact, and mobile layouts. The concrete model is selected from the chat header; this message's tools belong near the composer. Assistants are opt-in; advanced next-run controls use bounded setup. Branches and output previews are temporary overlays, not pinned diagnostic columns.

The composer preserves one keyed draft and the user's explicit model, Assistant, tools, and run controls. Unavailable configuration never silently substitutes another target. MCP retry must not switch Auto to Load all without an explicit action. Editing a sent message uses its own inline draft, preserves sent attachments and the composer draft, and clearly creates a branch. Keyboard submission respects IME and multiline entry.

Upload integrity/ownership checks gate Send; slower PDF preparation does not. Successful admission immediately shows the committed message, clears its draft, and puts truthful preparation state with Stop/retry in the conversation. Counts describe accepted work, not elapsed time. Informational PDF notices do not require acknowledgement or disable Send.

An answer is a readable document: one process disclosure above the body, ordinary message actions below, Sources only when present, and generated downloads. Process details may show thinking, user-legible tool/server names, state, round, and duration. Past chats and Memory have independent bounded disclosures; their counts describe supplied context, not proven influence. Explicit Memory mutation feedback stays visible. Raw requests, tool payloads, retrieval scores, event histories, private identifiers, and per-answer usage are not hidden inspection surfaces.

Workspace has a deliberate exception for useful execution activity: structured file/command cards may show relative paths and bounded command output. Runtime identities and unbounded output remain private. Generated files have authenticated settled downloads that survive sandbox loss; `sandbox:` links resolve only to an exact file from that answer's run. Pending/failed exports remain truthful and never promise exhausted retries. Refresh preserves ready downloads and ends when outputs settle, navigation changes, or authorization is lost.

Workspace is a persistent chat toggle with server-projected availability, environment, and internet state. Only enabled Workspace broadens uploads to opaque files. Stop is non-destructive; branch changes/regeneration do not imply filesystem rollback. Reset names and confirms its filesystem consequence while preserving messages, attachments, and generated files. Download workspace is a separate action with its own result, not an LLM run. Saved-file reuse is explicit; filename similarity does not imply a version chain.

Project surfaces use only current Project catalogs. Loss of access clears stale selection and synchronization; personal fallback data must never masquerade as Project data. Shared refresh preserves local edits and shows only durably projected activity, without claiming online presence. Internal links do not create public shares. Project chats never enter personal history/Memory surfaces.

## Management

Control Center resources are URL-addressable pages. Add/edit sheets own focus and dirty-discard confirmation; ordinary navigation does not create a global save gate. Errors preserve fields, independent saves preserve other drafts, and refresh cannot undo a committed mutation. Destructive actions name their target and consequence. Secret fields explain preserve/replace behavior without echoing values.

Keep configuration where it is owned: provider deployments in Providers, role/default assignments in Defaults & roles, and health/limits in Knowledge & Memory. Knowledge profile activation/rollback explicitly acknowledges external processing and reindexing; accepted work keeps its frozen profile. Reprocess does not ask ordinary users to choose infrastructure.

Knowledge management shows current documents, readiness, access, and product actions. A usable artifact remains Ready; Needs attention requires an executable recovery action. Otherwise unavailable remains unavailable. Keep technical profiles, generations, chunks, scores, raw failures, and processing internals out of ordinary surfaces; support references are opaque. Separate Base membership changes from canonical document deletion, make multi-membership restore consequences explicit, and show permanent deletion as a durable pending operation. Technical retrieval failure never becomes “the documents contain no answer.” Authenticated citations may expose exact source/locator/excerpt context, without a diagnostic inspector.

Assistant editing changes live future use while historical answers retain accepted identity. Skills stay text-only and explicitly selected, with Assistant-included Skills read-only and manual selections separate. Do not introduce revision machinery, executable Skills, or automatic activation through presentation changes.

Keep inbound Memory clients in Connected apps, separate from outbound chat MCP servers. Consent names fact read/add/change/delete authority and excludes chat history; revocation removes access while preserving facts. MCP Active requires fresh protocol evidence, independent of permission to use it in chats. Opening Settings must not wake idle servers. Admin Test & Save validates before replacing active settings and preserves intentional disablement.

## Interaction And Visual Intent

- Preserve one navigation/state tree across widths. Respect safe areas, software keyboards, deliberate scroll ownership, and a composer that does not cover the last answer. No page-wide horizontal overflow: code, tables, math, and exceptional grids wrap or own local scrollers.
- Primary actions remain reachable without hover or precise dragging. Modals isolate the background, contain Tab, own Escape/nested-confirmation priority, and restore valid focus. Responsive transitions move hidden focus to a reachable control without losing drafts or selection.
- Dedicated WCAG certification is deferred; semantic labels, keyboard entry, touch access, readable overflow, focus safety, and reduced motion remain required.
- Keep a quiet reading workspace. Cyan is the control accent; violet marks answer activity, not controls/navigation. Hierarchy comes from placement, typography, and spacing. Avoid decorative cards around prose, badge carpets, idle animation, and diagnostic dashboards.
- Consume semantic tokens from `styles/tokens-v2.css`, not raw colors or local theme recipes. Use bundled Golos Text for prose and JetBrains Mono for code. Themes remain `system`, `light`, and `dark`; cookie state owns first paint, recognized LocalStorage may repair after hydration, and System follows the OS.
- Busy controls retain labels and reject duplicate submission. Errors remain associated with fields; empty/error states explain the next valid action. Motion communicates state and respects reduced motion; streaming does not animate layout.

For material UI changes, inspect affected Chat/Control Center states, light/dark, long content, narrow and short viewports, and relevant focus/breakpoint transitions using [Testing](TESTING.md). Assert behavior and geometry, not screenshots or component structure.
