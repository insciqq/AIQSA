# DESIGN SYSTEM — FOUNDATIONS

Owner: Frontend visual-system maintainers
Scope: Product character, semantic color, typography, spacing, geometry, and depth foundations.
Read when: Changing visual direction, tokens, themes, typography, spacing, radii, shadows, or foundational geometry.
Code owners: Global styles, theme/token owners, shared visual primitives, and typography assets.
Not owned here: Chat-specific composition, Control Center composition, functional UI behavior, or runtime state.

The bounded visual-system family routed by `DESIGN_SYSTEM.md` is binding for the current Chat workspace and Control Center. Owners routed by `FRONTEND.md` define behavior, state, responsive access, and control ownership. This file owns product character, semantic tokens, typography, foundational geometry, spacing, and depth; its sibling visual leaves own feature composition, shared interaction states, motion, content presentation, and visual review gates.

All runtime UI consumes this system's product-semantic tokens directly. Compatibility aliases such as `surface-*`, `content-*`, `separator-*`, and generic color-named accents are not part of the component API and must not return.

## Product Character

AIQSA should feel like a quiet, focused AI workspace: familiar enough to understand immediately, precise enough to trust, and calm enough to read for a long time. It is not a generic admin dashboard and not a decorative AI demo.

The two primary contexts are:

- **Chat:** ask, create, inspect execution, branch, and continue.
- **Control Center:** connect an installation, manage access, and inspect operational state.

The domain vocabulary is question, answer, evidence, source, branch, event,
trace, workspace, and run. Prefer those words over generic dashboard language.
The signature visual language pairs one quiet whole-turn reveal with an anchored
action dock and a deliberately secondary Run receipt. [Messages](../frontend/MESSAGES_AND_MARKDOWN.md)
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
- badge carpets, icon-only critical actions, and pills for ordinary rectangular controls;
- fake activity, confidence, citations, stages, or completion claims;
- a shrunken desktop table presented as a mobile workflow.

## Semantic Color System

Components consume semantic tokens only. Raw product colors, palette-specific Tailwind hues, hard-coded light/dark classes, and component-local gradients are forbidden. CSS variables remain compatible with Tailwind opacity modifiers; derived hover and selected colors may use `color-mix()` at the token-definition boundary.

### Required tokens

| Token family | Role |
|---|---|
| `app-canvas` | Page and application background. |
| `workspace-rail` | Workspace and Control Center navigation plus the compact Workspace drawer. |
| `answer-paper` | Conversation column, its title-free edge actions, and document plane; not a card around each answer. |
| `composer-surface` | Composer and focused editing surfaces. |
| `control-surface` | Inputs, quiet buttons, and repeated interactive rows. |
| `control-boundary` | Necessary field, picker, and other interactive boundaries; not structural separators or decorative boxes. |
| `overlay-surface` | Menus, dialogs, sheets, and the Details inspection plane in overlay or pinned form. |
| `control-hover`, `control-pressed`, `control-selected` | Interaction states, never resting decoration. |
| `trace-subtle`, `trace-strong` | Quiet and stronger structural separators; never a substitute for a necessary control boundary. |
| `ink`, `ink-secondary`, `ink-muted`, `ink-disabled` | Text hierarchy. |
| `proof`, `proof-hover`, `proof-contrast` | Primary action, selection, links, and live trace. |
| `focus` | Keyboard and programmatic focus indication, independent of status tone. |
| `positive`, `caution`, `critical` | Confirmed success, recoverable warning, and error/destructive state. |
| `scrim` | Modal background isolation. |

Names may receive a CSS/Tailwind prefix, but their semantic role must stay recognizable. `surface-2`, `gray-700`, and similarly context-free aliases are not acceptable component APIs.

The `ring-focus` recipe composites `proof` at 78% and must reach at least 3:1 across adjacent common canvas, rail, answer, composer, control, overlay, and interaction-state surfaces. The compound composer keeps its quiet trace boundary and adds no inner or outer focus decoration around the Message plane. The `border-control-boundary` recipe composites `ink-muted` at 85% and has the same bounded 3:1 target; use it only where a visible boundary is necessary to identify an enabled control. Disabled controls remain quieter, and `trace-subtle`/`trace-strong` continue to own structural separation. Meaningful small `ink-muted` text on `control-selected` reaches at least 4.5:1 in every theme. These token-pair checks are a bounded visual-system contract, not an application-wide accessibility-conformance claim.

### Reference neutral palette

The `neutral` theme is the first-use default and the reference against which hierarchy is reviewed. `paper` is an additional light interpretation; each dark theme owns its concrete values in `globals.css` while preserving this semantic ordering. There is no implicit dark counterpart for either light theme.

| Role | Light `neutral` reference |
|---|---:|
| App canvas | `#fbfcfb` |
| Workspace rail | `#f3f5f3` |
| Answer paper | `#ffffff` |
| Composer surface | `#ffffff` |
| Control surface | `#f4f6f5` |
| Overlay surface | `#ffffff` |
| Trace subtle | `#e0e5e2` |
| Trace strong | `#b8c1bd` |
| Ink | `#1c211f` |
| Ink secondary | `#454d49` |
| Ink muted | `#5f6864` |
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

Every registry entry declares `light` or `dark`, and components consume the
applied `data-theme`/`data-color-scheme` pair without inferring scheme from an
ID. [Frontend implementation state](../frontend/IMPLEMENTATION_STATE.md) owns
first-paint, LocalStorage/cookie precedence, hydration, and runtime switching.

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

Use the semantic `text-metadata` utility for the 12px/1.5 small-metadata floor. Raw 10-11px utilities are not a component API. The only smaller recipe is `text-incidental` at 11px/16px, reserved for visually redundant glyphs, indices, or structural markers that are explicitly `aria-hidden`; it must never carry help, status, security, lifecycle, technical evidence, or an action label.

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
