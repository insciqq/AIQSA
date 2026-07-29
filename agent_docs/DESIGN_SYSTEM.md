# DESIGN_SYSTEM

This is the binding visual contract for AIQSA's clean-slate Research Chat and Control Center. `FRONTEND.md` owns behavior, state, responsive access, and control ownership. ADRs 0025, 0028, 0030, 0037, and 0038 own the product-level presentation, task-first composition, direct controls, compact evidence, title-free conversation actions, and intent-gated message chrome. This file owns visual hierarchy, semantic tokens, component recipes, motion, content presentation, and visual quality gates.

All runtime UI consumes this system's product-semantic tokens directly. Compatibility aliases such as `surface-*`, `content-*`, `separator-*`, and generic color-named accents are not part of the component API and must not return.

## Product Character

AIQSA should feel like a quiet research instrument: familiar enough to understand immediately, precise enough to trust, and calm enough to read for a long time. It is not a generic admin dashboard and not a decorative AI demo.

The two primary contexts are:

- **Research Chat:** ask, read, inspect evidence, branch, and continue.
- **Control Center:** connect an installation, manage access, and inspect operational state.

The domain vocabulary is question, answer, evidence, source, branch, event, trace, workspace, and run. Prefer those words over generic dashboard language. The signature interaction is the **message reveal sequence**: one quiet whole-turn hover/keyboard highlight followed by an anchored action dock, keeping reading primary while making the exact question or answer actionable. Touch may reveal the dock but never turns that transient highlight into a selected state. Its deliberate secondary evidence surface is the **Run receipt**, available from that answer's More menu rather than resting in the reading path.

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

The deliberately distinctive choice is the message reveal sequence paired with an explicitly requested Run receipt. It is justified by the product's Question -> Search -> Answer trace and must remain structural and factual; the rest of the interface stays restrained.

## Semantic Color System

Components consume semantic tokens only. Raw product colors, palette-specific Tailwind hues, hard-coded light/dark classes, and component-local gradients are forbidden. CSS variables remain compatible with Tailwind opacity modifiers; derived hover and selected colors may use `color-mix()` at the token-definition boundary.

### Required tokens

| Token family | Role |
|---|---|
| `research-canvas` | Page and application background. |
| `workspace-rail` | Workspace and Control Center navigation plus the compact Workspace drawer. |
| `answer-paper` | Conversation column, its title-free edge actions, and document plane; not a card around each answer. |
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

Theme IDs `aiqsa`, `graphite`, `verdant`, `classic-dark`, `neutral`, and `paper` are stable browser-persisted compatibility identifiers and must not be repurposed. They are tonal interpretations of one hierarchy, not separate layouts:

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

- Workspace rail: 16rem when persistent, with one fixed Account footer below
  the independently scrolling browse region.
- Control Center navigation: 15rem when persistent.
- Conversation edge-action rail: at most 4rem plus the applicable top safe-area inset on compact input and 3rem plus that inset on desktop. It belongs to the answer-paper column and overlays the scroll plane at every width without a full-width resting fill or separator. Compact actions use one quiet bounded group per side; a token-derived readability veil fades from answer paper to transparent behind them, and initial thread padding scrolls away so later prose can pass beneath without meeting an opaque banner. Desktop keeps the top-right overlay; below a 78rem conversation-column width the thread yields only a 16rem right footprint, while wider centered content clears it naturally. It collapses to the safe-area inset when desktop has no visible conversation action.
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

The conversation and composer dominate. A persistent Workspace rail appears at `>=1024px`; below that, Workspace is a modal drawer. The conversation column owns one compact floating edge-action layer with no visible chat title, full-width surface, or divider; a visually hidden page heading preserves semantic structure while Workspace selection owns visible chat identity. Compact input starts document content below the floating groups, then lets that padding scroll away beneath the restrained readability veil. Desktop starts the thread at the top and places the rail in a protected right-side action footprint, shifting only narrow reading geometry far enough left to prevent any button/text intersection. Account is a full-width quiet footer row beneath Workspace history, showing the user icon plus the current email with contained truncation; it is never part of the conversation actions or browse scroller. Its menu opens upward within the safe-area-adjusted Workspace boundary and scrolls locally when height is constrained, with a restrained continuation cue while final actions remain below the fold. Once a conversation exists, Share and Details remain direct at every width; Copy thread and Branch tree live in one `Conversation actions` menu at every width, while Command palette, Prompt library, and Settings live as distinct Account destinations. A blank `New chat` omits those object-specific actions so the prompt is the only dominant task, and desktop collapses the empty action rail. There is no second permanent action bar or replacement title chip.

Chat and folder rows use quiet selected/hover states, stable action space, and text labels where consequence matters. Active-run state is a small factual cue. Nested folders must retain readable indentation without causing page-level horizontal overflow.

### Conversation

- Questions are compact and visually distinct, but not oversized colored bubbles.
- Answers sit directly on the answer paper with document typography.
- Questions and answers rest as content-first text. Fine-pointer hover belongs only to the bounded exact-message surface, leaving the full-width row gutter inert. That hover or keyboard-visible focus softly highlights the whole surface with the same symmetric 150ms standard easing on entry and exit; the Regenerate/Edit/Copy/More dock appears as one stable unit at the bottom-right edge for either role, without an independent fade, scale, or slide. Compact/coarse/no-hover tap reveals the dock with only momentary pressed feedback and never leaves the turn selected or highlighted. The dock overlays reserved inter-turn breathing room instead of shifting message text. Delete and Branch from here remain clearly labeled inside a collision-aware portalled menu that stays within the viewport.
- When unseen real message content remains below the viewport, one circular down-arrow action floats above the composer. It has no visible `Latest` label or full-width owner row; `Jump to latest message` remains its exact accessible name.
- Markdown headings begin below the page heading hierarchy. Code, tables, and display math own named local horizontal scrollers.
- Provider/model metadata is quiet but legible. Internal IDs never substitute for display labels.
- Loading, queued, streaming, cancelled, failed, and complete states retain a stable answer anchor and truthful language.

### Run receipt

Each non-streaming assistant answer owns one compact evidence block below its answer body, but hover, focus, and message tap never render it. `More` → `Show run details` is its only presentation owner; `Hide run details` removes it again. When explicitly revealed, it may show only facts bound to that message: terminal status, stored provider/model identity, bounded search/tool/citation/reasoning/context evidence, message-bound warnings, and final provider usage from a terminal persisted run with the exact same run id. Search and citation details expand within this same block instead of creating adjacent stacked summary panels. Profile or elapsed time appears only when the accepted run carries that exact historical fact; current composer/catalog defaults are never used to reconstruct it. Unavailable facts are omitted, never estimated.

The receipt opens an existing disclosure on its originating answer, or Details → Events only when the exact same persisted run and real events are currently loaded. A segment without that truthful destination stays noninteractive text, so an older answer can never open the latest answer's trace. The receipt invents no audit feed, resource, or tab; Branch and Events remain the only Details destinations.

### Composer

The resting composer contains:

1. Message field;
2. one full, readable provider/model control;
3. one compact Profile/Search/More row;
4. one final Tools/Usage/Attach/Send band, or an addressable Stop while cancellation is available.

Model and Search open their existing pickers directly. The model trigger shows provider/model identity without a redundant visible `Model` prefix. Entitled configured Fast/Balanced/Deep profiles live behind one compact current-value trigger that shows the derived profile or `Custom`; opening it reveals only applicable profiles, and one selection applies the complete model/reasoning tuple. If none is applicable, the resting Profile trigger is omitted. Complete Run setup uses one full-width divided profile list: each configured row keeps a stable label and purpose, an explicit Available/Unavailable/Selected state, and the concrete configuration only when available; unavailable rows stay disabled and the shared reason remains readable. Narrow Search uses `OAI` and `PPLXTY` as bounded provider cues while title/accessible text retains the exact strategy. More opens that setup, including the same Model/Profile/Search owners plus Reasoning and advanced controls. Tools exposes lifecycle plus factual ready-tool state in the final band; a background refresh preserves the current icon/text until replacement data arrives. The hierarchy stays the same at every width; wrapping may change, meaning and ownership do not. Routine loading/creation uses neutral busy presentation, while caution remains reserved for a state that needs user correction.

Attachment progress, partial failure, edit-branch intent, context warning, unavailable catalog, and send/run errors appear next to the control that can resolve them. The composer remains reachable above the software keyboard and safe-area inset.

The composer's accessible Message label is visually suppressed in both blank and active-chat states; the `Ask AIQSA…` placeholder carries the resting visual cue without consuming another line. In a ready blank chat, that one composer and a short orientation line are centered as one group in the available conversation stage. This prompt-first variant visually removes the separate Usage line, keeps the same direct Model/Profile/Search plus More controls, and may render Attach without text at compact width; it still uses the same owners and disclosures. Once first-send creation begins or any message exists, the same composer occupies the thread tail and restores the ordinary conversation/action composition. Do not render a second start composer, suggestion-card dashboard, or different empty-state control hierarchy.

Below `sm`, or at no more than 32rem height, deliberate reading movement may collapse an empty idle thread-tail composer to one bounded `Ask AIQSA…` Message row. A real wheel/touch gesture plus 48px of consecutive movement in either direction is required; direction reversal resets the count and application-owned scroll never qualifies. Pointer click or keyboard focus restores the complete composer. Drafts, attachments, upload/edit/error/unavailable states force it open, and an addressable live run keeps a labeled Stop beside Message. Density comes from disclosure, never from shrinking the 44px touch target.

### Details and settings

Details is closed by default, opens as an overlay at all widths, and may be pinned only when at least 1440px of useful width remains. It contains Branch and Events inspection, never duplicated next-run editing. Events uses readable stage language instead of internal codes; Branch renders the current linear path as document content and reserves controls only for actual alternate versions.

Settings is a bounded overlay for Appearance and MCP & tools; on compact/short viewports it becomes a safe-area-aware sheet with one local scroll owner. Prompt library is a separate full-viewport Account/Run-setup workbench, not a Settings tab or rounded modal. Persistent chrome gives `Back to chat` clear placement; search and `New prompt` belong to the library header. Only viewports at least 1024px wide **and** taller than 512px use the library/editor split, with independent pane scrolling beneath fixed headers and above the fixed editor footer. Smaller or shorter compositions show one task and a visible `Back to prompts` action. A proof scan edge marks the edited row, the persisted new-chat default stays secondary to content, identity and instructions form explicit groups, `Duplicate` is directly visible, destructive `Delete` lives under `More`, and Save/create is the sole primary action. `FRONTEND.md` owns transition guards, state preservation, focus, and dismissal behavior. Appearance is a divided comparison list, not a card grid.

## Auth And Public Share Composition

Auth uses one flat, spacious answer-paper workspace with a maximum width of 42rem. Product identity and orientation sit above the active task; the form is part of the page rather than a bordered, shadowed, or decorated card. Only the current sign-in, request, invite, verification, reset, pending, success, or error state appears. OAuth actions remain neutral alternatives to the single primary action.

Public share is a reading surface, not a reduced private shell. A quiet workspace-rail header identifies AIQSA, shared-research context, and the immutable read-only state. The title, fixed-copy note, compact questions, and document-flow answers share the normal reading measure. Do not add a composer, private metadata, navigation into the installation, or promotional call to action. Empty and unavailable links remain plain terminal states.

## Control Center Composition

The Control Center is an operational workspace, not a dashboard landing page. Navigation exposes only real destinations under stable subject headings in this order: AI setup — Providers; Team & access — Users, Access & groups, Invites, Access rules; Operations — Usage; Infrastructure — MCP servers, Email delivery; Safety — Safety. Headings are visible orientation text, never plans, modes, roles, routes, collapsible setup stages, or status classifiers. Providers is the initial destination.

The active destination owns the page title, short scope description, primary action, status/feedback, and content. Do not repeat a global metric-card strip above every task. Important counts belong beside the relevant navigation item or section heading.

### Providers workspace and Quick setup

Providers has one persistent flat task line in this order: `Quick setup`, `Connections`, `Run profiles`. Use an underline/current-text treatment rather than three filled pills or a second navigation rail. Keep its narrow/zoom fallback touch- and focus-scrollable, but suppress visible scrollbar chrome. Quick setup is the default and the other tasks remain visible throughout provider work; they are peer destinations, not Basic/Advanced modes. Their data owners stay lazy, so task labels do not require eager counts.

The default composition visualizes Provider -> API key -> Test & Save -> Ready in one focused Quick-setup surface. It shows five equal choices—OpenAI, Anthropic, Gemini, OpenRouter, and **Custom / OpenAI-compatible**—with one shared low-noise container treatment. The four reviewed paths retain a write-only key field, one primary action, one truthful **Testing & saving…** pending state, and a factual result; Custom opens its isolated form. Compact screens use two columns, the intermediate breakpoint uses three, and wide screens use one five-choice row. Keep the key plus primary action in the focused task scan; explanatory guidance is optional large-screen context. Any additional required model choice stays inside this vertical scan before the primary commit. Existing custom/team configuration may appear as quiet nonblocking context, never as an `Advanced` provider-card status or gate before key entry. Do not animate or label unobservable server phases. A visible contextual **Manage _provider_ connection** action hands off to Connections without competing with the primary setup action.

Custom OpenAI-compatible setup is the fifth choice, not a branded imitation or an Advanced gate. Its Back-connected page uses the same restrained Control Center geometry and one primary vertical scan: endpoint, key, **Discover models**, the shared searchable catalog picker or manual model id, derived request endpoint, Test & Save. When several discovered IDs are selected, keep the picker as the add action and render the ordered selection as quiet divided rows with local Remove plus secondary bounded Select all/Clear controls; do not turn it into chips, a checkbox wall, or a second catalog panel. Keep protocol, hosted-tool declarations, and optional configuration inside one quiet disclosure. Tool copy must distinguish runnable hosted web search from future-only recorded image-generation support. Render the factual Ready receipt as document hierarchy with a proof accent, not a dashboard card. The saved Custom Models editor reuses this same picker geometry and states rather than falling back to a visually unrelated native model select.

Never imply that a successful catalog check guarantees future generation or billing. Ready presentation names only factual installed/default/profile effects. `FRONTEND.md` and `BACKEND.md` own replacement, assignment removal, atomicity, and secret-lifecycle behavior.

### Resource and lifecycle work

Users and Access & groups use a full-width directory with the complete row as the selection target and no automatic first selection. One selected resource replaces the index with a dedicated Back-connected detail page. User-detail Account actions form one compact wrapping group of right-sized buttons; a disabled Save groups action stays neutral and becomes solid proof only for an actionable changed draft. Group detail owns Overview, Members, Models & search, and Tools as peer tasks. `Full access` uses the same row/detail composition with one quiet `Built-in` marker and factual entitlement state; do not turn it into a promotional card, warning, or matrix of disabled toggles. Its Members task stays operational while lifecycle and automatic current/future resource coverage read as stable facts. A persistent desktop master/detail split is not the default composition.

Provider, MCP, and email lifecycle controls use progressive disclosure with draft/test/activate state visible near the action that advances it. MCP's normal first install is one trust decision followed by a persistent activation track: show only real queued, resolution, isolated-runtime preparation, connection, tool-discovery, publication, ready, or failed stages; omit inapplicable stages and never invent percent or ETA. Working stages use proof/neutral progress, ready uses positive, and only a terminal safe failure uses critical treatment. Generic Connections entry first shows a full-width connection index; the header separates total from configured count and gives local refresh an explicit resource name. An exact, canonical, or otherwise unambiguous provider-context handoff may open the matching full-width detail directly. Detail uses horizontal peer tasks and never adds a second vertical rail beside the global Control Center rail. Connections, Credentials, and Models inventories use one lightly tinted task canvas around one bounded list panel with a distinct quiet header and divided rows; row menus and pickers must not be clipped by that panel. A virgin `Not configured` publication fact and a configured disabled runtime fact remain neutral. Concrete prerequisites that block first activation are the exception: group them in one bounded critical-tint callout with a critical icon/title and readable blocker list, while keeping the corrective button proof-colored rather than destructive. Revision, validation, routing, credential assignment, and destructive operations remain reachable without contaminating Quick setup.

MCP import uses one large configuration-document surface rather than a generic single-line field or fake IDE: a bounded viewport-responsive mono editing plane on `composer-surface`, a slim proof scan edge, quiet identity/format chrome, and an attached trust/primary-action strip. The surface owns its rounded boundary and semantic focus/error ring; focus and error color changes settle in roughly 150ms without entrance or layout motion. Short-height viewports reduce the initial editing height while retaining local resize/scroll and reachable actions. Do not duplicate pasted content into a syntax-highlight mirror, inherit ordinary control height, add decorative editor chrome, or introduce a code-editor dependency for this paste-and-review step.

Availability is a first-class binary resource fact across the Control Center and ordinary-user Settings. Render one compact dot-and-label status at the scan point: `Enabled` uses the positive token; `Disabled` uses a bounded high-contrast neutral surface/text combination and never `ink-muted`, `ink-disabled`, caution, or critical. Status and action are always separate elements. Use a soft proof-colored **Enable** button for restoration while the corresponding **Disable** action stays quiet; when setup or authorization is the truthful prerequisite, that action remains accented without hiding the separate Disabled status. Keep solid proof buttons for the local primary decision such as Test & Save, Save, or Activate. Do not apply this binary style to publication, readiness, grants, approvals, invitations, archives, selections, or unavailable form controls.

In dense resource inventories, availability also owns one restrained leading scan edge and surface wash: positive for Enabled and strong neutral for Disabled, never opacity or error color. Selection composes as an independent ring/background and does not erase the resource state. User accounts preserve their four-state language (`Active`, `Disabled`, `Pending`, `Denied`): Active/Disabled share the availability geometry and scan strength, while Pending/Denied retain caution/critical lifecycle semantics. Dependency readiness such as an inactive run-profile deployment remains a separately labeled fact beside the persisted profile state.

At compact widths, list and detail are separate compositions with an explicit Back action; `FRONTEND.md` owns preserved query, scroll, and selection state. Tables may own local horizontal scrolling for comparison data, but a primary workflow must not require dragging a desktop table sideways to reach its action.

Run-profile and prompt editors make draft state visible beside its owner: invalid fields explain themselves, Save/create is the sole primary commit, and Discard is quiet. Prompt-library rows open content for editing and expose no runtime application action; the new-chat default stays secondary, Duplicate remains visible, and Delete is disclosed through More. `FRONTEND.md` owns dirty-navigation guards, pending mutation blocks, and state reconciliation.

## Components And Interaction States

Each reusable control defines rest, hover, active, selected, disabled, busy, invalid, and success states where applicable. Busy controls retain their label and prevent duplicate submission. Inline feedback stays near its source; page-level notices are reserved for results that affect the whole current workspace.

- **Buttons:** one primary action per local decision. Secondary and quiet actions rely on type/surface, not arbitrary colors. Destructive styling appears only at the point of consequence.
- **Fields:** persistent label, optional help, input, and associated error. Placeholder is example text, never the only label. Secret fields state write-only/preserve/replace behavior.
- **Menus/listboxes:** use native controls when they fit. Reuse existing interaction logic where practical.
- **Tabs:** represent peer panels only and keep one obvious selected state.
- **Resource rows:** when the row's primary purpose is to open a dedicated detail, the whole row is the target; do not reduce discovery to a small `Details` action.
- **Disclosures:** have a visible summary and expanded state. They do not hide the only path to a frequent action.
- **Dialogs/drawers/sheets:** isolate the background, support an explicit Close, and keep one local scroll owner. A full-viewport workbench may instead give each persistent pane its own local scroll owner when the responsive contract explicitly calls for it.
- **Empty/error states:** explain the resource and give the next valid action. Loading failure must not masquerade as a true empty result.
- **Skeletons:** approximate stable content geometry and avoid shifting the eventual content.
- **Confirmations:** name the affected resource and consequence. Typed confirmation is reserved for exceptional irreversible scope, not ordinary deletion.

## Adaptive Layout

Composition follows available space, content, and input capability. Media queries establish shell-level thresholds; container queries adapt composer, headers, navigation rows, and list/detail regions inside their actual space.

- At approximately 1024px and above, workspace/control navigation may be persistent.
- Below that, navigation is a drawer and the conversation/task owns the viewport.
- Details pinning is offered only at 1440px and above; overlay remains available everywhere.
- Validate at 384/390x844, 844x390, 768x1024, 1024x512, 1024x768, 1280x500, 1280x800, and 1440px-or-wider compositions. Prompt library must remain one-task at the 512px-height boundary and at every width below 1024px; its split appears only when both thresholds pass.
- Use `dvh`, `viewport-fit=cover`, `interactive-widget=resizes-content`, and every relevant safe-area inset.
- At `(hover: none)` or `(pointer: coarse)`, primary workflow targets are approximately 44x44px so the product remains comfortable on phones and tablets.
- No primary phone/tablet workflow depends on hover or drag precision.
- The page itself has no horizontal overflow. Code, tables, formulas, and exceptional data grids own named local scrollers.

## Motion

Motion communicates state change, spatial origin, and live work; it does not decorate idle surfaces.

- Control feedback: 100-140ms.
- Menus/popovers: 120-160ms.
- Drawers/sheets: 160-220ms.
- Completion emphasis: one restrained settle, no looping celebration.

Do not animate shell entrance or idle/settled pipeline chrome. Running activity may pulse, answer completion may settle once, and overlays may use one short entrance. Animate opacity and independent scale where possible; an entrance keyframe must not replace the translate/transform that positions its surface. Never animate layout during token streaming. Keep the existing deterministic test motion-off mode, but enable real motion in geometry cases that own this interaction.

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

Every new or changed visual recipe must satisfy these conditions before it becomes the product default:

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
