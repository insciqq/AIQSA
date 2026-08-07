# PROVIDER API OWNERSHIP AND BOUNDARIES

Owner: Provider integration maintainers
Scope: Externally mutable official provider constraints, source links, last-verified boundaries, and provider-specific transport caveats.
Read when: Provider work changes cross-provider memory, continuation, attachment, verification, or evidence boundaries.
Code owners: `lib/server/providers/`, `lib/server/runs/`, and `lib/server/uploads/`.
Not owned here: Provider-specific upstream facts, AIQSA runtime mapping details, configuration names, or test evidence.

## Ownership

This provider-notes family owns official provider references, externally mutable constraints, one last-verified marker per boundary, and provider-specific caveats. Each provider leaf owns its references, marker, and caveats; this file owns only the cross-provider boundary and maintenance rule. `BACKEND.md` routes AIQSA adapter behavior/defaults; `RUN_PIPELINE.md` routes product-level run semantics; `ENV_VARIABLES.md` owns configuration names; executable adapter tests own exact request/response mapping.

Reverify the affected leaf's primary sources whenever provider-facing work depends on mutable behavior, then replace that leaf's single marker. Do not append a verification chronology. Rationale that must survive belongs in the owning current contract; completion evidence belongs in Git history, tests, and release notes.

This external-fact catalog grants no authority to call a provider. Provider
smoke permission, size, cost, and secret-handling limits remain solely in
`CRITICAL_INVARIANTS.md` and the verification owner it routes.

## Cross-Provider Boundaries

Providers expose different memory, continuation, attachment, retention, and
tool contracts; no compatible-looking surface proves those capabilities for a
different provider or gateway. AIQSA's normalized memory, private attachment,
redaction, and continuation choices are routed by `BACKEND.md`,
`RUN_PIPELINE.md`, and `SECURITY.md`; this file changes only when an external
constraint changes or its last-verified marker is refreshed.
