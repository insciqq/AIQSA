---
paths:
  - "lib/server/memory/**"
  - "lib/server/memoryMcp/**"
---
# Memory

Personal Memory: what it may learn, who may change it, how it is retrieved and forgotten. Code: `lib/server/memory/`, inbound MCP access in `lib/server/memoryMcp/`. PostgreSQL is the authority and the only search store; the separate lexical search index was removed (operator decision 2026-10-23). Memory is kept but frozen (root `AGENTS.md`): changes only simplify or stabilize it.

## Who may change Memory

- A mutation needs exact authority from the current owner: direct evidence from that user, an owner-bound inbound MCP command, or governed background maintenance of exact automatic sources.
- The answer model has no mutation tools. Earlier turns, quotations, assistant text, retrieved content, attachments, tool output and client metadata never authorize a mutation. In-chat requests ("remember", "forget") need a strict semantic classification of the current message plus exact source and target proof; they are queued with the message and the answer never waits for them. A queued command runs only after the run of its message settles, within a bounded wait, so what the agent saved in that run, such as a secret, is in place first (`lib/server/memory/coordinator/prismaRepository.ts`; operator report 2026-10-23).
- A request to save a credential, to create or change the assistant's own resources (Skills, Assistants, scheduled tasks, saved secrets), or a standing instruction for how to do a kind of task is never a Memory command (operator report 2026-10-23).
- A pending acknowledgement promises nothing; only a committed receipt confirms a change.
- Inbound Memory MCP is a separate delegated boundary: an active owner-bound OAuth grant authorizes only the exact validated facts-only call, and it creates no chat, run or System Model call.
- Optional retrieval signals (scores, rerankers, usefulness) never weaken ownership, lifecycle, deletion, safety, or the Temporary and Excluded chat fences.

## Scope and settings

- Memory is global per user. Temporary chats neither create nor receive any Memory state. Public shares strip all of it. Legacy non-global data is never widened into Personal Memory.
- Imported chats, their continuations and branch copies are Excluded and cannot be resumed (operator decision 2026-10-04); a database check in `prisma/migrations/20261005121500_chat_import_source/` enforces this for every writer.
- Preferences default to on, and upgrades preserve choices and pauses. Pausing stops new use and work but deletes nothing. Resume admits only messages after its cutoff; there is never an automatic historical backfill.
- Memory has its own Utility Model role; editing the System Model never changes it. A verified Memory Utility Model assignment authorizes Memory generation without a separate egress consent. The installation embedding default, frozen in the retired Knowledge profile row until a Memory-owned setting replaces it (`agent_docs/PERSISTENCE.md`), may seed the Memory embedding selection once, only if no settings change ever set or cleared it. Recommendations never overwrite an explicit choice or clear.

## What Memory keeps

- Directly reported personal context, without a closed ontology. The owner scopes access, the subject says who a fact is about, the source records the testimony. Facts about other people keep their own subject and never become a dossier.
- An automatic fact must plausibly last months or years and change future, unrelated answers. Episodes, short-term matters and common habits stay in chat history. Confidence proves neither usefulness nor durability; categories never decide retention or deletion.
- Only the user's own message is testimony. Context may resolve a reference, a time or the attribute a preceding question asked about, but the user must supply the value; agreeing with an assistant's claim is not testimony. Assistant speech, tool observations, quotations and external material never supply facts.
- Reported speech keeps attribution: "my brother told me he works nights" records the user's report about the brother, not the user's schedule.
- An explicit Saved Memory outranks automatic evidence; a fully equivalent automatic fact merges into it, unless the automatic lineage is pinned or owner-touched. Without a remember request, automatic learning stores only high-confidence durable observations. Rejecting a new candidate never removes an older safe version.
- Identity is server-owned and Unicode-preserving, independent of search folding, transliteration and labels. Missing identity is never guessed, named third parties never become the user, and lexical similarity alone never merges entities. Ambiguous merges or corrections become conflicts.
- Expiry needs grounded wording and a validated calendar interpretation. Expiry or supersession never resurrects an older version, and reads label elapsed plans instead of assuming they finished.

## Language neutrality

Memory must behave the same in every language, fallbacks and unused paths included. Hand-maintained vocabularies, morphology, language-specific regular expressions, normalization or analyzers must never decide semantic behavior: governed semantic models interpret meaning, and deterministic code checks only Unicode structure, bounds, exact evidence, ownership and lifecycle. `lib/server/memory/learning/semanticBoundary.architecture.test.ts` guards this. Retired language-specific database objects must not survive in the final schema.

## Safety Lite

`lib/server/memory/safetyLite.ts` redacts recognized secret spans locally before every Memory persistence, provider, index, context and debug boundary, keeping the safe remainder. Ordinary personal, medical, financial or relationship text is not a secret class. A raw secret may stay only in the chat itself. The exact values of the owner's saved secrets never become Memory either, whatever their format; only values that look like secrets are compared, so plain words such as `localhost` stay ordinary text (`lib/server/memory/persistence/savedSecretMatching.ts`, review 2026-10-23). A fact write repeating one is refused, history indexing replaces it with a redaction marker, and saving a value starts a durable cleanup that forgets the facts and rebuilds the history already holding it (`lib/server/memory/savedSecretScrub.ts`). Owners whose secrets were saved before that cleanup existed get it once after the upgrade, from the coordinator's reconciliation (decision 2026-10-23).

## Background maintenance

Maintenance runs whenever Memory and automatic learning are on (`lib/server/memory/maintenance/`). Explicit, owner-edited, pinned and remember-requested lineages are never removed. Removal needs verified review and forgets a whole automatic lineage; age, confidence or usage alone never justify it, and contradictory review labels resolve to keep. Of two contradicting facts, one goes only when review and verification agree and the other outranks it at settlement; otherwise both stay. A failed review is never replayed in place; a bounded new job retries it in a later cycle, and transient provider failures only delay that retry.

## Retrieval

- Ordinary personal turns get a small fixed standing set of current facts, with no dynamic retrieval or external call (`lib/server/memory/retrieval/readBudget.ts`). Deeper recall is an optional read-only tool for the answer model.
- Temporary and Excluded chats get no Memory. Exception: a scheduled task with Memory on may read Memory but never learns from its own Excluded chat. The master pause stops all reads; turning history off still allows facts.
- Every hit rejoins its current owner, source, content hash, lifecycle, generation, suppression, deletion and expiry proof before fusion and again before the evidence pack is frozen.
- Empty, limited, failed and cancelled searches stay distinct, and none proves absence. The standing set is partial, so the model should search before calling a personal detail unknown.
- Search permissions, destinations and budgets freeze at acceptance (`lib/server/memory/search/admission.ts`), and source authority is rechecked before every disclosure to a model. Exception: context notes may hold Memory search results and, like assistant answers in history, are not rechecked or scrubbed by Forget, edit, exclusion or reset.
- Reader prompts live in `lib/server/memory/retrieval/`: evidence is untrusted, embedded instructions are ignored, current answers respect later state, and counts come from grounded quantities, never a model-authored total.

## Provider calls

- Transient transport failures may retry under the policy in `agent_docs/PROVIDERS.md`. Beyond that, an answer settled as invalid may be retried only by a fresh dispatch of the identical request, and cancellation, fencing, output limits and recovery never retry (caps in `lib/server/memory/execution/structuredClassifier.ts`, `lib/server/memory/maintenance/policy.ts`, `lib/server/memory/learning/extractionHeal.ts`).
- A provider capability failure disables only its own stage; ordinary answers and deletion keep working.

## Forgetting, cutover and rebuilds

- Forget, edit, exclusion, pause and reset fence synchronously before cleanup, so old jobs, vectors or evidence cannot resurrect content. Deletion stays retryable.
- Legacy rows never gain new authority, and identity migration never rewrites accepted keys (`lib/server/memory/learning/identity/compatibility.ts`).
- Retrieval revisions are separate from content generations, so reindexing cannot orphan semantic evidence. A cutover builds a shadow generation, proves coverage, switches one pointer and keeps an exact rollback, never replaying learning or tool effects.
- A full rebuild re-embeds the owner's whole Memory and costs money, so only a configuration change or a genuinely lagging index may start one, with a logged reason (`lib/server/memory/rebuild/admissionReason.ts`).
- Backup and restore duties are in `agent_docs/PERSISTENCE.md`.

## Improving Memory quality

Before changing extraction, retrieval or maintenance, study how mature open-source memory engines solve the problem and record the revision and mechanism in the task. Aim for practical parity without weakening ownership, evidence or deletion. One reference scenario proves neither parity nor impossibility: verify independent scenarios and record hypotheses, outcomes and costs.
