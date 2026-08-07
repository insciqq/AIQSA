# FRONTEND PRODUCT AND LAYOUT

Owner: Frontend product-contract maintainers
Scope: Current UI capability, presentation boundary, accessibility scope, and functional responsive layout; visual recipes are routed by DESIGN_SYSTEM.md.

## Current Product Contract

The shipped UI is one Chat workspace and task-first Control Center presentation with direct composer controls, compact completed-answer evidence, unobstructed conversation actions, unified provider/Search administration, and explicit lifecycle state. Presentation may change only while server contracts, entitlements, run semantics, one store/action owner, and the complete capability inventory below remain reachable.

## Presentation Boundary

The current presentation is the only runtime view layer on the existing Next.js routes. Backend APIs, client contracts, domain modules, actions, and the focused workspace/thread/composer/run stores remain the only state owners unless a separately accepted decision changes them. There is no `/v2`, parallel API client, classic/new preference, hidden fallback renderer, or duplicate product state.

The source map and behavioral detail below describe the currently shipped implementation. Future UI changes consume the existing feature contracts and update this document in the same change; mockups or isolated components never establish current behavior. The bounded owners routed by `DESIGN_SYSTEM.md` are binding for visual work, while this file remains binding for behavior, state ownership, and responsive access.

## Deferred Accessibility Scope

Dedicated accessibility-conformance certification is not currently supported. Adding it requires an explicit product scope and acceptance contract; ordinary accessibility behavior remains part of every affected UI change.

## Primary UI

The first screen is the usable Chat workspace; there is no landing-page product. It uses direct controls, adaptive disclosure, a centered blank-chat start state, one composer-control owner, and the current Provider Quick setup. This file takes precedence over visual inspiration for behavior, state, and responsive UX; the bounded owners routed by `DESIGN_SYSTEM.md` own appearance.

After bootstrap, a zero-model state distinguishes authority. An administrator sees provider-setup language and a direct Control Center Providers action; a non-administrator sees the existing model-access explanation without an admin destination. Neither state redirects away from Chat or mounts a separate onboarding workflow.

## Capability Inventory

This table inventories reachability only. A UI change is incomplete if it
removes an applicable capability family or hides it without a discoverable
path; the linked bounded document is the sole owner of behavior inside that
family.

| Capability family | Reachable inventory | Normative owner |
| --- | --- | --- |
| Workspace and navigation | Chats, blank first-send creation, local/server search, favorites, nested folders/projects, project settings, per-chat live cues, command palette, and Account entry | [Navigation](composer/NAVIGATION.md) |
| Composer and attachments | Keyed drafts, edit mode, text/IME/keyboard input, PDF/image/text attachments, upload feedback, Send/Stop, and independent cross-chat work | [Composer](composer/COMPOSER.md) |
| Catalog and next-run controls | Entitled model choice, Search plans, optional Assistants, reasoning/background/Stream, visibility/sound preferences, temperature/output limits, Tools, and context disclosure | [Run controls](composer/RUN_CONTROLS.md) |
| Answers, artifacts, and branches | Run states, safe Markdown/code/math, Search/tool/citation/reasoning artifacts, copy/edit/regenerate/delete/branch actions, active-leaf checkout, thread sharing, and long-content containment | [Messages and Markdown](MESSAGES_AND_MARKDOWN.md) |
| Receipt and inspection | Message-bound run evidence, Branch and Events, recovery/error inspection, overlay access, and wide pinning; Run setup remains the next-run editor | [Receipt and Details](composer/RECEIPT_AND_DETAILS.md) |
| Authentication and public access | Password/OAuth entry, access requests, invites, verification/reset, session-expiry return, route-safe failures, and anonymous immutable public viewing | [Auth and public sharing](account/AUTH_AND_PUBLIC_SHARING.md) |
| Assistants and Settings | Discover/Yours, pins, create/revise/history/publication/duplication/archive, MCP & tools, appearance, and project settings | [Settings and Assistants](account/SETTINGS_AND_ASSISTANTS.md) |
| Control Center | Providers, Search, team/access, usage, MCP, email, safety, release awareness, and their complete administrator lifecycle tasks | [Control Center](account/CONTROL_CENTER.md) |
| Responsive shell | One conversation-first shell with persistent or on-demand Workspace, on-demand Details, safe overlays, coarse-pointer access, and no page-level overflow | [Layout](#layout) and [visual adaptation](../design_system/INTERACTION_AND_REVIEW.md) |

## Layout

Above `1280px`, Chat may use a persistent Workspace rail beside one conversation column. The conversation column owns its compact edge-action rail, thread, and composer; no global application bar spans the Workspace rail. The desktop action rail occupies a protected top-right footprint without a full-width surface, separator, or vertical header row. Narrow conversation columns yield that right-side inline space; wide centered reading content clears it naturally. Global Account access is pinned in a footer below the Workspace browse scroller, so session destinations stay with application navigation rather than conversation actions. At `>=1440px`, explicitly pinned Details adds a third normal-flow column without changing the answer's reading measure. Overlay Details never changes the grid. Exact geometry belongs to the bounded owners routed by `DESIGN_SYSTEM.md`.

```text
desktop: Workspace | conversation { edge actions, thread, composer }
wide pinned: Workspace | conversation | Details
compact: conversation + on-demand Workspace/Details overlays
```

At or below `1280px`, the edge-action rail floats over the conversation and
exposes adjacent Workspace and Start-new-chat actions in one bounded group. A
token-derived readability veil lets document content pass beneath without an
opaque header row. Workspace reuses the ordinary navigation pane as a
safe-area-aware modal drawer with explicit Close and one browse scroller;
[Navigation](composer/NAVIGATION.md) owns its action inventory and blank-chat
semantics. [Implementation state](IMPLEMENTATION_STATE.md) owns cross-breakpoint
closure, focus transfer, scroll preservation, and replacement-overlay
sequencing so only one modal layer remains active.

On wider screens the persistent Workspace rail has its own `Hide workspace` action. The same Workspace trigger remains visible after hiding and restores the rail instead of opening a modal drawer. That preference is browser-local, survives reload, preserves the existing Workspace/chat/folder state owners, and returns focus between the visible hide/show controls; it never changes account settings or server navigation state. Compact Workspace remains dismissible as its ordinary drawer regardless of the stored wide-screen preference.

The chat title is absent from visible conversation chrome; the selected Workspace row owns visible chat identity, and one visually hidden current-chat/`New chat` page heading preserves document structure without consuming the reading plane. Compact composition keeps Workspace, direct New chat, and truthful live Pipeline status in the edge-action rail; Account is reached through the Workspace drawer footer. Share, Details, and the secondary `Conversation actions` menu appear only after the conversation has at least one message; an empty start state does not advertise actions with no object. Once available, Copy thread and Branch tree share that one secondary menu at every width, while Command palette, Assistants, and Settings live as distinct Account destinations. There is no second thread toolbar, duplicated Account trigger, duplicated desktop action set, or replacement title chip. Below `sm`, the leading Workspace/New chat pair drops its visual gap and the decorative product identity stays absent so direct actions remain contained at the target portrait width. Account opens upward within Workspace and becomes locally scroll-bounded at short heights; its boundary subtracts the drawer's top and bottom safe areas so it cannot overlap the Workspace header. A thin scrollbar and bottom continuation cue make overflow explicit until the final actions enter view, while keyboard movement scrolls the focused item to the nearest visible position.

The browser document title follows the visible active chat, with `New chat` as the blank-workspace fallback. Settings and Assistants replace that title while they own the workspace; transient drawers, palettes, inspectors, sharing, and confirmations preserve the underlying chat title. Sign in and public share use fixed privacy-safe route titles, while Control Center adds only its fixed active section label; public snapshot content, bearer tokens, account identity, selected resources, prompts, and message content never enter metadata.

The responsive contract is verified at 384x844 portrait, 844x390 short
landscape, 768x1024 tablet, and 1280px compact width in addition to wider
desktop evidence. Width chooses shell composition; [Composer](composer/COMPOSER.md)
and [Run controls](composer/RUN_CONTROLS.md) keep their one information model
and choose their own disclosures from actual container/height. Rows wrap rather
than switch to a second hierarchy, browser zoom cannot force desktop-only
controls into a narrow column, and coarse-pointer actions retain the shared
touch target. Tablet and compact layouts remain conversation-first with drawer
navigation and bounded overlays rather than a cropped desktop grid.

[Run controls](composer/RUN_CONTROLS.md) owns Model, Search, Run setup, context
facts, and compact-reading semantics. The shell guarantees that their popovers
and setup surfaces stay viewport-contained with one local scroller: compact or
short compositions use safe-area sheets while eligible desktop disclosures may
remain anchored. Responsive presentation never creates a second draft,
next-run owner, or setup path.

`app/layout.tsx` opts into both `viewport-fit=cover` and `interactive-widget=resizes-content`. The shell uses `h-dvh`, fixed/dialog surfaces subtract `env(safe-area-inset-*)` on every relevant edge, and each tall bounded surface keeps one local scroll owner. Surfaces that would not fit a viewport at or below 32rem high—Run settings, model/assistant/finite pickers, Settings, and the command palette—switch to viewport-bounded sheet geometry. Assistants is the deliberate exception: it always owns a safe-area-aware full-screen surface with its own local scroll owners. This contract follows content-viewport reduction from the software keyboard instead of assuming a stable `100vh` or hiding controls behind the keyboard.

Details contributes no column while closed, one modal overlay plane when open,
or one normal-flow wide column when explicitly pinned at the routed breakpoint.
[Receipt and Details](composer/RECEIPT_AND_DETAILS.md) owns defaults, tabs,
opening, demotion, persistence, focus, and dismissal; this layout owner only
reserves the resulting plane without changing the answer measure.

Main areas:

- Workspace rail/drawer with searchable chat/folder navigation and a fixed Account footer;
- conversation column with a title-free edge-action rail, thread, and composer;
- on-demand Details overlay or wide-screen pinned inspection plane;
- Settings and command overlays;
- auth and public-share workspaces;
- grouped Control Center shell and its current destination.
