# AIQSA public Knowledge retrieval benchmark

This directory is an opt-in benchmark workspace. It is not part of the normal
product tests: the root Vitest lanes never include it, and nothing here runs
in CI. Downloaded corpora, normalized documents, embeddings caches, ingestion
state, PostgreSQL benchmark volumes, and run results stay in local ignored
paths (`.data/`, `results/`, and the compose volumes) and are never committed.

Two public suites run through the complete retrieval path — HTTP upload
ingestion, chunking, indexing, query embedding, the configured installation
reranker when available, and the single hybrid retrieval repository operation
of an accepted `search_knowledge` call — with no answer generation:

- `RusBEIR / rus-SciFact / test` — the full official corpus (5,183 documents)
  and all 300 official test queries with the official qrels, pinned to
  `kaengreg/rus-scifact` `75b33d32f2f13f058d0598d6d78f0c3d3afc03d9` and
  `kaengreg/rus-scifact-qrels` `5e0c312c9fb7304a2dc91ec7fd648b3ace5c329f`.
- `T2-RAGBench / ConvFinQA / turn_0` — the full official ConvFinQA subset,
  pinned to `G4KMU/t2-ragbench` `adf7fe1541ac37351ce1142544d8e3b43010ed92`.
  The corpus deduplicates all 3,458 rows only by the official `context_id`
  (all 1,806 unique contexts become Markdown documents whose body is the
  official `context` field, which already carries the Markdown table). The
  pinned artifact contains five rows with an empty `question`; they remain in
  corpus construction but cannot be retrieval queries without fabricating
  text. The scoreable set is therefore the deterministic 3,453 rows with a
  non-blank official question, and every run freezes both the five-row
  exclusion count and a hash of the exact admitted query/relevance set. The
  relevant document of a query is exactly its `context_id`. The published
  artifact has no train/dev/test split for
  ConvFinQA — `turn_0` is the only official query split, so results are
  labeled `turn_0` and never called a "test split" score. Neither suite result
  may be presented as a score of the whole RusBEIR or T2-RAGBench benchmark.

MIRACL is intentionally excluded; no MIRACL adapter, subset, or derivative
exists here.

Anti-gaming rules are structural: both suites run one global ranking profile
(the product's), there are no dataset-name conditionals or language-specific
parameters, corpora and scoreable queries are used in full without sampling or
negative removal; the only exclusion is a manifest-pinned, content-independent
blank-query predicate. Every run freezes a manifest (dataset id + revision +
split, corpus and query-set content hashes, admitted/excluded query counts,
embedding/formatter/tokenizer/chunking/index/ranking identity, candidate
limits, reranker model or none, and an explicit run label).
`evaluate.ts` refuses to compare runs whose frozen dataset identities differ
or whose configuration labels collide. Ingestion is text/markdown only; the
runner asserts a zero OCR count (empty PDF-processing ledger and no
`low_ocr_confidence` warning) before recording a corpus as usable.

## Protocol

1. Download and verify the pinned datasets (refuses unpinned values):

```bash
./benchmarks/knowledge/download.sh
```

2. Start the isolated overlay stack (compose project
`aiqsa-knowledge-benchmark-second`; loopback-only app `3147`, PostgreSQL
`55447`, MinIO `19110`/`19111`; its own container, network, volume, and
database identities — it never shares state with the default development
installation):

```bash
docker compose -p aiqsa-knowledge-benchmark-second -f docker-compose.dev.yml -f benchmarks/knowledge/docker-compose.yml up -d app
```

Then configure the installation Knowledge profile (the embedding model used
for indexing and queries) and, when desired, the Knowledge reranking model on
this disposable stack through the ordinary Admin path. Knowledge base creation
fails closed with `knowledge_temporarily_unavailable` until an index profile is
active. Retrieval remains deterministic when the reranker role is empty and
records fallback metrics when a configured reranker is unavailable.

3. Ingest each suite through the product HTTP boundary. The acknowledgement
environment variable and the CLI flag are deliberate guards for paid
embedding traffic against disposable state; ingestion resumes from
`.data/state/` if interrupted, and batches respect
`AIQSA_KNOWLEDGE_MAX_BATCH_FILES`:

```bash
AIQSA_KNOWLEDGE_BENCHMARK_ACK=DISPOSABLE_PAID_KB \
AIQSA_KNOWLEDGE_BENCHMARK_DATABASE_URL='postgresql://aiqsa_benchmark:aiqsa-knowledge-benchmark-dev-password@127.0.0.1:55447/aiqsa_knowledge_benchmark?schema=public' \
npx tsx benchmarks/knowledge/ingest.ts --confirm-paid DISPOSABLE --suite rusbeir-rus-scifact

AIQSA_KNOWLEDGE_BENCHMARK_ACK=DISPOSABLE_PAID_KB \
AIQSA_KNOWLEDGE_BENCHMARK_DATABASE_URL='postgresql://aiqsa_benchmark:aiqsa-knowledge-benchmark-dev-password@127.0.0.1:55447/aiqsa_knowledge_benchmark?schema=public' \
npx tsx benchmarks/knowledge/ingest.ts --confirm-paid DISPOSABLE --suite t2ragbench-convfinqa
```

4. Run the retrieval-only diagnostic inside the app container once per suite
and explicit configuration label (query embeddings are cached under
`.data/cache/` keyed by the frozen manifest, never by query text). For the
current integrated engine use `C`; this label is only manifest identity and is
not a product runtime mode:

```bash
docker compose -p aiqsa-knowledge-benchmark-second -f docker-compose.dev.yml -f benchmarks/knowledge/docker-compose.yml exec -T \
  -e AIQSA_KNOWLEDGE_BENCHMARK_ACK=DISPOSABLE_PAID_KB app \
  npx tsx benchmarks/knowledge/retrieve.ts --confirm-paid DISPOSABLE \
  --suite rusbeir-rus-scifact --config C
```

Each full run writes sanitized aggregates only —
`results/<run-id>/summary.json` (metrics plus the frozen manifest) and
`results/<run-id>/rankings.json` (official public dataset ids plus content-free
reranker status, timeout, and normalized fallback code). No query text,
document text, or private content reaches result files, file names, or the
console. `--query-limit N` exists solely as a plumbing smoke and refuses to
write a scoreable summary. `--query-id <official-public-id>` selects one exact
public query for a low-load diagnostic retry; it is also non-scoreable and
cannot be combined with `--query-limit`. Retrieval concurrency defaults to
`1`; raise `--concurrency` only after a small provider- and host-load canary.
Query starts default to a provider-safe 30-second interval, and a normalized
429 defers future independent queries for 120 seconds. Override these with
`--query-start-interval-ms` and `--rate-limit-cooldown-ms` only after a canary;
neither mechanism retries or changes the settled result of a failed query.

For a long scoreable run, use a stable isolated output directory. Every
completed query is atomically checkpointed there with public ids, metrics, and
content-free diagnostics only. After an interruption, repeat the exact command
with `--resume`; the runner verifies the complete manifest and scheduling
identity, preserves the original run id, and admits only missing queries:

```bash
# Initial full run
npx tsx benchmarks/knowledge/retrieve.ts --confirm-paid DISPOSABLE \
  --suite t2ragbench-convfinqa --config C \
  --output results/t2ragbench-convfinqa-C-live

# Same frozen run after an interruption
npx tsx benchmarks/knowledge/retrieve.ts --confirm-paid DISPOSABLE \
  --suite t2ragbench-convfinqa --config C \
  --output results/t2ragbench-convfinqa-C-live --resume
```

`--resume` is accepted only for a full scoreable suite with explicit output.
It refuses changed manifests, concurrency/pacing, corrupted outcomes, and a run
that already has `summary.json`.

For iterative failure diagnosis, repeat `--query-id` to run only those exact
public query ids together in one non-scoreable batch. Duplicate ids and mixing
an explicit id list with `--query-limit` are rejected. The non-scoreable-only
`--diagnostic-disable-reranker` switch replays that bounded subset through the
same hybrid candidate path without the hosted rerank stage, making a stable
candidate-recall failure distinguishable from a reranker ordering failure.
`--diagnostic-candidate-audit` instead keeps the configured reranker and emits
only the public relevant-document rank within its complete pre-settlement
candidate order; it never prints query text, passage text, or internal ids.

5. Optional: compare two deliberately captured frozen configurations. The
current task does not require or claim a baseline comparison; a standalone
full-run summary is a diagnostic snapshot, not a relative quality claim.

```bash
npx tsx benchmarks/knowledge/evaluate.ts \
  benchmarks/knowledge/results/<runA-scifact>/summary.json \
  benchmarks/knowledge/results/<runA-convfinqa>/summary.json \
  benchmarks/knowledge/results/<runC-scifact>/summary.json \
  benchmarks/knowledge/results/<runC-convfinqa>/summary.json \
  --baseline A --candidate C
```

Stop the stack with the same two compose files; add `--volumes` only when the
benchmark database and object store are intentionally disposable:

```bash
docker compose -p aiqsa-knowledge-benchmark-second -f docker-compose.dev.yml -f benchmarks/knowledge/docker-compose.yml down
```

## Configuration labels

`A`, `B`, and `C` are immutable benchmark run labels retained by the comparison
contract; they do not switch product behavior. `retrieve.ts` always executes
the current engine configuration and freezes its embedding, tokenizer,
ranking, and reranker identities. It records actual per-query rerank duration,
usage, and fallback status. For this branch, use `C` for current-engine
diagnostics; no `A` baseline run is required by the operator decision.

## Tests

The contract module (manifest validation, document normalization, metrics,
comparison guards) is covered by hermetic unit tests with tiny synthetic
fixtures — no network, no database, no dataset files:

```bash
npx vitest run --config benchmarks/knowledge/vitest.config.ts
```
