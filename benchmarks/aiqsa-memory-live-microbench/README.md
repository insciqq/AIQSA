# AIQSA Memory live microbench

This is a separate, non-LongMemEval, non-leaderboard qualification. It creates
one disposable user and exercises the ordinary HTTP user flow: thirteen source
chats, thirteen real model sends, automatic history/fact learning, the unchanged
production Dream scheduler and source threshold, a Qwen HYBRID rebuild, and
three isolated recall sends. It never inserts a fact or pattern directly and
never lowers a product threshold.

The thirteen source messages intentionally use thirteen independent chats.
This keeps the live source flow within a small 10–15-message budget and gives
the unchanged eight-evidence-chat Dream trigger bounded tolerance for ordinary
zero-observation or supporting-only extraction. The complete paid flow is
sixteen sends.

The gate requires every run to avoid `DEGRADED`, every background job to settle
successfully, one source-grounded PATTERN with at least three distinct direct
sources, that PATTERN to enter the Dream recall context, and all three custom
semantic answer checks to pass. Results are ignored, mode-0600 local audit
artifacts; this benchmark has no official oracle and makes no SOTA claim.

Use only the disposable benchmark compose stack and the exact local provider
profile selected by the operator:

```bash
AIQSA_MEMORY_LIVE_BENCHMARK_ACK=DISPOSABLE_PAID_AIQSA_MEMORY_LIVE \
AIQSA_MEMORY_EGRESS_CONSENT_MODE=ADMIN \
AIQSA_MEMORY_BENCHMARK_DATABASE_URL='postgresql://aiqsa_benchmark:aiqsa-memory-benchmark-dev-password@127.0.0.1:55437/aiqsa_memory_benchmark?schema=public' \
npx tsx benchmarks/aiqsa-memory-live-microbench/run.ts --confirm-paid DISPOSABLE
```

The default reviewed answer/System Model is `gpt-5.6-sol`. Pass
`--system-model gpt-5.6-luna` only after selecting that exact active codex-lb
System Model in the disposable profile. The runner fails closed unless the
allowlisted CLI choice, installation policy, authenticated catalog, and runtime
binding all agree; the selected upstream model is recorded in the summary.
