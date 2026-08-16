# FRONTEND

Owner: Frontend maintainers
Scope: Product composition, client/server state, responsive interaction, visual system, and UI trust.

## Product And Ownership

AIQSA ships one conversation-first presentation: Chat is primary, workspace navigation secondary, and Control Center manages installation resources. There is no parallel classic/new renderer, `/v2` product, duplicate API client, or hidden fallback UI. New composition must preserve applicable Chat, files, Search, Knowledge, Memory, Assistant, MCP, account/share, and administration capabilities through one discoverable path.

Server pages authenticate/authorize and pass least-data initial props. `lib/contracts/` owns decoded client-safe wire shapes. Focused workspace, thread, composer, run, Memory, Assistant, Knowledge, and admin stores/controllers own browser state and mutations; view components consume their contracts and callbacks. Do not mirror server authority, repository rows, or the same async resource in component-local state.

Async state is source-keyed. Capture the resource/chat/session key when work starts; settle only that key; abort or ignore stale results on navigation. Preserve independent chat drafts/uploads/runs, and do not let a late response overwrite a newly selected resource. Server responses remain authoritative after optimistic mutations; malformed payloads fail visibly rather than becoming guessed state.

Server data includes identity, entitlements, catalogs, chats/message branches, lifecycle/outcomes, resources, and persisted preferences. Browser-only state includes open overlays, focus return, hover/selection presentation, keyed unsent drafts, and in-flight handles. Theme is a browser presentation preference, never account/chat content.

## Chat Composition

The shell has one collapsible workspace sidebar and one reading column with thread over composer. Desktop may show the sidebar in normal flow; compact/mobile uses the same navigation as a modal drawer. Collapse removes it entirely rather than leaving a second icon hierarchy. New Chat remains reachable when collapsed. Branches, Settings, command search, and generated-output preview are temporary overlays/sheets, never pinned diagnostic columns.

The composer owns one keyed draft, attachment queue, edit mode, selected concrete model, optional Assistant, Search/Knowledge plans, manually selected Skills, supported next-run controls, Send, and Stop. Ordinary MCP choice is always visible as Auto, Load all, or Off; only an explicit user action changes that choice, while enabling/configuring servers remains a separate Settings action. An unavailable Auto discovery offers Retry in Auto and a distinct `Use Load all` action; mode changes only when the latter is clicked, and both actions start a new regeneration. Revisions, runtime generations, discovery epochs, and raw tool inventories are not ordinary composer concepts. Enter submits only under the current keyboard/IME contract; multiline editing and attachment progress/errors remain usable. Provider/model/control availability is server truth and no UI fallback silently changes the selected target.

Conversation content is a readable document, not a grid of cards or run receipts. User messages retain ordinary edit/branch/delete actions. Assistant messages expose normalized live state, answer text, safe Markdown/code/math, inline citations, Sources only when present, generated outputs, explicit mutation feedback, copy/regenerate/delete, and Branch navigation. Tool activity stays in the reading flow as one compact native disclosure: active work is visible, settled calls fold under a count, and a reached-limit warning remains visible outside the fold. It exposes only user-legible server/tool names, round, state, and duration; Search traces, request previews, tool arguments/results, retrieval scores, raw event timelines, and per-answer usage are not hidden inspector surfaces or a separate right-hand panel.

Loading failure is not empty state. Pending, unavailable, disabled, revoked, degraded, cancelled, partial, and complete remain visually and semantically distinct. Live labels come only from normalized lifecycle state; an active semantic status may use a restrained text shimmer, while elapsed time or animation never invents progress, confidence, sources, cost, or completion. Reduced-motion mode renders the same status without animation.

Auth, public share, Settings/Library, Memory, Assistants, Skills, Knowledge, and Control Center use the same ownership rules. The Skill Library is lazy: shell mount issues no list request, opening it loads metadata pages, search stays server-side, and full instructions load only for a chosen detail. Every owned or shared row opens that detail; selection uses a separate ordered Use/Remove action. Owners manage current audiences, blocked Unshare dependencies, and Delete impact from the detail without exposing revision/runtime terminology. The composer presents Assistant-included Skills as read-only and manual Skills as a distinct editable ordered set. Skills remain text-only with no code, tool, MCP-dependency, or auto-activation affordance. Installation policy owns positive-integer tool-call and tool-round defaults with no arbitrary UI maximum. The System Model surface distinguishes MCP Auto Ready, Verification required, and Not supported states; only the saved supported deployment that needs evidence offers the explicit charge-bearing verification action. Secret fields state preserve/replace behavior and never echo values. Resource rows open their primary detail directly; destructive actions name the target/consequence and confirmations are proportional. Public share renders only its sanitized read-only snapshot.

## Responsive And Interaction Contract

Composition follows available space and input capability, not device names. The current shell changes from normal-flow sidebar to collapsed layout and then a scrim-backed drawer at its owned breakpoints; source CSS/tests own exact values. Width never creates a second store, draft, selection, or navigation tree. Composer and overlays respect dynamic viewport, safe areas, software keyboards, and one deliberate local scroll owner.

The page has no horizontal overflow. Code, tables, formulae, long URLs, and exceptional data grids wrap truthfully or own named local scrollers. Composer stays in layout rather than covering the last answer. Coarse-pointer primary actions have comfortable touch targets, and no phone/tablet workflow depends on hover or drag precision.

Dialogs/drawers/sheets isolate the background, contain Tab where modal, own Escape/nested-confirmation priority, focus a deliberate entry control, and restore the opener when still valid. When a responsive transition hides focused navigation, focus moves to the reachable reopen control. Text, draft, run, and selection state survive geometry changes.

Dedicated WCAG certification is deferred, but semantic labels, keyboard-safe entry, focus ownership, readable overflow, responsive access, touch operation, and existing reduced-motion behavior are current contracts.

## Visual System

The character is a quiet, precise reading workspace—not a generic dashboard, decorative AI demo, or research debugger. Establish hierarchy with placement, measure, type, and whitespace; add a surface, separator, shadow, accent, or status color only when it communicates a distinct job or observed state. Avoid card grids around prose, badge carpets, ornamental gradients/glass, oversized hero copy, and permanent toolbars of every run control.

`styles/tokens-v2.css` is the sole palette-value boundary. Components consume semantic canvas/sidebar/surface/text/border/accent/status/radius/shadow/motion roles, not raw palette colors or local light/dark recipes. The product exposes exactly `system`, `light`, and `dark`; normalized cookie state owns first paint, recognized LocalStorage may repair it after hydration, and System follows the OS without becoming a third palette.

Use bundled Golos Text for UI/document prose and JetBrains Mono for code/identifiers/config. Answers keep a readable measure and generous line height; metadata remains legible rather than miniaturized. Use the established spacing/radius/depth tokens; reserve shadow for composer/floating overlays and pills for true compact status/filter/tag shapes.

Controls define applicable rest, hover, active, selected, disabled, busy, invalid, success, and destructive states. Busy actions keep their label and reject duplicate submission. Fields retain labels and associated errors. Empty/error states explain the next valid action. Motion communicates state/spatial origin, never decorates idle surfaces or animates layout during token streaming; reduced motion remains deterministic.

For material UI changes, inspect representative Chat and Control Center states in light/dark, long content, the smallest supported viewport, short landscape, and relevant breakpoint/focus transitions. Tests assert behavior, roles, state, containment, geometry, overflow, and theme—not screenshots or implementation shape. Select the lane in [Testing](TESTING.md).
