# FRONTEND ANSWER OUTPUTS AND BRANCHES

Owner: Chat interaction maintainers
Scope: Settled-answer outputs, Sources, generated files, explicit mutation confirmations, Branch access, and responsive overlay behavior.
Read when: Changing answer-bound Sources or generated outputs, tool/Memory confirmations, Branch checkout, or their drawer/sheet access.
Code owners: The focused answer-output presentation, `features/branches-v2/`, message/thread owners, and their exact client-safe projections.
Not owned here: Composer input, next-run controls, provider persistence, internal recovery records, or visual token recipes.

## Product Boundary

- AIQSA does not expose a generic answer evidence row, Run details drawer, Events tab, recorded receipt, request preview, accepted-parameter summary, post-hoc tool trace, retrieval score panel, or per-answer token receipt.
- The absence of those surfaces is deliberate. Internal records may still exist when required for execution, recovery, prevention of duplicate side effects, security, retention, or aggregate accounting; they do not become a browser projection merely because they are persisted.
- There is no hidden user preference, administrator mode, or permanent feature flag that restores the removed inspector as the final implementation state.

## Settled Answer Outputs

- An Assistant answer keeps document presentation. An accepted Assistant revision may add its frozen display identity only where that identity is already part of the answer contract; freeform answers remain neutral. Historical identity never follows a later rename, archive, or access change, and anonymous public snapshots do not gain private identity.
- A settled answer contains only user-relevant material: answer text, inline citations, an optional simple `Sources` disclosure when at least one safe source exists, generated files or other explicit output artifacts, optional provider-supplied Reasoning, normal message actions, and persisted confirmations for user-approved mutations.
- `Sources` is not a run summary. It lists safe citation/source labels and safe credential-free HTTP(S) destinations already bound to that answer. It does not expose generated Search queries, attempt ordinals, provider operations, route/revision identities, Knowledge scores, thresholds, candidate counts, embedding details, or internal ids.
- When no safe source exists, no Sources placeholder or zero count renders. Source counts are derived from the exact client-safe answer projection, never inferred from prose or raw internal events.
- Input attachments stay attached to the user question that supplied them. They are not repeated as an answer-side file count. Generated files remain versioned outputs bound to the exact assistant message and branch that produced them.
- Post-hoc MCP tool arguments, tool results, schemas, endpoints, fingerprints, and invocation traces do not render. A tool that requires user approval still presents its approval before execution; a committed user-visible effect may present a concise persisted success/failure confirmation after execution.
- Memory Save, Update, Forget, or equivalent mutations show a confirmation only after the exact persisted action committed. Retrieval internals, admitted Memory text, planning lanes, item counts, and lifecycle receipts do not become a resting answer disclosure.
- Hosted Gemini grounded markup remains a live-only isolated ShadowRoot exception. It never enters Markdown, an iframe, or ordinary document-tree HTML, and reload does not reconstruct transient provider markup from current state.

Exact message actions, Markdown, citations, Reasoning, generated-file cards, and share behavior remain owned by [Messages and Markdown](../MESSAGES_AND_MARKDOWN.md).

## Live Run Presentation

- While a run is active, its answer may show streamed text and one concise factual status derived from normalized lifecycle state. Missing events never manufacture a phase, percentage, or elapsed-time claim.
- Stop remains available according to the durable cancellation contract. Connection loss, retryable terminal errors, and outcome-unknown recovery expose the existing actionable `Refresh`, `Retry`, or `Check run` path without opening an inspector.
- Stable error codes and private run identifiers remain internal. User copy is concise, actionable, and bound to the originating answer.

## Branches

- `Branches` is a standalone conversation-history function. It opens a temporary drawer bound to the active chat's compact branch graph and is not stored under a generic Details mode or inspection tab.
- It presents readable Q/A previews, current-path state, real fork/version counts, and explicit checkout of immutable alternate leaves without exposing message ids.
- Editing a user message or regenerating an answer creates another branch; it does not rewrite history. Edit mode keeps its draft in the existing keyed composer and states that consequence beside the field.
- Checkout changes only the future active leaf. The conversation, composer target, and pager reconcile to that leaf; the drawer does not borrow another chat's graph. Branch mutation and checkout remain disabled while a response is active with a visible reason.
- Loading, empty/linear, error/retry, streaming, stale graph, and checkout-pending states remain truthful. A root-level fork is not flattened into a linear conversation.

## Layer And Responsive Contract

- Branches and generated-artifact preview are modal at every viewport. Background content is inert, focus is contained, Escape closes only the top layer, backdrop/Close are explicit, and focus returns to the exact opener when it still exists.
- Desktop uses a bounded right-hand drawer. Below `900px` the same semantic task becomes a full-viewport sheet with safe-area padding and one local vertical scroll owner.
- Closing Branches or an output preview has no parameter, run, or composer side effect. Next-run setup remains the only editor for future model and parameter drafts.
