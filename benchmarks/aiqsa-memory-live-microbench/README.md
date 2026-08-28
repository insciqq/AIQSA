# AIQSA Memory live microbench

This is a separate, non-LongMemEval, non-leaderboard qualification. It creates
one disposable user and exercises the ordinary HTTP user flow: ten source
chats, ten real model sends, automatic history/fact learning, the unchanged
production Dream scheduler and source threshold, a Qwen HYBRID rebuild, and
three isolated recall sends. It never inserts a fact or pattern directly and
never lowers a product threshold.

The ten source messages intentionally use ten independent chats. This gives
the unchanged eight-evidence-chat Dream trigger bounded tolerance for ordinary
zero-observation extraction while keeping the paid flow at thirteen sends.

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
