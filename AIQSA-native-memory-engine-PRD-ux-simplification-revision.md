# AIQSA Native Memory Engine — UX Simplification Revision (Revision 2)

**Status:** operator-approved contract delta; merge target is `AIQSA-native-memory-engine-PRD.md`<br>
**Approved:** 2026-08-11, direct operator decision (five-point UX review)<br>
**Authority:** where this document conflicts with the PRD, this document wins. Until physically merged, the PRD sections listed below are read as amended. The implementing agent merges each amendment into the PRD and the owning living documents in the same slice that changes the behavior, per Contract Authority rules in `AGENTS.md`.<br>
**Product direction:** match the chatgpt.com memory UX. The installation is admin-operated; every provider, Search backend, and MCP server is connected by the admin. The operator explicitly accepts the ChatGPT-equivalent residual prompt-injection/exfiltration risk that follows from combining memory with Search/tools.<br>
**Phase ordering:** unchanged. This revision changes policy/UX contracts only; it does not reorder phases or weaken the substrate listed under "Unchanged protections".

---

## R2-1 — Defaults and enablement

Supersedes: §15.2 default values, §23.1 first-enablement flow, §35 default rows.

- `useMemoryFacts = true` and `referenceChatHistory = true` by default for new and existing users. The enabling migration/bootstrap flips existing rows; there is no reviewed opt-in gate.
- `learnAutomatically` remains `false` by default until the Phase 6 quality gates pass; at Phase 6 rollout the operator decides its default (tracked in the p6 rollout task).
- The blocking first-enablement disclosure flow is removed. Its content becomes plain informational copy inside Personalization → Memory (non-modal, no acknowledgment required).
- The three gates remain independent toggles with unchanged semantics (§15.2 matrix, AC-022 unchanged). Turning a gate off remains non-destructive.

## R2-2 — Egress consent is admin-owned

Amends: AD-14, §15.2 consent-field semantics, §22.1 egress block, §23.1 egress matrix, §24.9, AC-029.

- New installation policy `memoryEgressConsentMode: ADMIN | PER_USER`, default `ADMIN`. Document it in `agent_docs/ENV_VARIABLES.md` or the installation policy owner.
- In `ADMIN` mode (the default): destination fingerprints, drift detection, per-call execution bindings, and `WAITING_FOR_EGRESS_CONSENT` are all retained as machinery, but the acceptance/renewal action is an admin operation. Ordinary users are never asked to review or accept destinations. An admin destination change is acknowledged from the admin surface (which may also trigger reindex/rebuild via the existing §22.8 API); acknowledgment releases waiting work.
- The four-row egress matrix and `Review required` state move from the user Personalization surface to the admin surface. The user surface may show a passive one-line status at most.
- `PER_USER` mode preserves the previous per-user consent contract for multi-tenant installations that want it. No new UI work is required for it now beyond keeping the existing wiring functional.
- Per-call `MemoryExecutionBinding` evidence, fingerprint recording, and no-silent-fallback (INV-013) are unchanged.

## R2-3 — Memory coexists with hosted Search, client Search, MCP, and tools

Supersedes: §19.19 in full. Amends: INV-021, §11.10/§23.1 disclosure copy, §25 threat-table rows for memory-to-tool disclosure, §27.8 hard-gate list. Removes: AC-028 and AC-039 as written (replace with the coexistence scenario below).

Removed requirements:

- The hosted-Search XOR `personalContext` rule. One provider request MAY carry both.
- Memory-blind tool planning as the default wire shape. Tool-planning/execution requests MAY include `personalContext` and ordinary conversation context.
- The exclusion of prior (memory-bearing) assistant messages from tool/search requests.
- The separate no-tool synthesis request requirement.
- The per-request exact-value/destination confirmation flow, including its UI, API routes, and confirmation-bound receipt semantics. Concretely: `components/app-shell/MemoryEgressConfirmation*`, `components/app-shell/memoryEgressConfirmationApi*`, `app/api/me/memory/egress-confirmations/`, and the confirmation logic in `lib/server/memory/egress/confirmations.ts` are removed in the rescoped p5 slice. Code-level asserts that enforce the removed rules (e.g. `assertPersonalContextEgressSafe` rejecting external tool capability, `assertHostedSearchPersonalContextXor`, `assertMemoryBlindExternalRequest` as a default gate) are updated or deleted accordingly.

New normative policy:

- Admin-connected MCP servers, client Search, hosted Search, and Knowledge are trusted destinations for personal context by default. Admin connection is the trust decision; no per-request and no per-server user ceremony exists. A per-server restriction toggle MAY be added later as a separate task; the already-implemented memory-blind projection may remain in the codebase as a dormant internal capability for that future use, or be deleted — implementing agent's choice, smallest consistent cut wins.
- Secret screening: the storage-time safety projection (§17.4 — secrets never become memory content; already implemented in Phases 2–4) is retained unchanged. No new egress-time DLP work is required. Existing per-argument DLP wiring may be kept as-is if free, or removed if it complicates the simplification; a future operator-created task will revisit egress DLP after real usage.
- Unchanged: INV-011 (memory cannot authorize actions, enable tools, or select credentials — current user text authorizes actions); Temporary-chat restrictions (§11.9, §22.10); the labelled untrusted `personalContext` block format (§19.14) and its placement contract (§19.15); `search_my_history` bounds (20 results/page, 2 calls/run) and its `MemoryHistoryRun` receipt; public-share stripping (§25.2).
- §27.8 hard-gate list: remove `memory-only Search/MCP/tool disclosure`, `transitive memory -> assistant answer -> tool-argument disclosure`, and `provider request containing both hosted Search and personalContext`. Keep `secret derivative-memory retention` and `secret provider egress` (they are enforced at storage time and remain meaningful).
- §25 threat table: the memory-to-tool disclosure row becomes "accepted residual risk (ChatGPT-equivalent), mitigated by storage-time secret screening, admin-only destination control, receipts, and INV-011".

Replacement acceptance scenario (replaces AC-028/AC-039):

> **AC-028R — Memory with Search and tools.** Given memory is enabled and the run uses hosted Search, client Search, or admin-connected MCP tools, when the answer is produced, then `personalContext` and tool capability coexist in the provider request, tool calls execute without user confirmation, the run receipt records the destinations used, Temporary chats still expose no memory, and no memory item authorizes an action by itself.

## R2-4 — Post-action Undo instead of pre-confirmation

Amends: §11.3, §11.5, §22.10, §23.7. Server-side authorization machinery (§15.17, `MemoryMutationAuthorization`, idempotent operation receipts) is unchanged — this is a UX-flow change only.

- An unambiguous current-turn Forget executes immediately: the synchronous fence (§21.2) commits as specified, and the UI shows a toast «Забыто · Отменить». Undo within the window performs the already-specified explicit suppression-override revival (Appendix C.2: `FORGOTTEN` → explicit save + override) as a one-click action. Physical purge scheduling is deferred by the undo window (default 60 seconds, one central constant); revival before the window closes cancels the pending purge obligation. The fence-first property is preserved: between Forget and Undo the item is not retrievable.
- Ambiguous Forget targets keep the selection surface (that is correctness, not ceremony).
- `save_memory` no longer requires the statement to equal an exact source span. A model paraphrase is committable; the toast shows the exact saved text with inline Edit/Отменить. The server still mints and consumes the authorization from the current user turn; quoted/retrieved/Assistant-injected commands still cannot mint it (§17.6 unchanged).
- Bulk destructive operations (§22.5) keep explicit confirmation — they are rare and irreversible.
- Destructive-surface copy is shortened to one line with details behind an expandable «подробнее»; the honest-retention content (§21.6 wording obligations) moves into the expansion rather than being deleted.

## R2-5 — Backfill on enablement

Supersedes: the "no silent backfill" rule in §15.2 and the opt-in backfill choice in §22.8/§23.1.

- Enabling `referenceChatHistory` — including the default-on migration from R2-1 — automatically enqueues a lexical backfill of eligible retained chats, newest-first, through the existing coordinator budget. Lexical indexing is local (FTS, no external egress), so it runs silently. Settings shows a passive progress line («Индексируется N из M чатов»).
- Vector enrichment for backfilled items proceeds asynchronously under the normal embedding pipeline when an embedding deployment is configured (admin-consented destination per R2-2).
- Fact-extraction backfill (`REDREAM_EXISTING_CHATS`) remains an explicit button; it is never automatic.
- Backfill respects every existing eligibility rule: `EXCLUDED`/`TEMPORARY` sources, suppression and `MemorySourceBarrier` cutoffs, branch generations, and safety projection. Barriers are never crossed by the automatic backfill.

---

## Unchanged protections — explicitly NOT relaxed

INV-001 tenant isolation; INV-002..INV-010 (source authority, branch fences, run evidence, explicit authority, temporal history, forget fence, no-resurrection/suppression keyring); INV-011 memory-is-data; INV-012 Temporary isolation; INV-013 no silent provider fallback; INV-014 failure honesty; INV-018 vector-space integrity; INV-019/INV-020 two-phase admission and selected-item revalidation; storage-time secret screening (§17.4); sensitive-category automatic-learning policy (§17.5); public-share stripping (§25.2); private POST/no-store/log contracts (§22.11, AC-034); deletion truth table and purge obligations (§21); backup/keyring contracts (§15.12).

## Affected tasks

- `agent_docs/tasks/20260809163106400-memory-engine-p5-history-tool-egress-guard.md` (**in_progress — rescope before continuing**): keep `search_my_history` + `MemoryHistoryRun` receipt + its migration and recovery; drop the confirmation UI/API, XOR enforcement, memory-blind default wire, prior-assistant exclusion, and split synthesis; decide keep-or-drop for `MemoryToolEgressReceipt` (passive destination recording is acceptable, confirmation-bound semantics are not needed); reconcile the currently red `lib/server/memory/retrieval/runAdmission.test.ts` with the new coexistence policy (external tool capability no longer disables retrieval).
- `agent_docs/tasks/20260809163106953-memory-engine-p5-recall-release-gate.md`: replace XOR/confirmation/adversarial-disclosure suites with AC-028R coexistence coverage; the rest stands.
- `agent_docs/tasks/20260809163107481-memory-engine-p6-fact-extraction.md`: note that secret screening scope is storage-time only.
- `agent_docs/tasks/20260809163108596-memory-engine-p6-learning-review-ui.md`: adopt the R2-4 toast/Undo patterns.
- `agent_docs/tasks/20260809163109705-memory-engine-p6-beta-qualification-rollout.md`: owns the `learnAutomatically` default decision after gates pass.
- `agent_docs/tasks/20260809170951885-memory-engine-p8-health-status-ui.md`: egress consent/review surfaces target the admin UI per R2-2.
- Living documents to update as behavior changes: `agent_docs/backend/MEMORY.md`, frontend owners for the removed confirmation UI, `agent_docs/ENV_VARIABLES.md` (`memoryEgressConsentMode`), `agent_docs/SECURITY.md` threat rows, `agent_docs/TESTING.md` if gate suites change.

## Merge checklist for the implementing agent

1. Rescope the in-progress p5 task first (its Progress/Decisions log records this revision as the reason).
2. Apply R2-3 code changes (asserts, tool loop, runAdmission policy, remove confirmation surfaces) and make the hermetic memory lane green.
3. Apply R2-1/R2-2 defaults + consent-mode policy with migration.
4. Apply R2-4 and R2-5 in their owning slices (R2-5 may ride with the p5 gate or a small dedicated slice).
5. Merge every amendment into `AIQSA-native-memory-engine-PRD.md` (add a Revision 2 entry to §0.1) and the living docs listed above; run `npm run docs:check`.
