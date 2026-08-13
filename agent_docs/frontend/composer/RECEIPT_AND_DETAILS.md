# FRONTEND EVIDENCE, BRANCHES, AND RUN DETAILS

Owner: Chat interaction maintainers
Scope: Answer-bound evidence, Branch access, exact persisted Run details, overlays, and responsive inspection.
Read when: Changing evidence counts/disclosures, Branch checkout, Run-details projection, inspection loading/error states, or drawer/sheet access.
Code owners: `features/evidence-v2/`, `features/branches-v2/`, `features/run-details-v2/`, and their focused headless run/thread owners.
Not owned here: Composer input, next-run controls, navigation, provider persistence, or visual token recipes.

## Answer-bound evidence

- An Assistant answer keeps document presentation. An accepted Assistant revision may add its frozen display identity; freeform answers remain neutral. Historical identity never follows a later rename, archive, or access change, and anonymous public snapshots do not gain private identity.
- Every settled answer with an accepted run owns one quiet evidence row. In order it contains only nonzero `Sources N`, `Tools N`, and `Files N`, followed by `Run details`. `Files` counts accepted input attachments, not synthetic generated output. Usage affects the Run-details accessible name but does not create another row item. Memory never becomes a resting count.
- The server serializes the content-free `evidenceSummary` with the exact assistant message. The browser does not infer counts from prose, current settings, a different answer, or raw events. Active messages and messages without an accepted run expose no settled projection.
- Search, Knowledge, MCP, citations, reasoning, Memory, and first-party Memory-action results remain disclosures on their originating answer. Safe HTTP(S) links are credential-free; provider/tool output is untrusted bounded text; opaque ids, endpoint/config values, credentials, and unrestricted payloads never render.
- Frozen Memory evidence remains bound to the exact admitted run item. Current rows may add only a later lifecycle fact such as `Later forgotten` or `Source deleted`; they never replace admitted text. A deleted source loses its action. Feedback, Undo, Save, Update, and Forget confirmations require their persisted exact provenance/receipt and never announce merely planned work.
- Hosted Gemini grounded markup remains a live-only isolated ShadowRoot exception. It never enters Markdown, an iframe, or ordinary document-tree HTML, and reload does not reconstruct transient provider markup from current state.

Exact disclosure semantics and message actions remain owned by [Messages and Markdown](../MESSAGES_AND_MARKDOWN.md). This document owns only their inspection destinations and exact answer/run binding.

## Run details

- `Run details` opens one temporary modal drawer for the exact persisted run and assistant message that own the initiating evidence row. It starts closed, never pins, never creates a grid column, and never changes conversation width. A late or mismatched read fails closed instead of appearing under another answer.
- Loading, unavailable, owner-private read failure, mismatch, empty, and retry states are explicit. The last useful projection is not relabelled as current during a retry.
- The drawer is inspection, not a next-run editor. It presents the persisted chronological digest; accepted model, Assistant, branch, Search, Knowledge, MCP, Memory, input-file, and whitelisted parameter facts; bounded evidence sections; provider-reported usage; and a constructed redacted request preview.
- Provider/model labels resolve through the current entitled catalog. A missing entry uses an unavailable label rather than exposing stored deployment identity. Internal cost estimates never render as provider billing evidence.
- Request, argument, result, error, and evidence previews are recursively bounded and redacted. Raw normalized content, provider payloads, schemas, endpoints, fingerprints, credentials, private bindings, and opaque ids remain absent. Long exact text uses a local scroller or truthful wrapping without widening the page.
- Memory remains a dedicated drawer section. It uses frozen admitted text/provenance, permits only later lifecycle annotation from current rows, and removes stale source links. A committed action appears only from its persisted applied receipt.

## Branches

- `Branches` opens a separate temporary drawer bound to the active chat's compact branch graph. It presents readable Q/A previews, current-path state, real fork/version counts, and explicit checkout of immutable alternate leaves without exposing message ids.
- Editing a user message or regenerating an answer creates another branch; it does not rewrite history. Edit mode keeps its draft in the existing keyed composer and states that consequence beside the field.
- Checkout changes only the future active leaf. The conversation, composer target, and pager reconcile to that leaf; the drawer does not borrow another chat's graph. Branch mutation and checkout remain disabled while a response is active with a visible reason.
- Loading, empty/linear, error/retry, streaming, and stale graph states remain truthful. A root-level fork is not flattened into a linear conversation.

## Layer and responsive contract

- Branches and Run details are modal at every viewport. Background content is inert, focus is contained, Escape closes only the top layer, backdrop/Close are explicit, and focus returns to the exact opener when it still exists.
- Desktop uses a bounded right-hand drawer. Below `900px` the same semantic task becomes a full-viewport sheet with safe-area padding and one local vertical scroll owner.
- Run setup remains the only editor for next-run model and parameter drafts. Closing either inspection layer has no parameter or composer side effect.
