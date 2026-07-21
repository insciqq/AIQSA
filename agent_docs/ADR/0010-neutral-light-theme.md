# ADR 0010: Classic Light And Classic Dark Extend The Palette Registry

Status: Accepted
Amends: 0009-conversation-first-ui-revamp

## Context

Task 144 established semantic theme tokens and three persisted dark palettes. ADR 0009 deliberately kept the conversation-first revamp dark-first and deferred light mode until the shared shell no longer depended on hard-coded dark browser chrome, scrims, shadows, atmosphere, or syntax highlighting.

The operator first requested a familiar gray-and-white palette inspired by TypingMind's public product UI. The token audit found that a palette-only inversion would leave browser `color-scheme`, SSR markup, overlays, shadows, atmosphere, and Shiki output inconsistent. Light mode therefore became a declared design-system capability rather than an isolated CSS override.

The operator then clarified that the familiar TypingMind dark treatment is also wanted as an option. Public application inspection on 2026-07-11 exposed `--main-dark-color: #1b1d21` and `--main-dark-popup-color: #1a1c1f`, plus a neutral charcoal hierarchy, near-white text, and blue actions. This is palette evidence, not authorization to clone TypingMind's layout or product chrome.

## Decision

1. AIQSA themes declare a `dark` or `light` color scheme in the theme registry. The declaration drives server markup, client switching, browser controls, and theme-aware rendering.
2. The first light theme uses persisted id `neutral` and user-facing label `Classic Light`. Its visual recipe is a white conversation canvas, quiet neutral-gray navigation and raised surfaces, near-black text, restrained separators, and a blue interactive accent.
3. The TypingMind-inspired dark option uses persisted id `classic-dark` and user-facing label `Classic Dark`. It anchors the canvas at `#1b1d21` and popup/overlay surface at `#1a1c1f`, then maps the remaining AIQSA semantic layers to neutral charcoal, near-white text, quiet gray states, and a blue interactive accent.
4. `aiqsa` remains the default theme. Existing `aiqsa`, `graphite`, `verdant`, and `neutral` preferences keep their ids and behavior; no migration or server-side user preference is introduced.
5. Shared overlays, shadows, atmosphere, status colors, and syntax highlighting use semantic or scheme-aware recipes. Components must not assume that black overlays, black shadows, dark browser chrome, or `github-dark` are universally correct.
6. TypingMind is an inspiration for palette familiarity only. AIQSA does not copy its assets, brand, layout, sidebar variants, or interaction model.
7. Every palette must preserve the same conversation-first hierarchy, compact power-user density, keyboard behavior, responsive composition, and accessible contrast.

## Consequences

- Both Classic palettes can ship without changing server data, shares, chats, provider behavior, or the default first-run appearance.
- Theme tests and direct visual inspection must cover affected scheme persistence, SSR/hydration agreement, contrast, overlays, Markdown/code, auth/share, and representative workspace surfaces.
- New shared components must be checked in the default dark theme and one relevant Classic palette when their rendering changes. Raw color utilities require a documented local reason.
- This ADR supersedes ADR 0009's dark-first release limitation and the dark-only clause of `CRITICAL_INVARIANTS.md`. All other ADR 0009 decisions remain accepted.
