# Contextual-key qualification

This deterministic, provider-free suite compares the raw recall-round key with
the current strict contextual key on the same fixed multilingual corpus. It
reports Recall@5/10/20, contextual-only/raw-only hits, fallback and dependency
rates, content-free dimension aggregates, and adversarial number/date/entity/
duplicate grounding evidence.

The corpus includes English, Russian, mixed, undetermined, Spanish, and Serbian
language metadata. `en`, `ru`, `mixed`, `und`, and `other` are reporting buckets,
not the set of languages supported by Memory.

Run it without containers or provider access:

```bash
npx tsx benchmarks/aiqsa-memory-contextual-key-qualification/run.ts
```

The emitted report contains case IDs, ranks, counts, and policy metadata only;
it does not emit corpus text. Passing deterministic evidence does not authorize
validator relaxation. Real-provider success remains `null`, so production keeps
strict source grounding plus searchable raw fallback.
