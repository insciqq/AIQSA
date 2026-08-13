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
| Workspace and navigation | One collapsible sidebar, Chats, blank first-send creation, bounded server search, nested folders/projects, per-chat live cues, command palette, and Library/Settings entry | [Navigation](composer/NAVIGATION.md) |
| Composer and attachments | Keyed drafts, edit mode, text/IME/keyboard input, PDF/image/text attachments, upload feedback, Send/Stop, and independent cross-chat work | [Composer](composer/COMPOSER.md) |
| Catalog and next-run controls | Entitled model choice, Search and Knowledge plans, optional Assistants, reasoning/background/Stream, visibility/sound preferences, temperature/output limits, Tools, and context disclosure | [Run controls](composer/RUN_CONTROLS.md) |
| Answers, artifacts, and branches | Run states, safe Markdown/code/math, Search/Knowledge/tool/citation/reasoning artifacts and receipts, copy/edit/regenerate/delete/branch actions, active-leaf checkout, thread sharing, and long-content containment | [Messages and Markdown](MESSAGES_AND_MARKDOWN.md) |
| Receipt and inspection | Message-bound run evidence, Branch and Run details, recovery/error inspection, and temporary overlay access; Run setup remains the next-run editor | [Receipt and Details](composer/RECEIPT_AND_DETAILS.md) |
| Authentication and public access | Password/OAuth entry, access requests, invites, verification/reset, session-expiry return, route-safe failures, and anonymous immutable public viewing | [Auth and public sharing](account/AUTH_AND_PUBLIC_SHARING.md) |
| Memory, Assistants, Knowledge, and Settings | Personal Memory overview/management/history/operations, Assistant discovery/revisions/sharing, Knowledge base/document ingestion/reindex/publication/archive, MCP & tools, appearance, and project settings | [Settings, Memory, Assistants, and Knowledge](account/SETTINGS_AND_ASSISTANTS.md) |
| Control Center | Providers, Search, team/access, usage, MCP, email, safety, release awareness, and their complete administrator lifecycle tasks | [Control Center](account/CONTROL_CENTER.md) |
| Responsive shell | One conversation-first shell with a single collapsible sidebar, temporary drawers/sheets, safe overlays, coarse-pointer access, and no page-level overflow | [Layout](#layout) and [visual adaptation](../design_system/INTERACTION_AND_REVIEW.md) |

## Layout

The Reading Room replacement composes a single 260px sidebar and a calm
conversation canvas. The sidebar is one responsive presentation: it collapses
entirely on desktop and becomes one scrim-backed modal drawer on mobile, with
adjacent floating Open/New-chat recovery controls. It consumes the existing
workspace/composer/lifecycle owners plus the compact summary/search boundary;
it does not introduce a parallel chat, folder, run, or draft store. This is the
sole production presentation. The guarded fixture described by `TESTING.md`
exists only to render deterministic contract states and is not a selectable
product route or fallback renderer.

At `>=1024px`, the 260px sidebar is open by default and may be collapsed
explicitly. At `900–1023px` it starts collapsed and expands as that same
normal-flow sidebar; there is no alternate navigation hierarchy. Below `900px`
it is a left modal drawer with a scrim and the same content, while adjacent
floating Open/New-chat controls keep both primary actions reachable. The
`1280/1281px` boundary has no composition discontinuity. Branches, Run details,
and artifact preview remain temporary overlays at every width and become
full-viewport sheets below `900px`; none creates a pinned column or changes the
conversation measure.

```text
desktop expanded: sidebar | conversation { thread over composer }
desktop collapsed: conversation { floating Open/New chat, thread over composer }
900–1023 default: conversation { floating Open/New chat }
<900: conversation + on-demand sidebar/drawer/sheet overlays
```

The sidebar owns New chat and its Normal/Memory-off/Temporary choice, bounded
chat-title/folder search, date/folder groups, per-chat live cues, Library, and
Settings. Collapse removes the entire sidebar; it never leaves an icon rail.
The conversation has no duplicate title bar or navigation state. Compact and
mobile composition reuse the same sidebar instance and selection/search owners.

The browser document title follows the visible active chat, with `New chat` as the blank-workspace fallback. Settings, Memory, Assistants, and Knowledge replace that title while they own the workspace; transient drawers, palettes, inspectors, sharing, and confirmations preserve the underlying chat title. Sign in and public share use fixed privacy-safe route titles, while Control Center adds only its fixed active section label; public snapshot content, bearer tokens, account identity, selected resources, prompts, and message content never enter metadata.

The responsive contract is verified at 384x844 and 390x844 portrait,
844x390 short landscape, 768x1024 tablet, 1023/1024px sidebar transition,
1280/1281px continuity, and 1440px wide desktop, plus enlarged text. When a
width transition hides focused sidebar content, focus moves to `Open sidebar`;
return restores the exact remembered source only while that fallback still owns
focus. Opening and closing a drawer or sheet focuses its first deliberate
control and restores the initiating control. Width never creates a second
draft, run, navigation, or selection owner.

[Run controls](composer/RUN_CONTROLS.md) owns Model, Search, Run setup, context
facts, and compact-reading semantics. The shell guarantees that their popovers
and setup surfaces stay viewport-contained with one local scroller: compact or
short compositions use safe-area sheets while eligible desktop disclosures may
remain anchored. Responsive presentation never creates a second draft,
next-run owner, or setup path.

`app/layout.tsx` opts into both `viewport-fit=cover` and
`interactive-widget=resizes-content`. Shell, conversation, and modal surfaces
use `100dvh`; fixed sheets apply every relevant `env(safe-area-inset-*)`; and
each tall surface has one local scroll owner. Composer occupies its own layout
row above the reduced content viewport instead of covering the last answer.
Its textarea grows to 200px on desktop or 40dvh below `900px`, then scrolls
internally. Model/capability surfaces become safe-area bottom sheets below
`900px` or at short height. Draft text survives viewport and keyboard geometry
changes unchanged.

Wide code, tables, formulae, previews, timelines, and redacted payloads never
widen the document. They wrap where truthful or use a named local horizontal
scroller. Coarse-pointer controls have a minimum 40px target; tapping a message
reveals its action dock without requiring hover or long-press.

Main areas:

- single collapsible desktop sidebar or its compact/mobile drawer presentation;
- conversation column with the thread and one composer layout row;
- on-demand Branch, Run details, and artifact-preview overlays;
- full-screen Memory, Assistants, and Knowledge resource workspaces;
- Settings and command overlays;
- auth and public-share workspaces;
- grouped Control Center shell and its current destination.
