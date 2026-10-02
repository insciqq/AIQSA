# AIQSA Memory live microbench

This is a separate, non-LongMemEval, non-leaderboard qualification. It creates
one disposable user and exercises the ordinary HTTP user flow: thirteen source
chats, thirteen real model sends, automatic history/fact learning, a Qwen HYBRID
rebuild, and two isolated recall sends. It never inserts a fact directly and
never lowers a product threshold.

Each source message uses its own chat, which keeps the live source flow within a
small 10–15-message budget. The complete paid flow is fifteen sends.

The gate requires every run to avoid `DEGRADED`, every background job to settle
successfully, every learned fact to rest only on direct user evidence, and both
custom semantic answer checks to pass. Results are ignored, mode-0600 local
audit artifacts; this benchmark has no official oracle and makes no SOTA claim.

Use only the disposable benchmark compose stack and the exact local provider
profile selected by the operator:

```bash
AIQSA_MEMORY_LIVE_BENCHMARK_ACK=DISPOSABLE_PAID_AIQSA_MEMORY_LIVE \
AIQSA_MEMORY_BENCHMARK_DATABASE_URL='postgresql://aiqsa_benchmark:aiqsa-memory-benchmark-dev-password@127.0.0.1:55437/aiqsa_memory_benchmark?schema=public' \
npx tsx benchmarks/aiqsa-memory-live-microbench/run.ts --confirm-paid DISPOSABLE
```

The default reviewed answer/System Model is `gpt-5.6-sol`. Pass
`--system-model gpt-5.6-luna` only after selecting that exact active codex-lb
System Model in the disposable profile. The runner fails closed unless the
allowlisted CLI choice, installation policy, authenticated catalog, and runtime
binding all agree; the selected upstream model is recorded in the summary.
