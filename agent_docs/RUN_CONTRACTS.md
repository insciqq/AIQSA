# RUN CONTRACTS

Owner: Run pipeline maintainers
Scope: Accepted execution, context, tools, evidence, recovery and outputs.

[Critical invariants](CRITICAL_INVARIANTS.md) owns historical immutability, tenancy and privacy. Executable contracts live in [runs](../lib/server/runs/) and their domain owners.

## Admission And Context

Admission freezes non-secret execution/dependency/credential/budget bindings. Assistants use authorized complete definitions, never client expansions. Recovery preserves execution/identity; regeneration re-admits. Projects continually recheck authority, shared credentials, revocation and configuration.

Context follows active ancestors, never siblings. Preserve user turns after errors/partial answers; deduplicate identities and reject replay. Trim prior turns within limits; reject irreducible overflow. Ordinary runs use server baseline plus Project instructions.

Observation-v1 runs mask envelopes to reader references, retain the newest batch plus instructions/current input/follow-ups, and checkpoint bounded branch/source refs. Unknown shapes, split batches and Agent history stay untouched. New ordinary Chat/Workspace admissions freeze `hybrid`: `needs_summary` invokes a bounded summary on the admitted answer binding, then commits notes/attempts with source revision; accepted legacy-compatible/off runs remain legacy, and committed hybrid failure never falls back to trimming. PDF/OCR remain standalone guards; conversational PDF continuations use the same answer consumer.

Personal presets supplement ordinary personal/temporary chats, never Assistants/Projects. They may replace answer rules without authority; date/time uses baseline zone. Assistants freeze hidden reminders with content/attachments. Both survive recovery and stay out of previews/utility prompts. Knowledge keeps accepted instructions/effective question; instructions are not Memory facts.

Acceptance transfers execution server-side; disconnect never cancels preparation/commands. Stop, deadlines and authority remain. Recovery uses live owners without replay; PDF gates eligible Memory and final admission refreezes authority/evidence. Preparation forbids provider/tool I/O. Optional Memory failure cannot bypass authority; Temporary/Project bypass Memory.

Follow-up orders user input within accepted bindings/budgets without repeating preparation. Acceptance races publication; delivery proves receipt, not obedience. Preserve partial text, settle dispatched tools, skip obsolete decisions, fence old generations. Recovery closes admission; executor loss ends clarified tasks. Regeneration re-admits clarifications.

Continuation summarizes active-branch text through the admitted System Model, excluding tools, attachments and Workspace inspection. Enabled Workspace may copy project files unread into a private single-use seed. Preserve ownership, retention, source and conversation; never repeat interrupted provider work. [Frontend](FRONTEND.md) owns draft transfer.

Skills grant no capabilities. Peers/Projects require approved revisions and audience authority. Off preserves pins; Projects ignore personal preferences. Filtering cannot hide required dependencies. Reads reauthorize; settled results replay privately. [Security](SECURITY.md) owns redaction.

Catalog relevance defaults off, receiving only user text/authorized metadata. Complete evidence may filter/order available Skills. Provider failure preserves the catalog; authority loss/cancellation fails closed. Recovery reuses accepted selection/dispatch evidence.

Workspace stages frozen bundles. New runs reset managed Skills; recovery preserves edits or restores pins/settled loads after recreation. Loads replace files after context acceptance. Agent discovers available Skills natively, receives pins as user instructions, and disables bundled Skills. Catalog/mode/profile changes invalidate continuation, excluding reads.

Agent requires personal manual Workspace. Codex owns planning/tools/compaction/completion; AIQSA owns authority/accounting/settlement, without evaluator/truncation. Resumes refresh paths/Skills/instructions and freshly authorize compatible MCP candidates against exact definitions/configuration. Discovery-required failures precede dispatch; discovery never replays business operations. Follow-up preserves files/native session after proven process/transport closure, fences grants and confirms native receipt. Unsettled effects prohibit interruption; Stop is terminal. Knowledge/Memory unavailable; artifacts/images/query-only Search survive MCP Off. Auto discovers/dispatches; All explicit.

Off removes Agent time/call/token/output caps, preserving accounting/leases/Stop/model constraints. Retries retain results, authority/budgets and receipts. Persist first terminal cause before revocation; never replay execution, extend deadlines or buy summaries. MCP exhaustion permits generation; grants remain independent of inbound OAuth.

## Search And Documents

Search freezes exact logical sources and hosted/query-only routes. Off, inheritance and explicit selection remain distinct. No source is silently dropped or substituted. Attachments do not disable selected Search: the query-only disclosure boundary in [Providers](PROVIDERS.md) prevents file data from entering client Search. Partial fan-out is explicit and findings remain untrusted data.

Chat PDF admission selects a verified route and freezes its destination before preparation. Required document work gates answer/Search/Knowledge/MCP dispatch and final context budgeting. The preparation model transcribes only; it does not become the answer model or create Knowledge. Local extraction carries a reading-quality caveat. An admitted Workspace run may survive classified transcription failure with its verified original and an explicit unread-content notice; access, integrity, cancellation and budget failures remain blocking. An accepted model route never silently falls back. Explicit retry creates a sibling, revalidates that route and may reuse compatible settled pages. Browser navigation does not own worker lifetime.

Knowledge ingestion follows its immutable Profile, exact document role and private local/original-page/image disclosure route. It does not borrow Memory's role or silently change destination. Crash-ambiguous dispatched work is never blindly replayed. Explicit Reprocess creates a new generation, preserving old attempts and reusing only checksum-verified settled work.

Transcription preserves visible text and meaningful visual information without inventing hidden values, causes or intent. Native PDF text may augment model structure only through the versioned safe alignment policy. Table relationships require structural evidence independent of cell text; uncertain rows, units and associations remain uncertain. Numeric normalization preserves exact decimal values and does not convert units or derive facts. Changes to parser/chunk policy create immutable profiles; ready artifacts change only through reprocessing. See [PDF output](../lib/server/parsing/modelPdfOutput.ts), [chunking](../lib/server/knowledge/chunking.ts) and [document context](../lib/server/knowledge/documentContext.ts).

## Knowledge Evidence

No scope means no Knowledge I/O. Freeze authorized Sources, immutable ready Versions/artifacts, Profile destinations and exclusions at admission; later membership/Profile changes cannot alter evidence. Ready subsets disclose exclusions; processing-only scopes fail before I/O. Capacity cannot silently narrow scope, nor equal content merge Source authority.

Admission selects full-corpus delivery when it fits the exact provider envelope, otherwise bounded `search_knowledge({ query, sourceAliases })` in the ordinary tool loop. Aliases are run-local disclosures, not scope grants; later narrowing can use only previously disclosed Sources. Every call rechecks scope, egress, projection readiness and frozen budgets before external work. Internal source-reading/discovery helpers do not become answer-model tools. Historical focused protocols remain recovery-only.

OpenSearch provides candidate identities and scores within immutable scope; PostgreSQL revalidates authority. A required lexical projection or backend failure fails visibly rather than becoming empty evidence or a silent dense-only/PostgreSQL fallback. Classified query-embedding unavailability degrades only that lane. No relevant evidence, unavailable retrieval, cancellation and invalid answer output remain distinct outcomes. Settled unavailability receipts replay without external I/O. [searchFailure.ts](../lib/server/knowledge/searchFailure.ts) and [searchProjection.ts](../lib/server/knowledge/searchProjection.ts) own failure and repair.

Retrieval combines independently eligible signals; weak proximity alone is insufficient. Source/Version/artifact/passage provenance defines occurrence identity, not content or membership. Diversity changes ordering only. Optional same-Source context stays labelled and cannot displace primary evidence. Omit over-budget exact excerpts whole with a reason. Rewrites retain the original question and constraints; search/packing policies stay independently frozen. See [retrieval core](../lib/server/knowledge/prismaRetrievalCore.ts) and [occurrence identity](../lib/server/knowledge/evidenceOccurrence.ts).

Optional relevance checks reduce unrelated context, without promising speedup or replacing ranking. Only complete cohorts may filter; partial/absent/failed checks preserve baseline. Exact/full-corpus reads bypass them. Freeze destination or absence at acceptance, enforce revocation and reuse settled receipts/usage. Default adoption requires consumer qualification and preserves administrator choices.

Both routes require Source-bound evidence and independent review of the original request, delivered evidence and candidate blocks. Composition cannot declare sufficiency; matching citations are not proof. Code derives coverage from supported requirements and enforces reference integrity, not semantic truth. Useful partial facts and valid derivations survive incomplete coverage. Exhaustive requests remain exhaustive; unavailable resources or missing premises prevent claims of completeness or corpus-wide absence.

Search-driven revision requires new delivered evidence; factual correction requires an explicit bound critique. Further retrieval preserves previously supported content and the delivered premises of a requested correction. Unchanged drafts/evidence do not receive repeated paid review, and failed optional correction preserves the latest verified partial answer and incurred usage. Structural repair uses unchanged authority inputs and a bounded rejection hint, never rejected provider content. Accepted prompts, schemas, reasoning policies and bindings remain frozen. Recovery decodes the accepted protocol, reuses settled operations and never applies current defaults to historical runs. See [review](../lib/server/knowledge/evidenceAnswerReviewV2.ts), [execution](../lib/server/knowledge/evidenceAnswerExecutionV1.ts) and [replay](../lib/server/knowledge/evidenceAnswerReplayV1.ts).

Publication is deterministic and provider-free. It revalidates exact excerpts and citation handles against the accepted manifest. Tool-result citations require completed persisted results and proof of delivery before synthesis. Pending, unknown, failed or undispatched evidence cannot support citations. Grounded token deltas remain private until settlement; internal wrappers and status lines never become answer prose. Source deletion preserves generated text but scrubs private evidence and later citation resolution. Engine improvements require general mechanisms and neutral regressions; benchmark answers and case identities never become product rules or ordinary test expectations.

## MCP And Workspace

MCP Auto, Load all and Off require explicit user action. Auto freezes authorized capabilities and the System Model. An admitted optional route may select one sufficient capability; uncertainty/unavailability preserves the full route. Never substitute destinations. Discovery fails closed without lexical fallback. Reauthorize and checkpoint selection before exposing schemas; recovery never reroutes. Only relevant servers and exact Load all/Assistant allowlists are dependencies. Persist batches before execution; preserve provider order and accepted budgets. Exhaustion disables tools for final synthesis and displays the limit.

Deduplicate representations; preserve unique content, ambiguity, errors, Hub results and receipts.

Freeze observation `off`/`v1` at acceptance; absent/off stays legacy without backfill. V1 retains originals; recall reauthorizes source/branch access and preserves truncation/instruction/citation authority, never proving delivery.

Workspace freezes ready runtime/image, official catalog, network, paths, authority and secret revisions. Server controls sandbox identity, VM lifecycle, host-copy/networking; execution/export is chat-exclusive. Guests receive verified run-visible originals and restored personal secrets under [Security](SECURITY.md). Relevance follows current-message/branch references independently of staging. Check authorized inbox index before repeat uploads; entries cannot prove surviving guest bytes.

Mid-run capture requires coherent bytes and current authority; unsupported coherence fails closed. Preserve the running executor and final-export quiescence. Shared image validation is model-independent; transformations retain source identity/geometry. Consumers own publication/provider delivery.

New Workspace runs use independently admitted System Vision regardless of answer model/provider. Native/direct viewing is disabled. Only ordered selected images and a focused question reach Vision; results remain untrusted. Unavailability never substitutes routes. Accepted runs retain frozen modality and recovery evidence.

Exact image edits preserve pixels; generative edits synthesize requested changes. Source/reference/version provenance determines identity. Saving, visual inspection and application validation remain separate claims.

A published answer may accept one successor with frozen intent/configuration. Until handoff it has no Workspace authority or Memory/provider/tool I/O. Bounded, independently cancellable waiting survives browser loss. Revocation permits settlement of rejected work. Recovery completes handoff without changing published text/accounting, replaying answers or duplicating charges.

Every terminal path retires guest execution authority: stop registered processes, or the VM with disk intact when execution is unproven/crash-ambiguous. Stop preserves the environment; successful turns leave no background processes. Replay settled calls, never ambiguous mutations. Completion requires closed durable output obligations and retired guest authority; private-object transfer continues independently/idempotently. Export failure preserves the answer; path escape, symlinks, special files and bounds violations fail closed. Recovery discovers protected outputs without command/provider replay. Browser activity is a bounded safe projection, never raw runtime state.

## Settlement And Outputs

Completion requires provider-specific terminal proof. Failure, truncation, timeout and cancellation preserve accepted partial text and reported usage without false success. Guarded transactional settlement has one winner. Cancellation promptly stops later work/durable stream writes; stale reconciliation cannot sweep newer live runs. Recovery uses exact accepted checkpoints/bindings, never browser truth, reconstructed provider prose or repeated ambiguous effects.

Unknown command exit, confirmed environment stop and durable cleanup are distinct. Local publication/accounting failures preserve reported usage without authorizing replay or establishing provider failure. Never infer diagnostic causes from exception prose.

Client/Project streams expose lifecycle, answers, semantic activity, safe sources/outputs, errors and usage; never raw payloads, provider parameters, private evidence/identifiers or receipts. Expired invalidation streams require canonical resync; access loss closes them. Context estimates describe the current envelope, not cumulative billing.

Artifact edits never rebase; reads/hints stay private. Agent bundles grant no host-path authority. Context changes invalidate continuation. Atomic settlement respects revocation/resource ceilings. Received images retain accounting after Stop; verified Workspace staging grants no paid replay. Previews: [Frontend](FRONTEND.md).

Accounting uses provider-reported categories with exact stage/model attribution. Missing usage or price stays null; recovery enriches the same outcome without double counting. Shares use [Backend](BACKEND.md)'s positive snapshot schema. Gemini-grounded answer text survives ordinary settlement and sharing, while Suggestions, citations and structured artifacts stay private; discarded legacy answers cannot be reconstructed and unfinished legacy work must be fenced before removing replay-critical provenance.

Optional titles never delay answers. Freeze excerpt/destination; never replay ambiguous dispatch. Renames/chat lifecycle fence results; retain reported usage even when unapplied.
