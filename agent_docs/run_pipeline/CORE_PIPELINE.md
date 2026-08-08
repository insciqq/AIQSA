# RUN PIPELINE — CORE

Owner: Run pipeline maintainers
Scope: Product thesis and end-to-end message, context, model, tool-loop, response, usage, and persistence stages.
Read when: Changing run meaning, message acceptance, context assembly, dispatch, tools, streaming, terminal settlement, usage, or persistence.
Code owners: `lib/server/runs/`, provider-neutral tool-loop owners, message persistence, and run event publication.
Not owned here: Search integration policy, UI transparency presentation, sharing, or provider-specific wire mapping.

## Product Thesis

The core product is a provider-neutral model run. A run starts from a user message, may use web search and MCP tools, and produces a model response plus inspectable execution evidence. Search is optional rather than the identity of the product, and future agent orchestration should extend the same run, entitlement, and transparency contracts.

```text
Message -> optional search and tools -> model response
```

The common conversation path stays calm while giving the operator precise control over API request shape, model parameters, the Search plan, streamed events, response artifacts, branch state, and provider-reported usage.

Streaming is a provider-neutral run capability. Catalog `capabilities.streaming` says a model/adapter can stream normalized run events; catalog `parameterControls.stream.supported` says the composer exposes a per-run Stream toggle for that model. OpenAI, Gemini, and OpenRouter currently expose the toggle, while other streaming providers can keep adapter-owned defaults until their user-facing control is deliberately enabled.

## Pipeline Stages

1. Input
   - user message;
   - an optional selected Assistant: a declarative, versioned execution profile over this same pipeline. The request then carries only the Assistant identity plus user content; the server resolves the currently authorized immutable revision at admission (the owner's current revision, or the exact revision pinned by the publication granting access), materializes its model, system/developer instructions, provider-neutral controls, logical Search plan, exact MCP server allowlist, and exact Knowledge-base allowlist, and rejects any client override field. An Assistant never grants provider, Search, MCP, or Knowledge entitlement — the runner's own admission still applies — and unavailable saved dependencies or unsupported saved controls fail closed with stable privacy-safe codes instead of clamping or substituting;
   - the server-owned active-branch context and local first-message title projection defined by [Runs and streaming](../backend/RUNS_AND_STREAMING.md);
   - server-owned prompts: an ordinary no-Assistant run receives the code-owned standard-chat baseline `You are a helpful AI assistant. Today is {local_date}, local time is {local_time}.` rendered at admission from the server clock plus a bounded validated IANA time-zone hint (missing/invalid context records the explicit UTC fallback); the browser has no authority over the baseline or its rendered date/time. Assistant runs use their revision's own instructions and do not inherit the baseline. Both modes keep the cross-cutting visible-answer developer contract explicit, record the exact rendered text plus zone evidence in `ModelRun.normalizedRequest`, and never depend on a live template or definition after acceptance;
   - selected provider and model;
   - one bounded Knowledge plan. An ordinary run resolves its ordered list of at most three base ids as explicit request > chat default > folder/project default > Off; explicit `{ baseIds: [] }` is Off and therefore does not inherit. An Assistant run instead uses its authorized revision's exact list and rejects a simultaneous `knowledgePlan` override. Missing historical fields decode as Off;
   - explicit request parameters;
   - admitted user-owned attachments. [Provider admission](../backend/providers/ADMISSION_AND_BINDINGS.md) owns capability and PDF-route selection; [Runs and streaming](../backend/RUNS_AND_STREAMING.md) owns private materialization, replay, and context-budget mechanics.

2. Optional search and tools
   - optional but first-class Search and model-requested MCP tools remain inside the same run;
   - [Search plans and integrations](SEARCH_PLANS.md) owns preference, compatibility, route selection, invocation, evidence, and publication semantics;
   - the MCP paragraphs below own effective inventory, tool-loop, and accepted-run behavior; [Messages and Markdown](../frontend/MESSAGES_AND_MARKDOWN.md) owns their thread disclosure.

3. Model response
   - normalized visible answer, reasoning, citations, artifacts, usage, and an inspectable redacted provider preview;
   - [Runs and streaming](../backend/RUNS_AND_STREAMING.md) owns SSE publication, partial/error settlement, final reconciliation, and provider-neutral terminal behavior;
   - each bounded provider runtime owner routed by [Provider adapters](../backend/PROVIDER_ADAPTERS.md) owns its wire-specific identity and terminal proof.

MCP extends the middle of this pipeline with model-requested tools rather than adding a separate run mode. An ordinary accepted tool-capable run receives the complete immutable namespaced **effective** inventory from all of that user's enabled, entitled, ready MCP servers. A server grant authorizes its active revision's administrator-enabled subset: every valid current, new, or legacy tool is enabled unless its exact case-sensitive upstream name is in that revision's bounded disabled set. No enabled-but-unready server is silently omitted. An Assistant run first applies the revision's exact server allowlist, then the same installation-wide per-server policy: every requested server must be entitled, enabled, and ready for the runner, unrelated enabled servers are excluded, an empty allowlist means no tools, and an unavailable requested server fails the run closed with a privacy-neutral code that names no server. For a catalog model that cannot call tools, the composer explicitly sends `tools: "none"`, so preparation skips the MCP plan for that run without changing persistent server enablement; an all-disabled ready server likewise contributes no provider tool schemas or tool-capability requirement while its accepted server/binding evidence remains inspectable. Omission of the override retains the server-side capability/backstop checks. The model may request zero, one, or several calls over multiple rounds, including calls whose arguments use conversation data or a prior enabled server's result. Requested batches are persisted before bounded parallel execution, results return in provider order, and provisional streamed text is reset before the tool round. Foreground, Stream, and provider-native Background remain available whenever the selected adapter/model capabilities advertise the combination. Durable recovery reuses settled calls and native provider handles, reloads provider attachment payloads, and replays the same persisted provider transcript and accepted chat context under the same budget; it never retries a crash-ambiguous external side effect.

Administrator policy is evaluated over the complete sanitized upstream
inventory and publishes only its effective subset to a runtime generation.
User projections, tool/schema limits, provider schemas, and immutable accepted
snapshots consume that subset. Policy activation affects future admission only;
an accepted run retains its bound historical revision, snapshot, and generation
policy. [MCP runtime security](../security/MCP_RUNTIME.md) owns pre-publication
secret validation and the live pre-I/O exact-name fence.

Remote MCP transport limits, stable overflow codes, and inspection redaction
are routed through [MCP runtime security](../security/MCP_RUNTIME.md),
[runs and streaming](../backend/RUNS_AND_STREAMING.md), and
[environment variables](../ENV_VARIABLES.md). Those transport defenses do not
change the grant, effective-inventory, or per-call-approval semantics owned by
this pipeline.

An accepted run freezes opaque deployment identities and exact provider/Search
bindings before network I/O. A nonempty Knowledge plan is revalidated for live
ownership or active group/installation publication, non-archived base state,
active index generation, current embedding-model entitlement, exact vector
space, and usable credential/check evidence. Its ordered base revision,
generation, vector fingerprint/dimension, and embedding execution snapshot are
inserted atomically with the run graph; an unknown, unavailable, or access-lost
base returns the same value-free failure and leaves no partial messages or run.
A base with zero ready documents is still admitted so later retrieval can expose
honest empty evidence. Later revocation, archive, reindex, ordinary configuration, or RBAC changes
affect future admission only. [Provider admission](../backend/providers/ADMISSION_AND_BINDINGS.md)
owns credential resolution, the admission transaction, and revocation guards;
[runs and streaming](../backend/RUNS_AND_STREAMING.md) owns continuation,
cancellation, and recovery behavior over the frozen input.
