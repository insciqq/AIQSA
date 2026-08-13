# DESIGN SYSTEM — FOUNDATIONS

Owner: Frontend visual-system maintainers
Scope: Product character, semantic color, typography, spacing, geometry, and depth foundations.
Read when: Changing visual direction, tokens, themes, typography, spacing, radii, shadows, or foundational geometry.
Code owners: Global styles, theme/token owners, shared visual primitives, and typography assets.
Not owned here: Chat-specific composition, Control Center composition, functional UI behavior, or runtime state.

The bounded visual-system family routed by `DESIGN_SYSTEM.md` is binding for the current Chat workspace and Control Center. Owners routed by `FRONTEND.md` define behavior, state, responsive access, and control ownership. This file owns product character, semantic tokens, typography, foundational geometry, spacing, and depth; its sibling visual leaves own feature composition, shared interaction states, motion, content presentation, and visual review gates.

The replacement presentation consumes the `color.*`, `radius.*`,
`shadow.*`, and `motion.*` variables from `styles/tokens-v2.css`
directly. That file is the sole active palette-value boundary. The previous
theme variables and six legacy theme selectors no longer exist. A bounded set
of established Tailwind utility names remains for secondary Auth, Share, and
Control Center leaves, but each utility resolves directly to a `--v2-*` token
through `color-mix()`; it is not a second palette or compatibility theme layer.

## Product Character

AIQSA should feel like a quiet, focused AI workspace: familiar enough to understand immediately, precise enough to trust, and calm enough to read for a long time. It is not a generic admin dashboard and not a decorative AI demo.

The two primary contexts are:

- **Chat:** ask, create, inspect execution, branch, and continue.
- **Control Center:** connect an installation, manage access, and inspect operational state.

The domain vocabulary is question, answer, evidence, source, branch, event,
trace, workspace, and run. Prefer those words over generic dashboard language.
The signature visual language pairs one quiet whole-turn reveal with a compact
message-action dock, a factual evidence row, and an on-demand Run details drawer. [Messages](../frontend/MESSAGES_AND_MARKDOWN.md)
own reveal/action behavior and [receipt and Details](../frontend/composer/RECEIPT_AND_DETAILS.md)
own disclosure/data behavior; this system owns only their hierarchy, geometry,
and visual states.

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
- badge carpets, unlabeled icon-only critical actions, and pills for ordinary rectangular controls;
- fake activity, confidence, citations, stages, or completion claims;
- a shrunken desktop table presented as a mobile workflow.

## Semantic Color System

Components consume semantic tokens only. Raw product colors, palette-specific Tailwind hues, hard-coded light/dark classes, and component-local gradients are forbidden. CSS variables remain compatible with Tailwind opacity modifiers; derived hover and selected colors may use `color-mix()` at the token-definition boundary.

### Required tokens

| Token family | Role |
|---|---|
| `color.canvas`, `color.sidebar` | Reading plane/drawers and navigation plane. |
| `color.surface`, `color.surface2` | Composer/overlays and their single permitted nested surface. |
| `color.bubble`, `color.codeBg` | User question and code-only surfaces. |
| `color.hover`, `color.active` | Transient hover and quiet current-row state. |
| `color.border`, `color.border2` | Soft structure and stronger interactive/overlay boundary. |
| `color.text`, `color.text2`, `color.text3` | Primary, secondary, and bounded tertiary hierarchy. |
| `color.accent`, `color.accentInk`, `color.accentDim` | Primary action, focus, links, selection marks, and live capability/run facts. |
| `color.ok`, `color.warn`, `color.danger` | Observed success, degradation, and error/destructive state. |
| `shadow.overlay` | Popovers, drawers, dialogs, and toasts only. |

Names receive the `--v2-` implementation prefix while retaining the
normative role. A v2 focus target uses a two-pixel `color.accent` outline
with a two-pixel offset. Disabled controls use `surface2/text3`; structural
boundaries use `border` or `border2`, never a text color repurposed as a
border. These are bounded visual-system checks, not an application-wide
accessibility-conformance claim.

### Light reference palette

| Role | Light reference |
|---|---:|
| Canvas | `#faf9f6` |
| Sidebar | `#f1efe9` |
| Surface | `#ffffff` |
| Nested surface / code | `#f3f1ec` |
| User bubble | `#eeece5` |
| Text | `#26241f` |
| Text 2 | `#6e6a61` |
| Text 3 | `#9b968b` |
| Accent | `#146b63` |
| Accent ink | `#f4fffd` |

The dark values and both palettes' alpha borders/interactions are executable
in the sole token file and locked by the theme contract test. Muted text is
not a substitute for tiny type.

### Theme compatibility

The product exposes exactly `system`, `light`, and `dark`. System selects
one of the two palettes with `prefers-color-scheme`; it is not a third
palette. The browser-local migration is idempotent:
`aiqsa | graphite | verdant | classic-dark -> dark`,
`neutral | paper -> light`, and unknown or absent values become `system`.
The normalized cookie owns server first paint while LocalStorage keeps its
existing post-hydration precedence. Runtime application synchronizes
`data-theme` with the currently effective `data-color-scheme` for code and
native-control parity.

Dark and light use the exact approved Reading Room palette in the token file.
Light is warm paper and white surface hierarchy, not mechanical inversion.
Parity is complete only when conversation, admin, auth, public share, code,
math, menus, native controls, selection, scrollbars, status, charts, and
overlays follow the selected scheme.

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

Use the semantic `text-metadata` utility for the 12px/1.5 small-metadata floor. Raw 10-11px utilities are not a component API. The only smaller recipe is `text-incidental` at 11px/16px, reserved for visually redundant glyphs, indices, or structural markers that are explicitly `aria-hidden`; it must never carry help, status, security, lifecycle, technical evidence, or an action label.

The answer is a readable document, not a chat bubble stack. Use a 46-48rem answer measure. User questions may use a narrower right-aligned surface but must wrap naturally. Long headings, German-like compounds, Cyrillic text, URLs, code, tables, and formulas must not widen the page at the supported viewport compositions.

## Space, Geometry, And Depth

Use a 4px base rhythm with primary steps of 4, 8, 12, 16, 24, 32, and 48px. Related controls stay closer than adjacent groups. Large empty areas belong around the answer and composer, not inside padded cards.

- Chat sidebar: 16.25rem when visible. It is open by default at `>=1024px`,
  starts collapsed at `900–1023px`, and becomes a scrim-backed drawer below
  `900px` with a maximum width of 17.5rem. Full collapse leaves only the
  adjacent Open/New-chat controls; there is no residual icon rail.
- Control Center navigation: 15rem when persistent.
- Workspace header: one 3rem row for conversation identity and bounded global
  actions. Mobile hides secondary text actions before shrinking touch targets.
- Branches, Run details, artifact preview, Settings, and command search are
  temporary overlays at every width. Right-hand desktop drawers use the
  27.5rem drawer token; below `900px` they become full-viewport sheets. No
  inspection surface creates a pinned column or changes conversation measure.
- Answer column: max 46-48rem with responsive inline padding.
- Composer: the same 46.25rem measure as the answer, in its own layout row;
  compact/short model and capability surfaces become safe-area bottom sheets.
- Dense list rows: 36-44px for precise pointers; at least 44px for coarse pointers.
- Ordinary control radius: 8px; panels and composer: 12-16px.
- Full pills: only short status, filters, segmented values, avatars, and compact tags.
- Borders: one structural edge at a region boundary, not nested boxes.
- Shadows: subtle composer lift; stronger but still neutral overlay lift. Persistent rails and normal rows have none.

Avoid isolated floating rectangles when a plain section, row, or disclosure communicates the relationship more clearly.
