# DESIGN SYSTEM — INTERACTION AND REVIEW

Owner: Frontend visual-system maintainers
Scope: Reusable component states, adaptive layout, motion, rendering, AI trust presentation, and visual review gates.
Read when: Changing shared component states, responsive visual adaptation, animation, performance rendering, trust cues, or visual review requirements.
Code owners: Shared UI primitives, responsive/motion styles, rendering owners, and visual test surfaces.
Not owned here: Functional accessibility/state ownership, base tokens, or feature-specific Chat/Admin composition.

## Components And Interaction States

Each reusable control defines rest, hover, active, selected, disabled, busy, invalid, and success states where applicable. Busy controls retain their label and prevent duplicate submission. Inline feedback stays near its source; page-level notices are reserved for results that affect the whole current workspace.

- **Buttons:** one primary action per local decision. Secondary and quiet actions rely on type/surface, not arbitrary colors. Destructive styling appears only at the point of consequence.
- **Fields:** persistent label, optional help, input, and associated error. Placeholder is example text, never the only label. Secret fields state write-only/preserve/replace behavior.
- **Menus/listboxes:** use native controls when they fit. Reuse existing interaction logic where practical.
- **Tabs:** represent peer panels only and keep one obvious selected state.
- **Resource rows:** when the row's primary purpose is to open a dedicated detail, the whole row is the target; do not reduce discovery to a small `Details` action.
- **Disclosures:** have a visible summary and expanded state. They do not hide the only path to a frequent action.
- **Dialogs/drawers/sheets:** isolate the background, support an explicit Close, and keep one local scroll owner. A full-screen split surface may instead give each persistent pane its own local scroll owner when the responsive contract explicitly calls for it.
- **Empty/error states:** explain the resource and give the next valid action. Loading failure must not masquerade as a true empty result.
- **Skeletons:** approximate stable content geometry and avoid shifting the eventual content.
- **Confirmations:** name the affected resource and consequence. Typed confirmation is reserved for exceptional irreversible scope, not ordinary deletion.

## Adaptive Layout

Composition follows available space, content, and input capability. Media queries establish shell-level thresholds; container queries adapt composer, headers, navigation rows, and list/detail regions inside their actual space.

- At shell, Details, composer, Assistant, and resource split breakpoints owned by
  the routed functional contracts, preserve the same semantic hierarchy rather
  than inventing another control or navigation model.
- At `>=1024px`, the single sidebar starts open and may collapse completely;
  at `900–1023px` it starts collapsed; below `900px` the same navigation becomes
  the sole scrim-backed drawer. Collapse never leaves an icon rail or duplicate
  accessibility-tree navigation.
- Validate at 384/390x844, 844x390, 768x1024, 1024x512, 1024x768,
  1280x500, 1280x800, the 899/900 and 1023/1024 shell boundaries, and 1440px
  wide composition, including enlarged root text.
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

AI-specific presentation is evidence constrained. Stage labels and transitions
come only from the functional run-evidence owner; the visual layer never
creates a stage from elapsed time, prose, or animation.

- Source counts come from actual surfaced evidence; confidence is never inferred from prose length or model identity.
- A failed or partial stage remains visible and understandable.
- Provider/model identity stays legible where it affects user choice or evidence.
- User data, attachments, provider payloads, internal IDs, group metadata, and secrets follow the existing privacy contracts in every empty, error, debug, receipt, and share state.

## Visual Review Gate

Before propagating a new recipe, render and critique one representative Chat state and one representative Control Center state from real components and deterministic data. Review hierarchy, density, content truth, long text, dark parity, and the smallest supported viewport. Raster concept art may guide composition but never establishes product capabilities or exact copy.

Every new or changed visual recipe must satisfy these conditions before it becomes the product default:

- it reads as the same system in light and dark themes;
- every v2 gallery state has a deterministic paired light/dark baseline, and the
  shell responsive matrix records both themes at each owned viewport rather
  than treating light as a desktop-only spot check;
- primary and secondary actions are unambiguous without badge/color dependence;
- loading, empty, error, busy, success, destructive, and long-content states are covered as applicable;
- safe-area, software-keyboard clearance, overflow, and coarse-pointer composition are verified;
- the evidence row, Run details, and other AI stages show only real state;
- affected capability and state contracts have test/evidence references;
- no superseded renderer, component-local color recipe, obsolete token, or implementation-shape test remains.

Use these audits during implementation:

```bash
rg -n '#[0-9a-fA-F]{3,8}|rgb\(|rgba\(|hsl\(|oklch\(' components features app styles
rg -n '(bg|text|border|ring)-(blue|indigo|violet|purple|sky|emerald|teal|cyan|lime|orange|yellow|red|pink|fuchsia|gray|neutral)-[0-9]' components features app
rg -n 'bg-gradient|from-|via-|to-|backdrop-blur' components features app
rg -n 'bg-black/|className=.*dark|theme: "github-dark"' components features app tailwind.config.ts
```

Investigate every product-code hit, then run the proportional checks in `TESTING.md` and inspect affected runtime states directly.
