# DESIGN_SYSTEM

This is the binding visual contract for AIQSA's clean-slate Research Chat and Control Center. `FRONTEND.md` owns behavior, state, responsive access, and control ownership. ADR 0025 owns the product-level presentation decision. This file owns visual hierarchy, semantic tokens, component recipes, motion, content presentation, and visual quality gates.

All runtime UI consumes this system's product-semantic tokens directly. Compatibility aliases such as `surface-*`, `content-*`, `separator-*`, and generic color-named accents are not part of the component API and must not return.

## Product Character

AIQSA should feel like a quiet research instrument: familiar enough to understand immediately, precise enough to trust, and calm enough to read for a long time. It is not a generic admin dashboard and not a decorative AI demo.

The two primary contexts are:

- **Research Chat:** ask, read, inspect evidence, branch, and continue.
- **Control Center:** connect an installation, manage access, and inspect operational state.

The domain vocabulary is question, answer, evidence, source, branch, event, trace, workspace, and run. Prefer those words over generic dashboard language. The signature visual element is the **Run receipt**: a compact, evidence-backed trace line that makes an answer's real search/tool/run state inspectable without turning the page into telemetry.

Use these hierarchy rules in order:

1. Establish importance with placement, measure, typography, and whitespace.
2. Use a surface shift only when a region has a distinct job.
3. Use a separator only when whitespace and surface contrast are insufficient.
4. Reserve shadow for the composer and floating overlays.
5. Reserve the proof accent for the primary action, current selection, links, and live work.
6. Use status color only for a real success, warning, or failure.

Reject these defaults:

- a card grid around ordinary rows or prose;
- a permanent toolbar containing every run control;
- oversized hero copy, decorative gradients, glass effects, and ornamental grain;
- badge carpets, icon-only critical actions, and pills for ordinary rectangular controls;
- fake activity, confidence, citations, stages, or completion claims;
- a shrunken desktop table presented as a mobile workflow.

The deliberately distinctive choice is the Run receipt. It is justified by the product's Question -> Search -> Answer trace and must remain structural and factual; the rest of the interface stays restrained.

## Semantic Color System

Components consume semantic tokens only. Raw product colors, palette-specific Tailwind hues, hard-coded light/dark classes, and component-local gradients are forbidden. CSS variables remain compatible with Tailwind opacity modifiers; derived hover and selected colors may use `color-mix()` at the token-definition boundary.

### Required tokens

| Token family | Role |
|---|---|
| `research-canvas` | Page and application background. |
| `workspace-rail` | Workspace and Control Center navigation plus the compact Workspace drawer. |
| `answer-paper` | Conversation column, its local top rail, and document plane; not a card around each answer. |
| `composer-surface` | Composer and focused editing surfaces. |
| `control-surface` | Inputs, quiet buttons, and repeated interactive rows. |
| `overlay-surface` | Menus, dialogs, sheets, and the Details inspection plane in overlay or pinned form. |
| `control-hover`, `control-pressed`, `control-selected` | Interaction states, never resting decoration. |
| `trace-subtle`, `trace-strong` | Structural separators and high-contrast boundaries. |
| `ink`, `ink-secondary`, `ink-muted`, `ink-disabled` | Text hierarchy. |
| `proof`, `proof-hover`, `proof-contrast` | Primary action, selection, links, and live trace. |
| `positive`, `caution`, `critical` | Confirmed success, recoverable warning, and error/destructive state. |
| `scrim` | Modal background isolation. |

Names may receive a CSS/Tailwind prefix, but their semantic role must stay recognizable. `surface-2`, `gray-700`, and similarly context-free aliases are not acceptable component APIs.

### Reference neutral palette

The `neutral` theme is the first-use default and the reference against which hierarchy is reviewed. `paper` is an additional light interpretation; each dark theme owns its concrete values in `globals.css` while preserving this semantic ordering. There is no implicit dark counterpart for either light theme.

| Role | Light `neutral` reference |
|---|---:|
| Research canvas | `#fbfcfb` |
| Workspace rail | `#f3f5f3` |
| Answer paper | `#ffffff` |
| Composer surface | `#ffffff` |
| Control surface | `#f4f6f5` |
| Overlay surface | `#ffffff` |
| Trace subtle | `#e0e5e2` |
| Trace strong | `#b8c1bd` |
| Ink | `#1c211f` |
| Ink secondary | `#454d49` |
| Ink muted | `#67706c` |
| Proof | `#176f65` |
| Proof contrast | `#ffffff` |

The table is a visual reference. Review normal text, muted text, controls, and status colors for ordinary readability in every theme. Muted text is not a substitute for tiny type.

### Theme compatibility

The existing IDs `aiqsa`, `graphite`, `verdant`, `classic-dark`, and `neutral` remain valid because they are stored browser preferences. `paper` is appended as a sixth stable choice. They are tonal interpretations of one hierarchy, not old layouts:

- `neutral`: quiet light neutral with teal proof accent; first-use default;
- `aiqsa`: warm dark neutral with teal proof accent;
- `graphite`: cool dark neutral with blue-teal proof accent;
- `verdant`: green-black neutral with mint proof accent;
- `classic-dark`: charcoal neutral with restrained blue proof accent.
- `paper`: paper-white and whisper-gray light surfaces with graphite proof/action hierarchy; conversation-product familiar without copying another product's brand or layout.

Every registry entry declares `light` or `dark`. Server first paint and runtime switching set both `data-theme` and `data-color-scheme`. Components never infer scheme from an ID. An existing cookie or LocalStorage value wins over the first-use default.

Dark parity is complete only when conversation, admin, auth, public share, code, math, menus, native controls, selection, scrollbars, status, charts, and overlays all follow the selected scheme. No theme may diverge into a separate visual hierarchy.

## Typography

Use the already bundled `Golos Text` variable face for UI and document text because it is legible, compact, and covers the product's Latin/Cyrillic content. Use `JetBrains Mono` only for code, identifiers, exact provider values, and event payloads. Typography changes the product character through scale, weight, width, and measure rather than another network font.

| Role | Target recipe |
|---|---|
| Answer body | 16-18px responsive, 1.6-1.7 line height, regular weight. |
| UI body | 14-15px, 1.4-1.5 line height. |
| Small metadata | 12-13px, at least 1.35 line height. |
| Page title | 22-28px, 600 weight, compact tracking. |
| Section title | 16-18px, 600 weight. |
| Labels/actions | 13-14px, 500-600 weight; sentence case. |
| Code/event data | 12-14px mono, 1.5-1.65 line height. |

The answer is a readable document, not a chat bubble stack. Use a 46-48rem answer measure. User questions may use a narrower right-aligned surface but must wrap naturally. Long headings, German-like compounds, Cyrillic text, URLs, code, tables, and formulas must not widen the page at the supported viewport compositions.

## Space, Geometry, And Depth

Use a 4px base rhythm with primary steps of 4, 8, 12, 16, 24, 32, and 48px. Related controls stay closer than adjacent groups. Large empty areas belong around the answer and composer, not inside padded cards.

- Workspace rail: 16rem when persistent.
- Control Center navigation: 15rem when persistent.
- Conversation top rail: 3.5rem in compact composition and 4rem at desktop, plus the applicable top safe-area inset. It belongs to the answer-paper column and does not span Workspace.
- Pinned Details: 23rem, available only at `>=1440px`.
- Answer column: max 46-48rem with responsive inline padding.
- Dense list rows: 36-44px for precise pointers; at least 44px for coarse pointers.
- Ordinary control radius: 8px; panels and composer: 12-16px.
- Full pills: only short status, filters, segmented values, avatars, and compact tags.
- Borders: one structural edge at a region boundary, not nested boxes.
- Shadows: subtle composer lift; stronger but still neutral overlay lift. Persistent rails and normal rows have none.

Avoid isolated floating rectangles when a plain section, row, or disclosure communicates the relationship more clearly.

## Research Chat Composition

### Shell and workspace

The conversation and composer dominate. A persistent Workspace rail appears at `>=1024px`; below that, Workspace is a modal drawer. The conversation column owns its local top rail. Once a conversation exists, Share and Details remain direct at every width; Copy thread and Branch tree live in one `Conversation actions` menu at every width, while Command palette and Settings live in Account. A blank `New chat` omits those object-specific actions so the prompt is the only dominant task. There is no second permanent action bar.

Chat and folder rows use quiet selected/hover states, stable action space, and text labels where consequence matters. Active-run state is a small factual cue. Nested folders must retain readable indentation without causing page-level horizontal overflow.

### Conversation

- Questions are compact and visually distinct, but not oversized colored bubbles.
- Answers sit directly on the answer paper with document typography.
- Answer actions appear in stable reserved space and remain directly available on touch layouts; hover may enhance, never gate a primary touch workflow.
- Markdown headings begin below the page heading hierarchy. Code, tables, and display math own named local horizontal scrollers.
- Provider/model metadata is quiet but legible. Internal IDs never substitute for display labels.
- Loading, queued, streaming, cancelled, failed, and complete states retain a stable answer anchor and truthful language.

### Run receipt

Each non-streaming assistant answer owns one compact terminal receipt below its answer body. It may show only facts bound to that message: terminal status, stored provider/model identity, bounded search/tool/citation/reasoning/context evidence, message-bound warnings, and final provider usage from a terminal persisted run with the exact same run id. Profile or elapsed time appears only when the accepted run carries that exact historical fact; current composer/catalog defaults are never used to reconstruct it. Unavailable facts are omitted, never estimated.

The receipt opens an existing disclosure on its originating answer, or Details → Events only when the exact same persisted run and real events are currently loaded. A segment without that truthful destination stays noninteractive text, so an older answer can never open the latest answer's trace. The receipt invents no audit feed, resource, or tab; Branch and Events remain the only Details destinations.

### Composer

The resting composer contains:

1. attachment/tools entry;
2. Message field;
3. a text-backed Run summary;
4. Send, or an addressable Stop while cancellation is available.

The Run summary states exact Model, derived Profile or Custom/unavailable, Reasoning mode/effort, and Search or Off. It opens the complete setup in one action and keeps the same hierarchy at every width; wrapping may change, meaning and ownership do not. Fast/Balanced/Deep appear at the start of setup only when entitled and configured.

Attachment progress, partial failure, edit-branch intent, context warning, unavailable catalog, and send/run errors appear next to the control that can resolve them. The composer remains reachable above the software keyboard and safe-area inset.

In a ready blank chat, that one composer and a short orientation line are centered as one group in the available conversation stage. This prompt-first variant visually removes the redundant Message label and separate Usage line, compresses Run to a one-line model summary, and may render Attach without text at compact width; it still uses the same controls and disclosures. Once first-send creation begins or any message exists, the same composer occupies the thread tail and restores the ordinary conversation/action composition. Do not render a second start composer, suggestion-card dashboard, or different empty-state control hierarchy.

### Details and settings

Details is closed by default, opens as an overlay at all widths, and may be pinned only when at least 1440px of useful width remains. It contains Branch and Events inspection, never duplicated next-run editing.

Settings is a bounded workspace for Prompts, Appearance, and MCP & tools. On compact/short viewports it becomes one safe-area-aware sheet whose active task owns local scrolling; Prompts switches between separate library and editor views with an explicit Back action. Appearance is a divided comparison list, not a card grid. Dirty-close protection and nested confirmations remain visible parts of the quality contract.

## Auth And Public Share Composition

Auth uses one flat, spacious answer-paper workspace with a maximum width of 42rem. Product identity and orientation sit above the active task; the form is part of the page rather than a bordered, shadowed, or decorated card. Only the current sign-in, request, invite, verification, reset, pending, success, or error state appears. OAuth actions remain neutral alternatives to the single primary action.

Public share is a reading surface, not a reduced private shell. A quiet workspace-rail header identifies AIQSA, shared-research context, and the immutable read-only state. The title, fixed-copy note, compact questions, and document-flow answers share the normal reading measure. Do not add a composer, private metadata, navigation into the installation, or promotional call to action. Empty and unavailable links remain plain terminal states.

## Control Center Composition

The Control Center is an operational workspace, not a dashboard landing page. Navigation exposes only real destinations under stable subject headings in this order: AI setup — Providers; Team & access — Users, Access & groups, Invites, Access rules; Operations — Usage; Infrastructure — MCP servers, Email delivery; Safety — Safety. Headings are visible orientation text, never plans, modes, roles, routes, collapsible setup stages, or status classifiers. Providers is the initial destination.

The active destination owns the page title, short scope description, primary action, status/feedback, and content. Do not repeat a global metric-card strip above every task. Important counts belong beside the relevant navigation item or section heading.

### Provider Quick setup

The default flow is Provider -> API key -> Test & Save -> Ready. Use one focused setup surface with three provider choices, a write-only key field, one primary action, one truthful **Testing & saving…** pending state, and a factual success result. On compact screens, keep provider choices as one three-column strip and keep the key plus primary action in the first task viewport; the explanatory guide is optional large-screen context. Existing custom/team configuration may appear as quiet nonblocking context, never as an `Advanced` provider-card status or a gate before key entry. Do not animate or label unobservable server phases. Advanced configuration is a secondary disclosure/link and lazy-loaded subview, not a wall of fields or background resource load before the key.

Never imply that a successful catalog check guarantees future generation or billing. Ready identifies the exact selected answer model and only factual default/profile effects. Key replacement identifies the currently active configuration and makes it clear that a failed test/save leaves it unchanged; every previously available entitled canonical model must remain available under the replacement or the operation fails without writes. Removing the actor's Quick assignment is confirmation-gated, explicitly retains the stored credential and team configuration, and warns that access may stop. Secret fields clear on success, provider/subview change, and close; they never echo a saved value.

### Resource and Advanced work

Users and Access & groups use a full-width directory with the complete row as the selection target and no automatic first selection. One selected resource replaces the index with a dedicated Back-connected detail page. Group detail owns Overview, Members, Models & search, and Tools as peer tasks. `Full access` uses the same row/detail composition with one quiet `Built-in` marker and factual positive state; do not turn it into a promotional card, warning, or matrix of disabled toggles. Its Members task stays operational while lifecycle and automatic current/future resource coverage read as stable facts. A persistent desktop master/detail split is not the default composition.

Advanced provider, MCP, and email lifecycle controls use progressive disclosure with draft/test/activate state visible near the action that advances it. Advanced provider configuration first shows a full-width connection index, then a full-width connection detail with horizontal peer tasks; it does not add a second vertical rail beside the global Control Center rail. A virgin `Not configured` connection uses neutral setup language and color instead of warning decoration. Revision, validation, routing, credential assignment, and destructive operations remain reachable without contaminating Quick setup.

At compact widths, list and detail are separate states with an explicit Back action and preserved list query/scroll/selection. Tables may own local horizontal scrolling for comparison data, but a primary workflow must not require dragging a desktop table sideways to reach its action.

## Components And Interaction States

Each reusable control defines rest, hover, active, selected, disabled, busy, invalid, and success states where applicable. Busy controls retain their label and prevent duplicate submission. Inline feedback stays near its source; page-level notices are reserved for results that affect the whole current workspace.

- **Buttons:** one primary action per local decision. Secondary and quiet actions rely on type/surface, not arbitrary colors. Destructive styling appears only at the point of consequence.
- **Fields:** persistent label, optional help, input, and associated error. Placeholder is example text, never the only label. Secret fields state write-only/preserve/replace behavior.
- **Menus/listboxes:** use native controls when they fit. Reuse existing interaction logic where practical.
- **Tabs:** represent peer panels only and keep one obvious selected state.
- **Disclosures:** have a visible summary and expanded state. They do not hide the only path to a frequent action.
- **Dialogs/drawers/sheets:** isolate the background, support an explicit Close, and keep one local scroll owner.
- **Empty/error states:** explain the resource and give the next valid action. Loading failure must not masquerade as a true empty result.
- **Skeletons:** approximate stable content geometry and avoid shifting the eventual content.
- **Confirmations:** name the affected resource and consequence. Typed confirmation is reserved for exceptional irreversible scope, not ordinary deletion.

## Adaptive Layout

Composition follows available space, content, and input capability. Media queries establish shell-level thresholds; container queries adapt composer, headers, navigation rows, and list/detail regions inside their actual space.

- At approximately 1024px and above, workspace/control navigation may be persistent.
- Below that, navigation is a drawer and the conversation/task owns the viewport.
- Details pinning is offered only at 1440px and above; overlay remains available everywhere.
- Validate at 384/390x844, 844x390, 768x1024, 1024x768, 1280x800, and 1440px-or-wider compositions.
- Use `dvh`, `viewport-fit=cover`, `interactive-widget=resizes-content`, and every relevant safe-area inset.
- At `(hover: none)` or `(pointer: coarse)`, primary workflow targets are approximately 44x44px so the product remains comfortable on phones and tablets.
- No primary phone/tablet workflow depends on hover or drag precision.
- The page itself has no horizontal overflow. Code, tables, formulas, and exceptional data grids own named local scrollers.

## Deferred Accessibility Scope

Dedicated accessibility implementation and conformance are not part of the current product scope. They require a separately approved future task.

## Motion

Motion communicates state change, spatial origin, and live work; it does not decorate idle surfaces.

- Control feedback: 100-140ms.
- Menus/popovers: 120-160ms.
- Drawers/sheets: 160-220ms.
- Completion emphasis: one restrained settle, no looping celebration.

Do not animate shell entrance or idle/settled pipeline chrome. Running activity may pulse, answer completion may settle once, and overlays may use one short entrance. Animate opacity and transform where possible. Never animate layout during token streaming. Keep the existing deterministic test motion-off mode.

## Performance And Rendering

Representative production-like routes must stay within Core Web Vitals targets: LCP <= 2.5s, INP <= 200ms, and CLS <= 0.1 at the 75th percentile. These are product budgets, not guarantees from unit tests.

- Stream only the live answer tail. Historical completed messages and heavy Markdown blocks are memoized.
- Start syntax highlighting only for completed fences; cache by language and source.
- Virtualize only when measured list/thread size warrants it, without breaking find-in-page or answer anchors.
- Reserve geometry for loading, answer actions, attachments, receipts, and asynchronous metadata to prevent layout shift.
- Avoid broad store subscriptions and duplicated derived state in the view layer.
- Lazy-load heavy secondary workspaces such as advanced editors and inspection surfaces while keeping their entry feedback immediate.
- Do not ship raster mockups, duplicate icon sets, or temporary compatibility CSS in the final runtime bundle.

## Content And AI Trust

Use short, specific labels and sentence case. Lead with the action or outcome. Explain consequences before destructive actions and recovery after errors. Empty states describe what belongs there and the next valid step; they do not use marketing copy.

AI-specific presentation is evidence constrained:

- `Searching`, `Using tool`, `Waiting for provider`, `Complete`, and similar stages appear only from real run/event state.
- Source counts come from actual surfaced evidence; confidence is never inferred from prose length or model identity.
- A failed or partial stage remains visible and understandable.
- Provider/model identity stays legible where it affects user choice or evidence.
- User data, attachments, provider payloads, internal IDs, group metadata, and secrets follow the existing privacy contracts in every empty, error, debug, receipt, and share state.

## Visual Review Gate

Before propagating a new recipe, render and critique one representative Research Chat state and one representative Control Center state from real components and deterministic data. Review hierarchy, density, content truth, long text, dark parity, and the smallest supported viewport. Raster concept art may guide composition but never establishes product capabilities or exact copy.

A slice may be marked visually complete only when:

- it reads as the same system in light and dark themes;
- primary and secondary actions are unambiguous without badge/color dependence;
- loading, empty, error, busy, success, destructive, and long-content states are covered as applicable;
- safe-area, software-keyboard clearance, overflow, and coarse-pointer composition are verified;
- the Run receipt and other AI stages show only real state;
- affected capability and state contracts have test/evidence references;
- no superseded renderer, component-local color recipe, obsolete token, or implementation-shape test remains.

Use these audits during implementation:

```bash
rg -n '#[0-9a-fA-F]{3,8}|rgb\(|rgba\(|hsl\(|oklch\(' components app
rg -n '(bg|text|border|ring)-(blue|indigo|violet|purple|sky|emerald|teal|cyan|lime|orange|yellow|red|pink|fuchsia|gray|neutral)-[0-9]' components app
rg -n 'bg-gradient|from-|via-|to-|backdrop-blur' components app
rg -n 'bg-black/|className=.*dark|theme: "github-dark"' components app tailwind.config.ts
```

Investigate every product-code hit, then run the proportional checks in `TESTING.md` and inspect affected runtime states directly.
