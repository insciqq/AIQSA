# ADR 0017: Conservative Multilingual Context Estimates

Status: Accepted
Amends: 0007-context-window-budget-and-trimming

## Context

ADR 0007 chose `ceil(chars / 4)` as a cheap deterministic context estimate. That approximation is useful for ordinary English prose but can materially undercount Cyrillic, CJK, emoji, and mixed technical content. The composer also presented the full model context window as though it were all available for input, even though the server reserves maximum output plus a safety margin.

AIQSA still needs a dependency-free fallback across OpenAI, Anthropic, OpenRouter, and unknown routed models. Adding one provider tokenizer would not make the other routes exact and would add maintenance and supply-chain cost disproportionate to this installation.

## Decision

1. Keep one deterministic provider-neutral estimator, but make it conservative by Unicode code point: ASCII contributes one quarter token, other Unicode contributes one token, and extended pictographs contribute two tokens. Round the total up.
2. Continue to reserve selected maximum output plus ten percent of the model context window. The composer shows approximate current input against that safe input budget and names the full model context separately.
3. Count native PDF extracted text and page-image proxies together. Every later tool-search round budgets the same attachments plus the accumulated tool transcript.
4. Estimates remain admission/trimming safeguards only. Final usage and operational accounting use provider-reported values and never replace them with the heuristic.

## Consequences

- Russian and other non-ASCII input may be overestimated, but is no longer admitted near the context boundary using an English-only ratio.
- The fallback remains cheap, deterministic, browser-compatible, and tokenizer-free.
- Exact provider/model tokenization and a server-owned composer preflight remain optional roadmap improvements rather than prerequisites for safe ordinary operation.
- Runtime tool results are unknowable before execution, so later tool-round budgeting and truncation artifacts remain required even when the initial request fits.
