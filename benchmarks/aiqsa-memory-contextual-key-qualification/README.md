# Contextual-key qualification

This deterministic, provider-free suite compares raw recall-round keys with
contextual keys using fixed proposals and semantic-review fixture decisions. It
reports Recall@5/10/20, contextual-only/raw-only hits, fallback and dependency
rates, content-free dimension aggregates, and rejection of unreviewed or
duplicate proposals on the same fixed multilingual corpus.

The corpus includes English, Russian, mixed, undetermined, Spanish, and Serbian
language metadata. `en`, `ru`, `mixed`, `und`, and `other` are reporting buckets,
not the set of languages supported by Memory.

Run it without containers or provider access:

```bash
npx tsx benchmarks/aiqsa-memory-contextual-key-qualification/run.ts
```

The emitted report contains case IDs, ranks, counts, and policy metadata only;
it does not emit corpus text. Provider success remains `null`, and the report
explicitly identifies fixture decisions. These results establish the projection
contract, not model accuracy. Validator changes also require the same-corpus
real-provider qualification specified by [Memory](../../agent_docs/MEMORY.md).
