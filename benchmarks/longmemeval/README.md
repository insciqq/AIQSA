# AIQSA LongMemEval adapter

This directory runs the official cleaned LongMemEval-S benchmark through the
normal AIQSA chat-history Memory path. The upstream repository, dataset, and
`evaluate_qa.py` stay byte-for-byte unchanged and are pinned by commit,
revision, and SHA-256 in `upstream.json`. Generated downloads and results are
ignored by Git.

The qualification profile uses `gpt-5.6-sol` through codex-lb for the answer
and all non-embedding Memory roles, and `qwen/qwen3-embedding-8b` through
OpenRouter for document and query embeddings. It intentionally disables
automatic fact learning so the result measures recall from imported chat
history. Each official timestamped session becomes one ordinary source chat;
the final question is submitted through AIQSA's normal HTTP run-admission path.

The overlay has an explicit compose name, container names, network names,
volume names, database identity, and loopback-only ports. Its defaults are app
`3137`, PostgreSQL `55437`, MinIO `19100`, and MinIO console `19101`; it does not
share state with the default development installation. The benchmark overlay
runs at most sixteen Memory jobs globally and per benchmark user. The policy
supports a higher global-only ceiling for controlled experiments, but trials
at twenty-four and thirty-two produced provider calls that outlived their
configured timeout, so the preserved qualification profile uses sixteen.
The runner imports up to sixteen sessions per case concurrently and runs up
to two independent cases concurrently by default;
case and session concurrency are bounded to thirty-two and sixteen respectively.

## Run a qualification case

Download and verify the pinned upstream artifacts:

```bash
./benchmarks/longmemeval/download.sh
```

Start the isolated stack and prepare the existing local development profile:

```bash
docker compose -f docker-compose.dev.yml -f benchmarks/longmemeval/docker-compose.yml up -d app
docker compose -f docker-compose.dev.yml -f benchmarks/longmemeval/docker-compose.yml exec -T app npx tsx .aiqsa/local-dev-profile/cli.ts ensure
docker compose -f docker-compose.dev.yml -f benchmarks/longmemeval/docker-compose.yml exec -T app npx tsx .aiqsa/local-dev-profile/cli.ts prepare-memory-qualification
docker compose -f docker-compose.dev.yml -f benchmarks/longmemeval/docker-compose.yml exec -T app npx tsx .aiqsa/local-dev-profile/cli.ts select-memory-system-model gpt-5.6-sol
docker compose -f docker-compose.dev.yml -f benchmarks/longmemeval/docker-compose.yml exec -T app npx tsx .aiqsa/local-dev-profile/cli.ts select-memory-embedding qwen/qwen3-embedding-8b
```

Run one deterministically selected LongMemEval-S case. Both acknowledgements
are deliberate guards for paid provider traffic and disposable state:

```bash
AIQSA_MEMORY_BENCHMARK_ACK=DISPOSABLE_PAID_LONGMEMEVAL \
AIQSA_MEMORY_EGRESS_CONSENT_MODE=ADMIN \
AIQSA_MEMORY_BENCHMARK_DATABASE_URL='postgresql://aiqsa_benchmark:aiqsa-memory-benchmark-dev-password@127.0.0.1:55437/aiqsa_memory_benchmark?schema=public' \
npx tsx benchmarks/longmemeval/run.ts --confirm-paid DISPOSABLE --sample-size 1
```

Use repeated `--question-id ID` arguments for an explicit set, or combine
`--sample-size N --seed SEED` for another reproducible qualification sample.
Use `--case-concurrency N` and `--session-concurrency N` to lower either
bounded concurrency limit; the defaults are `2` and `16` respectively.

Add `--debug-memory` only for an explicitly disposable diagnostic run. The
runner then captures the exact normalized pre-provider request, prepared
Personal Memory context, selected items in order, source-session mapping,
chat digests, per-session history checkpoint/job/chunk status, governed
history and retrieval executions, and answer binding before the benchmark
user is deleted. Each raw `memory-debug-*.json` artifact is written
under the ignored result directory with mode `0600`; the flag is off by
default, and raw debug data never enters `run-summary.json` or normal logs.
The runner writes only sanitized accounting and model-binding evidence beside
`answers.jsonl` under `benchmarks/longmemeval/results/`; it does not log chat
content or hypotheses. Aggregate retrieval decisions, bounded failure reason
codes, pack budgets, and
per-role peak provider concurrency are retained so throttling and context loss
can be diagnosed without retaining private Memory text.

To verify the selected OpenRouter embedding deployment accepts a ten-input
batch without exposing input or vector content, run the guarded capability
probe against the disposable stack:

```bash
AIQSA_ENCRYPTION_KEY='QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=' \
AIQSA_MEMORY_BENCHMARK_ACK=DISPOSABLE_PAID_LONGMEMEVAL \
AIQSA_MEMORY_EGRESS_CONSENT_MODE=ADMIN \
AIQSA_MEMORY_BENCHMARK_DATABASE_URL='postgresql://aiqsa_benchmark:aiqsa-memory-benchmark-dev-password@127.0.0.1:55437/aiqsa_memory_benchmark?schema=public' \
npx tsx benchmarks/longmemeval/probe-embedding-batch.ts
```

The current durable `EMBED_ITEMS` job contract still owns one item, execution
receipt, retry decision, and usage record per job. Provider batch capability
alone does not authorize cross-job batching; that optimization requires a
durable batch ownership/accounting contract rather than opportunistically
sharing a request.

If AIQSA cannot produce an answer because indexing, retrieval, or generation
fails, the adapter records the sanitized engine failure in `run-summary.json`
and exits nonzero. `evaluate.ts` runs the unchanged official evaluator only on
real model answers, then adds every recorded execution failure to the aggregate
denominator as a hard incorrect result. This avoids both silently omitting a
failure and letting an abstention judge mistake an empty response for a correct
abstention. The resulting aggregate is written to `benchmark-score.json`.

Install the official evaluator dependencies and grade the answer with the
upstream `gpt-4o-2024-08-06` evaluator:

```bash
./benchmarks/longmemeval/setup-evaluator.sh
npx tsx benchmarks/longmemeval/evaluate.ts benchmarks/longmemeval/results/RUN/answers.jsonl --concurrency 16
```

`setup-evaluator.sh` installs the unchanged upstream `requirements-lite.txt`
in an ignored virtual environment. It additionally locks `httpx` to `0.27.2`,
the compatible transport line for the upstream evaluator's pinned OpenAI SDK.
The launcher round-robin shards hypotheses across up to sixteen unchanged
official evaluator processes by default (bounded to thirty-two), suppresses
their raw question/answer/hypothesis console output, validates complete unique
coverage, and merges results back into answer order. The canonical official
output is written next to `answers.jsonl` only after every shard succeeds and
will not be overwritten by the launcher.

Stop this stack with the same two compose files. Add `--volumes` only when the
benchmark database and object store are intentionally disposable:

```bash
docker compose -f docker-compose.dev.yml -f benchmarks/longmemeval/docker-compose.yml down
```
