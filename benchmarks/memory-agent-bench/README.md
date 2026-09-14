# FactConsolidation subset

This is a bounded AIQSA adaptation of the MIT-licensed
[MemoryAgentBench](https://github.com/HUST-AI-HYZ/MemoryAgentBench) conflict
resolution task, not a full benchmark leaderboard score. `upstream.json` pins
the source commit, original dataset revision, files, templates, and selection.
`selection.json` freezes 80 question identities: 20 each for single-hop and
multi-hop tasks at 6k and 32k context lengths. Selection uses seeded hashes of
upstream question IDs, before observing engine results.

Both complete contexts remain in original order. Questions do not select or
prune source facts. The pinned upstream sentence chunker uses 4096 tokens and
`o200k_base`; preparation checks that only inter-sentence whitespace changes.
Chunks enter ordinary chats with the upstream memorization template. Questions
use the upstream RAG query template in fresh chats, subsequently excluded and
settled to prevent contamination. No oracle facts are inserted into Memory.

The primary score preserves the upstream normalized substring match, including
its weaknesses: an answer containing the target inside a denial can pass.
Separate semantic verdicts and execution-health results expose that difference.
Twenty fixed reader-control questions receive the complete original context
directly with Memory disabled. This measures reader capability separately from
memory ingestion/retrieval. The subset omits 64k/262k lengths and is not evidence
about those scales.

The frozen memory target requires at least 80% overall and 65% per stratum on
both metrics, plus 85% on the fixed twenty-question reader subset and healthy,
complete execution. Semantic scorer v2 accepts a whole normalized reference
answer directly, and judges other answers against the reference without
requiring explanations or evidence of how an answer was produced. Its separate
calibration includes changed-current-value, negation, hypothetical, wrong-subject
and instruction-injection controls. `--regrade-from results/<reader-run>` may
re-evaluate a complete healthy reader control in a new output directory: it
reuses and labels the saved answers, verifies the dataset/model fingerprint and
records the parent report hash. It never regenerates reader answers.

Prepare without provider calls:

```bash
python3 benchmarks/memory-agent-bench/download.py
python3 -m venv benchmarks/memory-agent-bench/.venv
benchmarks/memory-agent-bench/.venv/bin/pip install -r benchmarks/memory-agent-bench/requirements.txt
benchmarks/memory-agent-bench/.venv/bin/python benchmarks/memory-agent-bench/prepare.py
```

The preparer verifies source/data hashes and saves tokenizer resource hashes.
The runner rejects any prepared artifact differing from the frozen selection.
It shares the disposable authority guards and provider profile from
[personal Memory acceptance](../aiqsa-memory-live-microbench/acceptance/README.md).

```bash
AIQSA_TEST_MODE=1 npx tsx benchmarks/memory-agent-bench/run.ts \
  --ack DISPOSABLE_PAID_FACT_CONSOLIDATION --mode reader-control --output results/control
AIQSA_TEST_MODE=1 npx tsx benchmarks/memory-agent-bench/run.ts \
  --ack DISPOSABLE_PAID_FACT_CONSOLIDATION --mode memory --output results/baseline
```

Each run creates new synthetic identities and retains all outcomes in ignored,
private result files. Failed source ingestion fails its dependent questions.
An obtained answer remains available for diagnostic scoring if background
cleanup fails after query exclusion is proven. The failure still blocks healthy
acceptance. `answerOnly` counts these saved answers separately from the strict
overall score; missing or failed responses stay in the original denominator.
No hidden retry or selection of best answers is allowed. Public manifests hold
hashes/identities; downloaded data and actual answers remain ignored. Run focused
tests with `npx vitest run --config benchmarks/memory-agent-bench/vitest.config.ts`.
