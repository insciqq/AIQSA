# ADR 0016: Responsive Composer Disclosure Preserves Run-Control Ownership

Status: Accepted
Amends: 0011-explicit-next-run-control-ownership

## Context

At narrow phone widths, the permanent Profile, Model, Reasoning, Search, Run settings, context/usage, and action rows consumed roughly half of the useful conversation viewport. The transparent textarea had no visible label or local field boundary, while narrow Reasoning and Search triggers truncated their selected values. The controls were physically present without making the draft or the next-run state legible. Reducing touch targets would violate the coarse-input contract.

The operator approved responsive progressive disclosure and a text-backed visual meter for the active profile and reasoning level. TypingMind remains a density reference rather than a layout or icon-only specification.

## Decision

1. Composer-control state, persistence, entitlement filtering, action ownership, and next-run semantics do not change. Responsive presentation uses the existing composer control owner rather than introducing a second draft or settings store.
2. At `sm` and wider with more than 32rem of viewport height, ADR 0011's direct Model, Reasoning effort, Search strategy, and Run settings controls remain. The compact profile group remains directly above them when available.
3. Below `sm`, or in a viewport at most 32rem high, one labeled `Run` summary replaces the permanent profile group and individual control row. Without opening it, the summary exposes the current concrete model, derived Profile or `Custom`/unavailable state, exact Reasoning mode and effort or unsupported state, and Search strategy or `Off` state in text.
4. The narrow summary may pair Profile and Reasoning with one changing meter each to speed scanning, but the meter never replaces its readable value and selection never depends on color alone.
5. The summary opens one safe-area-aware, locally scrolling `Run setup` sheet backed by the same composer controls. The sheet gives discoverable edit paths to Profile, Model, Reasoning, Search, Prompt, generation controls, response behavior, display preferences, and sound. It has an explicit Close action and keeps nested picker Escape behavior local.
6. The message draft remains inside the coherent composer frame as a visibly labeled and bounded input plane rather than visually merging the settings region into the field. In a short-height viewport only, the visible label and textarea share one row so the conversation keeps useful height without shrinking the 44px input target.
7. Context/usage, attachment, and Send/Stop share one compact action footer at narrow widths. Capability, autosave and numeric-flush behavior, keyboard access, software-keyboard viewport behavior, and 44px coarse-input targets remain unchanged.

## Consequences

- ADR 0011's persistent direct Reasoning/Search editor requirement applies at `sm` and wider when the viewport is taller than 32rem. In narrow or short-height composition, their exact current states remain persistently legible while editing moves one tap into Run setup.
- Mobile density comes from progressive disclosure, not smaller controls or unexplained icon-only states.
- A phone-sized idle composer preserves most of the viewport for the conversation while retaining complete run-control access.
- No backend, persistence, entitlement, provider, or run-payload behavior changes.

## Addendum (2026-07-18)

Software-keyboard evidence on a 6.7-inch phone showed that clause 6's short-height
side-by-side visible label consumed the start of the only writing row and pushed
the caret/placeholder toward the middle of the field. Narrow (`< sm`) or
short-height (`<= 32rem`) composition hides the external `Message` copy while
keeping the bounded draft plane and `Ask AIQSA…` guidance visible. Wider/taller
composition still shows the external label. This amends only clause 6's
responsive label presentation, not draft semantics or the 44px target.

## Addendum (2026-07-19)

Frequent switching between Fast/Balanced for ordinary questions and Deep for
difficult questions makes the extra Run-summary-to-sheet interaction a material
compact-workflow cost. Clause 3 is amended narrowly: below `sm` or at no more
than 32rem height, the individual Model/Reasoning/Search/Run-settings row still
collapses into the complete text-backed Run summary, but the entitled
Fast/Balanced/Deep profile group remains directly selectable in the compact
action footer. Unavailable siblings stay visibly disabled with their reason,
and the same composer-control action remains the only owner of profile changes.

To preserve the compact footprint from clause 7, the long inline context
estimate yields its footer space to those profile actions. The existing labeled
context/usage statistics icon now exposes approximate input, safe input budget,
total context, and provider-reported active-branch usage. Wider/taller
composition keeps its inline context estimate and existing direct profile row.
This changes only responsive disclosure, not profile definitions, catalog
entitlements, persistence, context budgeting, run payloads, or control state.
