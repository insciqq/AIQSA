# Memory Benchmark Provenance And Attribution

The offline adapters exercise benchmark-shaped behavior with original AIQSA
synthetic probes. They do not vendor upstream conversations, questions,
answers, or generated artifacts. The source and dataset revisions below are
recorded in `benchmark-provenance-v1.json`; its frozen hash detects drift.

- LongMemEval: official repository
  `xiaowu0162/LongMemEval` at
  `9e0b455f4ef0e2ab8f2e582289761153549043fc`, and cleaned dataset
  `xiaowu0162/longmemeval-cleaned` at
  `98d7416c24c778c2fee6e6f3006e7a073259d48f`. Both reviewed metadata declare
  MIT. The adapter covers single/multi-session recall, updates, temporal
  reasoning, and abstention with synthetic text.
- LoCoMo: official `snap-research/locomo` repository and dataset revision
  `3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376`, licensed
  CC-BY-NC-4.0. To avoid importing non-commercially licensed content into the
  application tree, the adapter records metadata and uses only synthetic
  single-hop, multi-hop, temporal, long-conversation, and adversarial probes.
- MINJA-like: official `dsh3n77/MINJA` repository at
  `7c260a22c8fb2bd0c8d8bbd4cded7ddc2af9670b` and paper revision
  `arXiv:2503.03704v5`. No repository license was asserted at review time, so
  provenance records `NOASSERTION` and only original behavior-level poisoning
  probes are present.

Because no upstream evaluation content or official evaluator is imported,
these adapters measure local regression behavior only. Their evidence must not
be presented as a LongMemEval, LoCoMo, or MINJA leaderboard score.
