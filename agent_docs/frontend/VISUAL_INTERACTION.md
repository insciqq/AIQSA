# FRONTEND VISUAL INTERACTION

Owner: Frontend interaction-motion maintainers
Scope: Runtime motion-state behavior and reduced-motion ownership; composition recipes are routed by `DESIGN_SYSTEM.md`.

## Motion

The shipped motion layer is CSS-only with no animation-library dependency. Shared timings and tokens live in `styles/tokens-v2.css`; the bounded `pop-enter` compatibility utility remains in `app/globals.css` for reviewed secondary dialogs. `html[data-motion="off"]` is the deterministic visual-test switch. There is no page-load shell animation.

Sanctioned moments:

1. Active work may use a slow opacity-only spinner or pulse derived from real run/upload/index state. Idle and settled chrome does not loop.
2. Streaming changes only the active answer caret/progress indicator; token text does not replay a whole-block animation and historical rows remain stable.
3. Menus, drawers, sheets, dialogs, scrims, and the command palette use one token-driven entrance: `motion.fast` for menus, popovers, dialogs, and scrims; `motion.base` for right drawers and bottom sheets. The shared keyframes animate only opacity plus the independent `scale`/`translate` properties, so an entrance cannot replace the transform that positions a surface. Exit may be immediate on unmount.
4. Hover, press, focus, selection, and disclosure state use the `motion.fast` or `motion.base` token. Message actions appear as one stable unit; evidence counts and settled answer content do not animate as proof of activity.

Rules:

- One-shot motion stays within 100–350ms and normally uses ease-out. Continuous liveness is opacity-only and no faster than 1.3s.
- Run state comes only from normalized lifecycle/event evidence. Elapsed time, prose, and animation never invent a stage or completion.
- No layout animation runs during token streaming. Adjacent token events remain coalesced by the focused run/thread owner.
- `prefers-reduced-motion: reduce` and `data-motion="off"` preserve every state and action without delay or interpolation.
- New motion requires extending this owner and the paired deterministic visual state before shipping.
