# BACKEND RUNS AND STREAMING

Owner: Run lifecycle maintainers
Scope: Current context replay, visible-answer, title, SSE, usage, cost, and server-side run-security behavior.
Verified against: 4f51fdd (2026-08-01)

## Conversation Context Replay

Persisted `Message` rows are durable chat memory. The backend, not the browser, builds model context for every send:

- `Chat.activeLeafMessageId` and `Message.parentMessageId` define the visible branch.
- A shared recursive PostgreSQL ancestor query starts at the active, expected, or explicit leaf and loads only that same-chat path in chronological order; ownership/non-archived scope stays in SQL, siblings are never materialized, and a visited-id guard terminates malformed cycles safely.
- The new user message is appended as the child of the active leaf and included as the final context message.
- Non-visible sibling branches are excluded.
- The run service applies the current context budget before run creation: ASCII contributes approximately one token per four characters, non-ASCII code points contribute at least one, extended pictographs contribute two, the budget is `contextWindow - maxOutputTokens - 10% contextWindow`, and oldest prior turns are dropped whole when needed.
- The budget includes provider-bound current-message attachment payload estimates, not only attachment references: extracted document/PDF fallback text, native PDF page/byte proxies, and image dimension proxies can make the current request return `400 context_too_large` before provider dispatch.
- Every tool continuation reapplies the same budget to the retained chat context, hydrated attachment payload estimates, provider-facing client and hosted-tool definitions, and the complete persisted assistant-call/tool-result transcript. Live and recovered rounds therefore cannot hide prior OpenAI context behind `previous_response_id` or bypass the accepted model budget.
- Runs that fit the budget keep the prior request shape. Trimmed runs store the trimmed `context.messages`, add `context.summary.truncation`, and emit a persisted `context_truncated` artifact. If prompts plus the current user message exceed budget, the route returns `400 context_too_large` before creating a run or calling a provider.
- Branch checkout persists by updating `Chat.activeLeafMessageId`; message deletion removes the selected subtree and falls back to the deleted root's parent if the active leaf was inside it.
- Provider adapters receive a provider-neutral `context.mode = "branch_path"` payload with ordered user/assistant messages.
- Request previews expose safe context ids, roles, and text snippets.
- If the chat belongs to a folder/project with memory, the run preparation boundary appends `Project memory` to the normalized system prompt for sends and regenerations before provider request preview/building.

OpenAI Responses and native Gemini Interactions use ordered input/step items, Anthropic Messages and OpenRouter/compatible Chat use ordered message arrays, and the fake provider echoes a deterministic context-memory preview for tests. A grounded live-only assistant row contributes only its neutral placeholder, never its transient answer.

## Visible Answer Contract

The visible assistant message is for the user-facing answer only. The run preparation boundary adds a backend invariant to provider requests:

- do not print debug sections such as `Question`, `Search`, `Provider Parameters`, `Request Preview`, `Artifacts`, `Usage`, or `Errors` in chat;
- keep provider/search/request/usage/error details out of visible chat answers; the UI shows Events/Details summaries and the model-run API keeps debug previews inspectable;
- include citations naturally in the answer only when useful.

OpenAI Responses and OpenRouter answer adapters sanitize the common old debug-template shape before emitting/saving visible answer text. Raw provider text remains available in model-run response previews when it differs from the visible answer.

## Chat Titles

The first send in a blank/new chat derives a short deterministic title from local message text inside the run-creation transaction. Normalized multi-word text stops at the last whole-word boundary within the 56-code-point budget and persists no display ellipsis; a single unbroken token uses a bounded code-point fallback, while display surfaces own any visual truncation. The update is compare-and-set against `New Chat`/`Untitled QSA`, so a concurrent or existing explicit title wins. Attachment-only or blank text keeps `New Chat`. Title derivation never calls a provider and creates no usage, event, or accounting record. New share snapshots copy that already-persisted clean chat title unchanged.

## SSE Requirements

`lib/domain/modelRunEvents.ts` is the executable owner of the normalized SSE event union and encoder. `runExecution.ts` owns foreground stream/provider/tool behavior, `runFinalization.ts` owns durable event/completion primitives, `runRecovery.ts` owns refresh/orphan settlement, and route handlers own the pre-execution mutation order. Together these boundaries must:

- set `text/event-stream` headers;
- persist the user message before opening the stream;
- create an assistant placeholder before first token;
- create a model run before provider execution;
- generate provider request preview for inspection;
- persist streamed event summaries without raw user content by default;
- batch token persistence: live SSE keeps per-token deltas, while assistant-message partial text and stored token `ModelRunEvent` rows flush as aggregated chunks;
- require provider-specific terminal proof before durable completion. A truncated provider stream flushes accepted partial text, then marks the assistant/run `error` without writing `done`; provider-reported usage already observed before truncation may still be stored as incomplete-run operational usage, but is never guessed;
- send transient UI sync events such as `chat_update` without persisting them into `ModelRunEvent`;
- update assistant content incrementally or at finalization;
- mark error state on failure;
- persist terminal provider-refresh artifacts followed by `usage` and `done` inside the same transaction as the writer whose status-gated `completeRun` call wins. Foreground SSE mirrors those already-durable terminal events transiently, so a later event append cannot turn a completed run into a contradictory error;
- coordinate boot orphan reconciliation once per server process and mark only active rows created before that process's boot boundary as `run_orphaned_on_boot`; retry a failed sweep, but never let a later repository instance sweep a newly committed live run;
- use the shared 10-minute active-run freshness threshold for recent-run gating and stale reconciliation; reconcile stale rows before creating send/regeneration runs so orphan rows do not collide with the database active-run uniqueness guard;
- fail stale non-refreshable active runs as `run_orphaned` through route-triggered reconciliation instead of leaving assistant messages `streaming` forever;
- stop persisting provider stream events promptly after explicit cancellation;
- close with `done`.

## Cost And Usage

Token/cost math belongs in `lib/domain/usage.ts` with unit tests.

Completed runs persist provider-reported `inputTokens`, `cachedInputTokens`, `cacheWriteInputTokens`, `outputTokens`, `reasoningTokens`, and `totalTokens`, while preserving the older coarse fields. Normalized `reasoningTokens` are treated as a subset of `outputTokens`, matching OpenAI/OpenRouter usage-detail semantics. `totalTokens` prefers provider-reported totals and falls back to `inputTokens + outputTokens` for providers and old rows that omit totals. `cachedInputTokens` is provider-reported only; do not infer cache hits from repeated text. Anthropic input normalization sums uncached, cache-creation, and cache-read fields, while thinking usage comes from current output-token details.

Search-tool `ModelRun` fields and completed lifetime `Chat.total*` counters keep the end-to-end sum across answer-model rounds plus every client-engine execution. Each `SearchRun` retains its reported usage evidence, while `UsageEvent` stores one grouped attribution per actual provider/model instead of pricing or reporting the entire run as the answer model. If a later provider/tool round fails or is cancelled, only usage already reported by a completed round or usage event is persisted; AIQSA does not estimate unreported failed-request usage. A later successful recovery replaces incomplete attribution rows with the final completed breakdown.

`Chat.totalInputTokens`, `Chat.totalOutputTokens`, and `Chat.totalReasoningTokens` are lifetime completed-run counters for operational accounting. They intentionally count completed sibling/regenerated runs and are not the user-facing active-branch usage number. The shell's circular context indicator derives its arc from approximate current input divided by the conservative safe input budget; its branch-aware detail disclosure uses `summarizeChatUsageStats` over the active visible branch for provider-reported usage.

Estimated cost is still computed and stored from operator-maintained `ProviderModel.inputTokenPriceMicros` and `outputTokenPriceMicros` only when the historical provider/model identity has one unambiguous deployment; otherwise cost is `null` rather than guessed. Reasoning tokens use the output-token price fallback until the schema grows separate reasoning pricing, and are not added on top of the output-token total. The user-facing shell does not render dollar costs or `est. cost n/a`; a separate backlog slice owns source-labeled provider cost accounting. Do not trust placeholder prices for billing.

## Security

`CRITICAL_INVARIANTS.md` and `SECURITY.md` own the security contract. Backend-specific observable ownership, entitlement, upload, share, and run-validation behavior remains documented in the relevant route/persistence sections above; do not maintain a second generic checklist here.
