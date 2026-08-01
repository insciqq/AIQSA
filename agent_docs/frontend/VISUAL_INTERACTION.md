# FRONTEND VISUAL INTERACTION

Owner: Frontend interaction-motion maintainers
Scope: Runtime motion-state behavior and reduced-motion ownership; visual timing and composition recipes remain in DESIGN_SYSTEM.md.

## Motion

The shared motion layer is CSS-only with no animation-library dependency. Keyframes and utilities are centralized in `app/globals.css`; `html[data-motion="off"]` remains the deterministic test switch. There is no page-load shell entrance animation.

Sanctioned moments — no decorative motion outside this list:

1. Run lifecycle: the evidence-based pipeline indicator's live activity glyph carries a working pulse (`pipeline-pulse`, 1.3s opacity breathing); idle and settled pipeline chrome do not animate. The completed turn's metadata line cools from the proof accent once (`settle-flash`, 800ms via `data-run-settled`).
2. Streaming liveness: only the active progress dot and answer caret pulse. The answer text itself remains visually stable, so coalesced token flushes update the live row without restarting a whole-block animation and memoized historical rows never repaint.
3. Popover/menu/dialog entrances: every picker, action menu, dialog, command palette, and mobile drawer uses the shared `pop-enter` utility (120ms ease-out, opacity plus ~2% scale). The scale animation uses the independent CSS `scale` property and must not override a surface's positioning translate/transform. Exits stay instant via unmount — no exit animations.
4. Reading disclosures: compact composer collapse/expand uses a 150ms grid-row/opacity transition. Only the bounded exact-message surface—not its full-width row gutter—accepts fine-pointer hover; it and keyboard-visible focus use a symmetric 150ms `cubic-bezier(0.4, 0, 0.2, 1)` semantic surface transition in both directions. Its anchored action dock appears and disappears as one stable unit without an independent opacity/translate transition; compact/coarse tap keeps its 300ms soft entrance and never latches the surface highlight. The explicitly requested Run receipt uses the shared soft mount fade. Reduced motion keeps the same states without delay or interpolation.

Rules:

- One-shot motion stays within 100-350ms and normally uses ease-out; bidirectional transient hover uses the symmetric standard easing above. Continuous liveness animations are opacity-only breathing at >=1.3s periods.
- The pipeline indicator derives from existing client-side run state only; adding backend stage events for motion is out of contract.
- Adjacent token events aggregate into one bounded client timeline entry, and workspace summaries structurally contain no message content, so token-only thread-cache updates do not repaint navigation. No per-token style mutation occurs outside the streaming row; historical row memoization stays intact.
- Skeleton shimmer (loading placeholders) predates this list and keeps its own keyframes.
- New motion requires extending this section first.
