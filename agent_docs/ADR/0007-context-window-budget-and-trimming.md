# ADR 0007: Context Window Budget And Trimming

Status: Accepted
Amends: none

ADR 0017 replaces only the `ceil(chars / 4)` estimate below with its conservative Unicode rule; the server-owned budget, reserve, trimming, and visibility decisions remain current.

## Context

AIQSA replays the active branch path into every provider run. Without a server-side budget, long chats can exceed a model's context window, increase input cost linearly, and fail only after the provider rejects the request. The backend owns context replay, so trimming policy must be explicit and visible to the operator.

## Decision

Apply a provider-agnostic context budget before creating send or regenerate runs:

- estimate tokens with a deterministic `ceil(chars / 4)` heuristic over prompts and message content;
- budget prior conversation as `contextWindow - maxOutputTokens - 10% contextWindow safety margin`;
- always keep the system prompt, developer prompt, project memory, and current user message;
- drop oldest prior user/assistant turns first, whole messages only, preserving adjacency inside kept turns;
- if the irreducible prompt plus current user message exceeds the budget, fail fast with `context_too_large` before creating a run or calling a provider.

When trimming happens, store the trimmed context in `normalizedRequest.context.messages`, add a `summary.truncation` object to `normalizedRequest.context`, and emit a `context_truncated` artifact event before provider tokens. The UI surfaces that artifact in the thread and Events tab.

## Consequences

- Runs that fit the budget keep the existing request shape and do not emit truncation artifacts.
- Token estimates are approximate and intentionally tokenizer-free; provider adapters remain independent of provider-specific tokenizers.
- Old messages remain persisted in the chat. Only the per-run provider replay is trimmed.
- The deterministic fake provider does not reserve the entire context window when its UI max-output value equals the fake context window, because Fake QSA does not enforce provider output limits; real provider runs still reserve selected/default max output.
- Semantic summarization or compression of dropped history remains a future enhancement.
