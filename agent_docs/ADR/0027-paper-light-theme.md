# ADR 0027: Paper Extends The Light Palette Registry

Status: Accepted
Amends: 0010-neutral-light-theme, 0025-clean-slate-research-chat-and-control-center

## Context

The operator requested an additional light color scheme alongside the five retained themes, with the calm familiarity of the current public ChatGPT surface. Direct inspection on 2026-07-26 showed a nearly monochrome hierarchy: white working paper, a barely gray navigation rail, soft gray controls, near-black text, and black primary actions. This is palette evidence only; AIQSA keeps its own research composition, terminology, Run receipt, provider transparency, and interaction model.

## Decision

1. Add persisted theme id `paper` with user-facing label `Paper`, declared as a light scheme.
2. Append `paper` to the registry after the five existing entries. Existing ids, order, LocalStorage/cookie values, and behavior remain unchanged.
3. `neutral` remains the no-preference and invalid-value fallback. Adding `paper` does not silently migrate any browser.
4. `Paper` uses a paper-white canvas, a whisper-gray workspace rail and controls, graphite ink, quiet gray traces, and a near-black proof/action color. Positive, caution, and critical remain semantic rather than decorative.
5. The palette is conversation-product familiar but is not a ChatGPT clone. No OpenAI name, logo, asset, layout, or branded color is copied into AIQSA.
6. The same semantic tokens, responsive composition, safe rendering, and functionality apply across all six themes. Formal WCAG/accessibility certification remains deferred by ADR 0025.

## Consequences

- Theme persistence and first paint accept a sixth stable id without changing the default.
- Appearance presents six divided comparison rows and keeps the existing five in their stable order.
- Visual verification includes representative Research Chat, Control Center, auth/share, overlay, Markdown/code, and compact states in `paper`.
