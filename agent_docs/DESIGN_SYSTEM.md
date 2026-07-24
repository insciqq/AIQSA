# DESIGN_SYSTEM

This is the binding visual contract for AIQSA's conversation-first UI. `FRONTEND.md` owns behavior, state, and layout contracts; this file owns visual hierarchy, tokens, component recipes, and interaction-state presentation. Semantic tokens are defined in `app/globals.css` and `tailwind.config.ts`.

## Character And Hierarchy

AIQSA is a calm conversation and research workspace with a dark default plus optional Classic Light and Classic Dark palettes. The current question, answer, and composer receive the strongest hierarchy. Workspace navigation supports switching and organization. Run inspection is precise and quick to summon, but quiet when it is not needed.

Use these principles in order:

1. Establish hierarchy with placement, type, whitespace, and surface depth.
2. Add a separator only when adjacent surfaces still need an edge.
3. Add a shadow only to a floating overlay or action.
4. Use the brand accent only for the primary action, selection, focus, links, or live state.
5. Use semantic colors only for an actual error, warning, or success.

Do not turn the QSA pipeline into idle decoration. Do not make every datum a chip, every section a card, or every action an icon.

## Color System

All theme colors are CSS RGB variables so Tailwind opacity modifiers remain valid. Never introduce a raw product hue in a component.

### Surfaces

| Token / class | Role |
|---|---|
| `surface-canvas` / `bg-surface-canvas` | Page and app canvas; the base persistent layer for the selected palette. |
| `surface-navigation` / `bg-surface-navigation` | Workspace navigation and persistent app chrome. |
| `surface-thread` / `bg-surface-thread` | Conversation and reading plane. |
| `surface-raised` / `bg-surface-raised` | Composer, controls, repeated rows, and locally raised content. |
| `surface-overlay` / `bg-surface-overlay` | Menus, popovers, drawers, dialogs, and tooltips. |
| `surface-hover` / `bg-surface-hover` | Pointer or keyboard hover/focus-within feedback; never a resting layer. |
| `surface-active` / `bg-surface-active` | Pressed, expanded, or currently working control state. |
| `surface-selected` / `bg-surface-selected` | Current chat, tab, option, branch, or theme choice. |

Canvas, navigation, and thread may be visually close. That restraint is deliberate: the conversation should not sit inside a conspicuous card. Raised and overlay layers must remain distinguishable in all five palettes.

### Text

| Token / class | Role |
|---|---|
| `content-primary` / `text-content-primary` | Conversation text, titles, and the strongest control label. |
| `content-secondary` / `text-content-secondary` | Normal controls, descriptions, and supporting copy. |
| `content-muted` / `text-content-muted` | Metadata, timestamps, counts, and quiet hints. |
| `content-disabled` / `text-content-disabled` | Disabled-only labels and icons; never important enabled content. |
| `content-link` / `text-content-link` | Links and explicitly interactive inline text. |

Primary, secondary, muted, link, and semantic-status text are readable on the canvas and normal raised layers in AIQSA, Graphite, Verdant, Classic Dark, and Classic Light. Muted text is not a substitute for tiny type. Disabled styling may additionally use opacity, but the label must remain legible enough to identify the unavailable action.

### Separators

| Token / class | Role |
|---|---|
| `separator-subtle` / `border-separator-subtle` | A single structural edge between neighboring regions. |
| `separator-strong` / `border-separator-strong` | Focused boundaries, resizers, or a high-contrast edge that cannot be expressed by surface contrast. |

Prefer whitespace or surface contrast. Avoid nested boxes, full grids of borders, repeated `divide-y`, and a border around every inline control.

### Accent And Status

`accent-cyan` remains the one brand slot even when Graphite renders it blue-steel, Verdant renders it mint, and both Classic palettes render it blue. Use it for the primary action, current selection, focus, links, and live work.

- `accent-rose`: error and destructive consequence.
- `accent-amber`: warning, caution, and recoverable attention.
- `accent-green`: confirmed success.

One element carries one accent meaning. Do not combine brand-selected styling with a semantic status on the same element; use adjacent text or an icon with a readable label when both facts matter. Never rely on color alone.

### Approved Palettes

| Theme id | Label | Scheme | Character |
|---|---|---|---|
| `aiqsa` | AIQSA | Dark, default | Warm near-black surfaces and teal identity. |
| `graphite` | Graphite | Dark | Cool graphite surfaces and blue-steel identity. |
| `verdant` | Verdant | Dark | Green-black surfaces and mint identity. |
| `classic-dark` | Classic Dark | Dark | `#1b1d21` charcoal canvas, `#1a1c1f` overlays, near-white text, neutral layers, and clear blue identity. |
| `neutral` | Classic Light | Light | White conversation plane, quiet gray navigation, near-black text, and restrained blue identity. |

Every registry entry declares `dark` or `light`. Server first paint and runtime switching apply matching `data-theme` and `data-color-scheme`; do not infer scheme from an id in a component. `aiqsa` remains the first-visit default, and both Classic palettes remain additive browser-local choices under ADR 0010.

Classic Light's minimum measured contrast across canvas, navigation, thread, raised, overlay, hover, active, and selected surfaces is 12.72:1 for primary text, 5.97:1 for secondary text, 4.61:1 for muted text, 9.47:1 for links/brand text, 4.70:1 for success, 4.86:1 for warning, and 5.12:1 for errors. The shared 55%-alpha focus brand ring remains at least 3.06:1. Disabled text may be quieter but must remain identifiable by label and native disabled state.

Classic Dark's corresponding minima are 10.51:1 for primary text, 7.40:1 for secondary text, 4.60:1 for muted text, 6.36:1 for links/brand text, 8.17:1 for success, 6.87:1 for warning, and 4.79:1 for errors. Its shared 55%-alpha focus brand ring remains at least 3.06:1, including on the selected surface.

The fixed `body::before` brand wash and grain is the only product gradient. AIQSA, Graphite, and Verdant retain it; Classic Light and Classic Dark set semantic atmosphere opacity to zero so their deliberately flat neutral canvases remain familiar.

## Typography

Golos Text is the UI and reading face. JetBrains Mono is reserved for code, ids, provider/model ids in inspection, token counts, numeric measurements, keyboard shortcuts, and Q/S/A glyphs.

| Role | Default recipe |
|---|---|
| Conversation | `text-[15px] leading-7 text-content-primary`; long-form answers may use `text-base` when the owning slice proves the measure. |
| Page/dialog title | `text-lg font-semibold text-content-primary`. |
| Pane/section title | `text-sm font-semibold text-content-primary`. |
| Control | `text-sm font-medium`; `text-xs` is allowed only in genuinely compact desktop controls. |
| Field label | `text-xs font-medium text-content-secondary`; sentence case. |
| Supporting copy | `text-sm leading-6 text-content-secondary`. |
| Metadata | `text-[11px] leading-4 text-content-muted`; mono only when the value is technical or numeric. |

Meaningful control text is normally at least 12px. Ten-pixel uppercase captions and rows of uppercase capability badges are not v2 section hierarchy. Use sentence case and ordinary weight. `font-bold` is not used; `font-semibold` is the maximum UI weight.

Keep answers and the composer aligned to `max-w-reading` (46rem) unless code, a table, or another local artifact owns horizontal scrolling. User questions use that same outer alignment but may be narrower and right-aligned.

## Geometry And Density

### Radius

| Token / class | Value | Use |
|---|---:|---|
| `rounded-control` | 10px | Buttons, inputs, menu rows, tabs, chips. |
| `rounded-panel` | 14px | Panels, menus, popovers, dialogs, drawers. |
| `rounded-bubble` | 18px | User message bubbles and matching skeletons. |
| `rounded-composer` | 20px | The coherent composer frame. |
| `rounded-pill` | full | Status pills, compact counts, and true binary chips only. |

Do not use a pill merely to make ordinary text decorative. Nested surfaces normally step down one radius role.

### Spacing

Use the existing 4px Tailwind base with this bounded rhythm:

- 4-8px: icon/label and compact inline relationships;
- 12px: normal control groups and dense row padding;
- 16px: panel padding and separation between related blocks;
- 20-24px: conversation turns, dialog sections, and major groups;
- 32px or more: reading rhythm only, not routine app chrome.

Touch density and reading space may increase without inflating desktop navigation. Avoid arbitrary one-off spacing when the nearest step works.

### Control Height And Targets

- `h-control-sm` / `min-h-control-sm`: 32px compact desktop controls.
- `h-control` / `min-h-control`: 40px default inputs and important controls.
- `h-touch` / `min-h-touch`: 44px touch-safe targets and narrow-layout actions.
- Icon-only controls use at least 36px on desktop and 44px on touch layouts unless they are an inline, noncritical affordance with an equivalent labeled action.

No required action may depend on hover. Hover-revealed actions reserve their space and become visible on `focus-within` and touch layouts.

### Elevation

Persistent surfaces do not cast drop shadows. Use `shadow-float` for a small floating action and `shadow-overlay` for menus, drawers, and dialogs. Both names resolve through palette-owned shadow variables; do not recreate a black shadow in a component.

## Interaction States

Every custom control must cover the states it can enter:

- **Resting:** neutral surface and readable label.
- **Hover:** `bg-surface-hover` or a text-tone step; no movement or geometry change.
- **Keyboard focus:** visible brand ring, normally `outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/55 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-canvas`.
- **Selected/current:** `bg-surface-selected text-content-primary`, plus `aria-selected`, `aria-current`, or `aria-pressed` as appropriate.
- **Active/expanded/live:** `bg-surface-active`; live state also needs text, a glyph, or status announcement.
- **Disabled:** native `disabled`, `cursor-not-allowed`, `text-content-disabled`, and reduced opacity only when needed. Keep the reason available in text or accessible description.
- **Loading:** preserve the control's footprint and label the pending operation. Use a spinner only for indeterminate control work; use the QSA live language for a model run.
- **Error/warning/success:** semantic color plus readable text and status semantics. Error details wrap instead of truncating to a tooltip.

Focus and hover must never cause layout shift. Selected and focus are different facts and may appear together.

## Component Recipes

Recipes define visual hierarchy and state presentation; workflow behavior and exact composition stay with the owning surface in `FRONTEND.md`.

### Buttons

- Primary: one strongest action per surface, `h-control rounded-control bg-accent-cyan px-4 text-sm font-semibold text-surface-canvas`.
- Neutral: `h-control-sm rounded-control bg-surface-raised px-3 text-sm font-medium text-content-secondary hover:bg-surface-hover hover:text-content-primary`.
- Ghost: transparent at rest, `rounded-control text-content-muted hover:bg-surface-hover hover:text-content-primary`.
- Destructive: rose text/tint for the trigger; a confirmation may use a filled rose action with dark canvas text.
- Icon-only: stable square target, Lucide icon, `aria-label`, visible focus, and a tooltip for unfamiliar meaning.

Do not place a border, fill, and shadow on the same inline button. Add a subtle border only where its edge would otherwise disappear into the parent surface.

### Inputs And Textareas

Use `rounded-control border border-separator-subtle bg-surface-thread px-3 text-sm text-content-primary`. Labels stay visible outside ordinary fields. The conversation composer may make its real external label screen-reader-only in narrow or short-height composition because the bounded draft plane and `Ask AIQSA…` guidance already establish the single writing action; wider/taller composition keeps it visible. Placeholder text uses `text-content-muted` and never owns the accessible name. Focus uses the shared ring and may strengthen the separator. Errors are associated through `aria-describedby` and appear below the field without moving unrelated controls.

Search fields may include one leading Lucide icon. Textareas grow within a bounded area and scroll internally after that bound.

### Auth Workspace

Auth is one restrained workspace, not a landing page or a tiny credential card. Use a single bounded `surface-navigation` panel with a quiet identity header, one mode heading/orientation block, visible external field labels/help, one full-width primary action, and quiet secondary routes. Do not add illustrations, feature claims, testimonials, recovery hints, or competing cards.

Configured Google/Yandex entry points are neutral full-text buttons grouped before the email fields with one quiet `or use email` separator. They do not use fake brand-colored logos, compete with the form's primary action, or appear in invite/verification/reset modes.

Inputs and actions remain touch-safe. Password visibility is an inset icon button with a stable footprint. Pending state keeps layout stable; errors use a rose border-led in-flow alert, success uses the equivalent green treatment, and both pair color with readable text. Compact desktop/short-height modes may use a field row; phone/tablet remains vertical with safe-area padding, ordinary page scrolling, and no horizontal overflow.

Mode semantics, field/autocomplete rules, focus/live-region ownership, generic outcomes, and viewport reachability are owned by the Auth section of `FRONTEND.md`.

### Composer

The composer is one centered `max-w-reading` raised structural frame with `rounded-composer` and one outer border. The draft is a distinct, accessibly labeled input plane inside it and owns the visible focus ring; wider/taller composition shows the external `Message` label, while narrow or short-height composition hides only its visual text and gives the textarea the full row. Focusing the draft must not make the controls region appear to be part of the text field. Attachments, controls, quiet context/usage feedback, disabled/upload state, and the primary action stay inside the coherent frame with subtle internal separators.

Resting selectors use compact neutral triggers with selected values; Run settings uses the bounded overlay recipe and local scrolling. Below `sm`, or at no more than 32rem viewport height, one two-line Run summary replaces multi-row selector chrome while the Fast/Balanced/Deep profile choices remain a direct touch-safe group in the compact action footer. Model, Profile, Reasoning, and Search states remain readable text; a changing meter may supplement Profile/Reasoning but never replace the value, selection never relies only on accent color, and Reasoning/Search may not truncate away. The long inline context estimate yields that compact footer space to profile switching and remains reachable with provider-reported usage through the adjacent labeled statistics icon; the popover keeps values wrapped and locally contained. Compact Send/Stop retains its readable label and 44px height but uses a 72px minimum footprint so the profile group remains fully visible without an inner horizontal scroll; wider/taller composition keeps the 92px action footprint. Responsive Run setup uses the sheet recipe and one local scroll owner. In narrow or short-height composition, the screen-reader `Message` label remains associated while the 44px draft occupies the complete input row. Toggle rows keep complete labels and visible On/Off state. Attachment chips form a labeled wrapping list with readable file names and stable remove targets.

In compact reading state, the Run and profile/action regions collapse completely while the coherent outer frame and bounded Message plane remain. Do not leave clipped labels, partial buttons, separator fragments, or an empty footer track. A live addressable Stop remains a readable 44px action beside Message. Pointer expansion must complete the Message click before restored controls enter hit testing, preventing the same tap from activating Run setup; keyboard focus may expand immediately. Expansion restores the existing recipes without introducing a second surface or changing control emphasis.

Send is the sole brand-primary action when available. Stop uses live/destructive emphasis only during an active run. Disabled/working states keep the same footprint and add readable status copy rather than replacing labels with unexplained icons. Exact control inventory, edit/send rules, autosave/close behavior, and accessibility names live in `FRONTEND.md`.

### Chips, Toggles, And Status Pills

Use chips for a compact choice, filter, capability summary, or binary state, not ordinary metadata. Interactive toggles require `aria-pressed`; selected styling uses the semantic selected surface and brand text. Status pills use a semantic icon/text label and a subtle semantic tint. Capability text stays sentence case and at least 11px.

### Menus And Listboxes

Menus use `rounded-panel border border-separator-subtle bg-surface-overlay p-2 shadow-overlay`. Rows use `rounded-control`, compact desktop height, and distinct hover, selected, keyboard-active, Current, Default, and disabled presentation. Focus remains independently visible when selection is also present.

Searchable pickers add a visible heading/orientation, labeled search field, and one locally scrolling results region. Noninteractive provider headings use a quiet raised band with an explicit sentence-case `Provider` eyebrow, the readable provider name, and muted model-count/current-group metadata so they cannot be mistaken for model rows. Long names/descriptions wrap. Internal ids are never row copy; upstream ids may be secondary text only in a technical configuration or inspection picker where they disambiguate the selected API resource. Empty/no-result state is in-flow and specific.

Desktop surfaces anchor with purposeful width/max-height; narrow or short-height surfaces promote to safe-area-aware sheets with touch-sized rows. Search/filter semantics, keyboard algorithms, close/focus rules, and exact item inventories live in `FRONTEND.md`.

### Workspace Navigation

The 240px desktop navigation and reused mobile drawer are one calm `surface-navigation` tree. A filled brand New Chat action is the sole primary; folder creation is secondary and the labeled search field follows. Folder hierarchy uses chevrons, a folder glyph, bounded indentation, quiet counts, and no border/card wall.

Chat rows are borderless `rounded-control` options. The current row uses `surface-selected`; hover/focus uses `surface-hover` plus the shared ring without movement. Titles may wrap to two lines; optional provider/model/date metadata appears only when it disambiguates. Favorites and live runs use one quiet icon/text cue.

Overflow targets reserve stable space, remain visible on touch, and open a bounded local menu. Match reasons use ordinary metadata text rather than badge chrome. Exact actions, search behavior, focus restoration, tree state, and drawer workflows live in `FRONTEND.md`.

### Popovers

Popovers use the overlay/menu surface recipe, a purposeful width, and one local max-height scroll owner. The trigger communicates current state without requiring the popover. Narrow/short-height compositions may promote complex popovers to a safe-area-aware sheet; behavioral close/focus rules live in `FRONTEND.md`.

### Drawers, Sheets, And Dialogs

Use the palette-owned `bg-scrim/*` backdrop, `bg-surface-overlay`, `rounded-panel`, and `shadow-overlay`; never wrap the whole modal in another card or use a raw shared black backdrop.

Desktop drawers anchor to their edge without resizing unrelated content unless explicitly pinned. Narrow sheets use the dynamic viewport, safe-area padding, one local scroll owner, and an explicit touch-safe Close action. Nested confirmations are visually stronger than the parent but retain the same semantic token system.

Modal/inert/focus/Escape/replacement/dirty-confirmation and notice-ownership behavior lives in `FRONTEND.md`; styling must not create overlapping sibling modal workspaces or hide the current primary action.

### Settings Workspace

Settings is a secondary workspace, not a dashboard of nested cards. Use one title/header and a compact Prompts/Appearance/MCP switch. Desktop may use a bounded editor/library split with independent local scrolling; narrow/short-height layouts become one safe-area-aware sheet flow.

The prompt editor gives labels/help deliberate space, puts validation beside its field, and keeps one Save/Create primary action. Dirty/saving/saved/error states include text. Library rows wrap names, clamp previews, and visually distinguish the edited preset, Next run choice, and User default without turning every fact into a chip.

Appearance is a radiogroup of five semantic preview cards. Each preview renders in its own theme context, separates checked from focus state, names the palette/accent in text, and moves from one to two to five columns only when space permits. Mutation, keyboard, dirty-draft, loading, and persistence rules live in `FRONTEND.md`.

MCP settings use one calm raised row per entitled server: identity and readiness first, then its enable action, authorization/personal fields, and current tools. Readiness always has text and uses semantic status color only as a secondary cue. Secret fields look like ordinary labeled inputs but remain write-only; OAuth account evidence is quiet metadata beside explicit Connect/Reconnect/Disconnect actions. The composer counterpart is one compact text summary/link, never a second MCP editor or a row of tool chips.

### Conversation Shell And Details

The shell uses a quiet `surface-navigation` application bar above navigation and the primary conversation. At `lg` and wider, identity/workspace, the single truncating chat heading, and global actions form three readable groups, with Copy thread and Branch tree in the thread toolbar. Below `lg`, the heading remains semantic but is visually hidden; a neutral direct New chat action sits beside Workspace, while Copy thread and Branch tree join the same touch-safe application rail as Share, Details, and Account, and no second visible toolbar remains. Below `sm`, the decorative identity yields and the two leading actions remove their gap rather than shrinking 44px targets or introducing rail scrolling. Only live/error run state receives temporary action emphasis.

Details uses `surface-overlay` plus `shadow-overlay` when floating and a normal semantic column when pinned. Its header pairs a quiet mode/status block with separate Pin/Unpin and Close actions. Section headers use one subdued icon tile, sentence-case title, and explanatory line; true branch choices may use repeated surfaces while linear history stays flat. Event warnings/errors wrap inside the panel.

Transient notices use a bounded floating overlay below the application bar; persistent workflow notices use a bounded in-flow row below the thread toolbar. Exact breakpoints, modes, tabs, run/control ownership, notice behavior, and focus rules live in `FRONTEND.md`.

### Tabs

Tabs form one visually coherent tablist with a selected underline or selected surface, never a row of unrelated bordered boxes. Labels use normal control text; focus remains distinct from selection. Keyboard and panel relationships live in `FRONTEND.md`.

### Operational Admin Console And Data Tables

The admin console reuses the conversation palette/type/radius/focus/status system at higher scanning density. A quiet identity header, borderless passive metrics, conditional attention region, then section title/purpose keep operations ahead of decoration. Global destructive work is visually isolated in Safety.

Tables stay native-looking with quiet row separators, sentence-case headers, ordinary metadata, selected-row contrast, and one named focus-visible local horizontal-scroll surface. Long identities, ids, status/error text, and eligibility explanations wrap inside cells/details instead of widening the document.

Routine actions are neutral; current/enabled state includes text; amber and rose are reserved for real consequence. Selected detail panes are named destinations and compact layouts preserve the matrices as locally scrollable data rather than ambiguous cards. The MCP catalog follows the same list/detail density: a searchable server list, one normalized draft editor, readable validation/runtime evidence, and clearly separated routine Test/Update/Disable actions from trust-bearing Activate/rollback and confirmation-gated irreversible Delete. Exact admin operations, authorization, focus, confirmation, and compact workflow behavior live in `FRONTEND.md`.

### Tooltips

Tooltips are short, noninteractive labels on `bg-surface-overlay` with `rounded-control px-2 py-1 text-xs text-content-primary shadow-float`. They supplement icon-only controls and truncation; they never contain a critical action or the only error explanation.

### Empty States

An empty state is part of its owning surface, not a floating marketing card. Use one clear sentence, one short explanation or shortcut hint, and at most one primary action. No illustration, hero copy, emoji, feature grid, or fake activity.

### Conversation, Artifacts, And Code

Assistant answers remain full-measure document flow with quiet provider/model metadata; user questions are compact right-aligned raised blocks. Whitespace and surface contrast separate turns—no role avatars, literal role labels, separator wall, or assistant card.

Turn actions occupy a stable strip: neutral ghost presentation on precise-pointer hover/focus and persistent touch-safe presentation on no-hover input. Active run feedback uses one compact status line with a pulsing live dot and readable evidence-based text. It may say `Working…`, `Searching…`, or `Answering…`, but never lays out speculative waiting stages; errors pair rose emphasis with readable text. Search/tool/citation/reasoning artifacts use calm border-led disclosures. Tool activity stays count-first and collapsed at rest; expansion groups rounds and uses compact nested call disclosures rather than turning the answer into a trace dashboard. Context/run warnings use amber in-flow hints without turning the answer into an inspection panel.

Markdown uses the local semantic type/spacing system. Prose wraps; code, tables, and display math own focus-visible local horizontal scrolling. KaTeX inherits the current text color and stays in document flow without a decorative card; Shiki emits scheme-aware values inside the semantic code container, and Copy follows the same hover/focus/touch treatment. Exact action order, state wording, disclosure behavior, Markdown safety, and accessibility semantics live in `FRONTEND.md`.

### Public Read-Only Snapshot

The public share is a focused reading page, not a reduced private shell. Use one restrained identity/read-only header, the page's single title, one immutable-snapshot explanation, and the private conversation rhythm inside `max-w-reading`.

Questions remain compact raised blocks and answers flat document flow. Long title/prose/code/tables stay locally contained. Empty and unavailable presentation uses the same semantic tokens and calm in-flow empty-state recipe.

Privacy, unavailable-token equivalence, allowed content, private-control absence, and Markdown/link behavior live in `FRONTEND.md` and `SECURITY.md`; this file owns only their visual presentation.

## Icons And Content

Use Lucide icons already in the dependency graph. Normal size is 16px; compact metadata controls may use 14px; prominent standalone actions may use 18px. Icons are `aria-hidden` when adjacent text or `aria-label` provides the name. No emoji or filled pictograms in app chrome.

Display provider/model names outside inspection. Raw ids and UUID-like values belong only in model-picker secondary text and deep API inspection; message UUIDs are never rendered.

## Motion

Motion communicates entry, live work, or completion; it does not decorate idle UI.

- Global interactive color/background/border/opacity transitions stay near 100ms.
- Overlay entrances are short opacity/scale reveals, normally 120-160ms; exits may be immediate.
- One-shot feedback stays under 240ms unless `FRONTEND.md` documents an existing run-settle exception.
- Continuous motion is opacity-only and reserved for genuine loading or live run state.
- Hover never translates or scales content.
- Token streaming updates text without restarting animation or repainting unrelated rows.
- Compact composer reading disclosure may transition grid rows and opacity for 150ms ease-out; it must collapse to a clean complete state and become instantaneous under reduced motion.

`html[data-motion="off"]` and `prefers-reduced-motion` must make every state understandable with motion removed. Deterministic screenshot and test mode uses `data-motion="off"`. `FRONTEND.md` is the registry for shipped named animations; extend that registry before adding a keyframe.

## Responsive And Touch Rules

Responsive composition and exact breakpoints live in `FRONTEND.md`; cross-boundary behavior coverage lives in the browser specs. Visual/density invariants are:

- keep conversation and composer at the reading measure; progressive surfaces must not squeeze it into a narrow column;
- precise-pointer layouts retain compact density, while coarse/no-hover input uses the 44px required-action token independent of width;
- critical actions never rely on hover-only visibility;
- overlays own local scrolling, safe-area padding, and long-content containment without page-level horizontal overflow;
- short-height sheets keep heading, Close, search, and primary actions visible around one local scroll owner;
- long titles, model names, attachments, errors, code, and tables wrap, truncate with an accessible full value, or scroll locally.

## Hard Rules

1. Use only semantic surfaces/text/separators, the brand slot, semantic statuses, and the palette-owned scrim/shadow recipes specified here.
2. Keep exactly one strongest action per surface.
3. Prefer whitespace and layer contrast to borders; no border grids or card walls.
4. No product gradients beyond `body::before`.
5. No `font-bold`, pervasive uppercase labels, sub-12px meaningful controls, or rows of tiny badges.
6. No layout-moving hover, decorative animation, or per-token shell animation.
7. No marketing surfaces, illustrations, decorative images, or emoji chrome.
8. No required hover-only action, unlabeled icon button, color-only status, or hidden focus ring.
9. No raw ids outside inspection and no user-visible message UUIDs.
10. Preserve safe markdown, reduced-motion behavior, theme first paint, and all feature-parity items in `FRONTEND.md`.

## UI Change Self-Check

For every UI slice:

```bash
rg -n 'font-bold|transition-(transform|all)|animate-bounce|animate-ping' components app
rg -n '(bg|text|border|ring)-(blue|indigo|violet|purple|sky|emerald|teal|cyan|lime|orange|yellow|red|pink|fuchsia|gray|neutral)-[0-9]' components app
rg -n 'bg-gradient|from-|via-|to-' components app
rg -n 'bg-black/|rgba\(0,0,0|className=.*dark|theme: "github-dark"' components app tailwind.config.ts
```

Investigate every product-code hit. Then select proportional checks through `TESTING.md` and inspect the affected running-app states at relevant desktop/mobile sizes. Verify visible focus, no horizontal page overflow, readable long content, nonblank overlay states, and that nothing competes with the composer primary action.
