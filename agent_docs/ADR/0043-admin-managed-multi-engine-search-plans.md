# ADR 0043: Admin-Managed Multi-Engine Search Plans

Status: Accepted
Amends: 0004-private-auth-entitlements-uploads-and-sharing, 0011-explicit-next-run-control-ownership, 0022-admin-managed-llm-provider-control-plane, 0028-task-first-control-center-and-direct-provider-setup, 0030-direct-run-controls-and-reviewed-provider-catalog, 0031-native-gemini-interactions-and-live-only-grounding, 0039-custom-provider-discovery-tools-and-lifecycle

## Context

Search is a first-class QSA stage and already has separate persistence and
entitlement concepts, but its administration and execution remain coupled to
provider/model setup:

- the catalog recognizes only four code-owned strategy ids and filters them
  through hard-coded adapter/capability branches;
- provider setup opportunistically creates or grants hosted-search rows;
- compatible hosted search is declared in the model editor and selects the
  Responses protocol;
- there is no top-level Control Center resource where an administrator can add,
  test, activate, enable, inspect, or publish search integrations; and
- a run carries one `searchStrategy` string, so users cannot select several
  engines or state how several engines should be orchestrated.

That shape is insufficient for a compatible gateway such as the current
`codex-lb` installation, whose concrete search wire contract may differ from
Responses hosted `web_search`, and it would repeat the same coupling for every
future engine. Merely moving the existing model checkbox into another tab would
not create a replaceable backend boundary or make unsupported combinations
runnable.

The new boundary must preserve AIQSA's existing trust properties. Search remains
an explicit next-run choice, entitlements remain server-authoritative, accepted
runs retain exact immutable execution provenance, and raw provider payloads or
credentials do not become browser configuration. AIQSA also remains a QSA
product rather than a generic plugin marketplace, arbitrary HTTP-request
constructor, or agent builder.

## Decision

### Search ownership and terminology

The Control Center gains a top-level **Search** destination under **AI setup**.
Providers continue to own answer-model connections and technical model
capabilities. Search owns installation-managed search integrations, their
lifecycle, user-facing publication, and search-specific policy.

The durable concepts are:

- A **Search integration** is one administrator-managed concrete engine
  deployment. It owns a stable id, code-owned adapter kind, display identity,
  bounded configuration, credential mode, enabled state, and a tested active
  revision. Adapter kind and material engine identity do not silently change
  under an existing integration; replacing one engine with another creates a
  new integration so user choice and historical attribution remain truthful.
- A **Search option** is the entitlement-safe user-catalog projection selected
  in Research Chat. The initial implementation is one-to-one with an active
  integration, while keeping option identity separate from revision identity
  so credential rotation and safe configuration activation do not rewrite
  defaults or grants. A later policy bundle may deliberately reference several
  integrations without changing the run contract.
- A **Search plan** is the next-run value: an ordered set of zero to three
  Search option ids plus an orchestration mode. An empty plan is **Off**.
- A **Search execution** is one actual engine invocation. Each execution keeps
  its integration/revision attribution, query, normalized outcome, usage when
  reported, duration, and failure state. Selecting an option does not claim an
  execution occurred.

`SearchStrategy` may be migrated or adapted to provide the Search-option
identity, but current fixed-row storage is not treated as the future control
plane. Browser and run contracts use the concepts above rather than trusting
provider names or upstream model ids.

### Typed adapter boundary

Search integrations execute only through reviewed server-side `SearchAdapter`
implementations. An adapter owns:

- strict draft/config validation;
- bounded, SSRF-safe connection and credential testing;
- supported execution modes and answer-model compatibility requirements;
- provider/tool request serialization;
- timeout, result-count, byte, and concurrency bounds; and
- normalization of activity, sources, citations, usage, and errors.

Initial adapter families may include:

- **provider hosted** search, which adds a reviewed hosted capability to the
  selected answer provider request and ordinarily shares its answer credential;
- **client search** backed by a dedicated search API or an existing provider
  model/credential binding and exposed through AIQSA's provider-neutral tool
  loop; and
- a later explicitly typed **MCP search** adapter that maps a reviewed MCP tool
  contract into normalized search evidence. Ordinary MCP tools remain ordinary
  tool activity and do not become Search merely because their name contains
  `search`.

There is no administrator-authored request template, executable transform,
JavaScript expression, arbitrary tool schema, or unbounded response mapper.
Supporting a new protocol means adding a typed adapter plus deterministic
tests, not storing provider-specific code in the database.

The implementation performs a small, sanitized protocol smoke against
`codex-lb` using the already authorized credential. If the endpoint implements
compatible Responses hosted search, it uses the existing reviewed wire
boundary. If it implements a Chat Completions hosted-search shape, AIQSA adds a
generic compatible-Chat search adapter. If it exposes search as a callable
client tool, it uses the provider-neutral client-search boundary. No hostname,
deployment id, organization, or `codex-lb` model id is compiled into product
logic. A provider assertion without a usable normalized source/citation and
terminal contract is not enough to activate the integration.

### Multi-engine Search plans

The Research Chat Search control becomes a bounded multiselect while remaining
the one composer owner of next-run search state. Its resting label is:

- `Search: Off` for an empty plan;
- the selected option name for one option; or
- `Search: N engines` for several options.

Run setup shows the complete ordered selection, compatibility/readiness facts,
and orchestration mode. When more than one option is selected, the supported
modes are:

- **All selected per search** (`all_selected`): whenever the answer model emits
  one provider-neutral search action, AIQSA sends the same bounded query to all
  selected fan-out-capable integrations concurrently and returns one normalized
  combined result. This does not falsely promise that the model will search; as
  with current `tool_choice: auto`, no actual model request means no Search
  execution.
- **Model chooses** (`model_choice`): AIQSA exposes each compatible selected
  option separately. The answer model may call none, one, or several options,
  subject to the existing bounded tool-loop and per-integration limits.

The server enforces the maximum of three selected options, stable order,
deduplication, exact entitlement, current readiness, and complete combination
compatibility. Posted browser capability claims are ignored. A model change
never substitutes another engine silently: the browser visibly removes or
marks incompatible choices, and stale unsupported plans fail server
preparation.

`all_selected` is available only when every chosen integration implements the
fan-out query contract and the answer model can call the coordinator tool.
Provider-hosted tools may participate in `model_choice` only when the exact
answer adapter can serialize the complete combination. Native Gemini grounding
retains ADR 0031's exclusive/live-only contract and therefore remains a
single-option plan unless a later verified native contract safely expands it.
Unsupported combinations are absent from the entitled model catalog and fail
closed if posted directly.

### Query privacy and normalized evidence

Client-search and fan-out adapters receive only the model-generated bounded
query plus reviewed search parameters. They do not receive the branch
transcript, system/developer prompts, attachments, or extracted document text.
This replaces the current Perplexity tool-search attachment/context disclosure
when that strategy migrates to the new client-search boundary. Provider-hosted
search remains inside the answer-provider request and is labelled accordingly
because that provider already receives the answer context.

Every client-search adapter normalizes bounded results to a common evidence
shape containing at least safe URL, title, optional snippet/date, engine
identity, original engine rank, and invocation identity. Unsafe URLs are
discarded through the existing link-safety boundary. Raw engine responses are
not persisted by default.

Fan-out combination is deterministic, not an undeclared reranker. Results are
deduplicated by normalized safe URL, retain every contributing engine and
engine-local rank, and use plan order plus local rank as the initial stable
ordering. A future semantic reranker requires a separate explicit decision and
usage/provenance contract.

Partial fan-out success returns the successful evidence with per-engine warning
artifacts. When every selected engine fails, the search action returns an
explicit tool/search error to the answer loop; AIQSA never calls an unselected
fallback or labels an unsearched answer as searched. Existing tool-loop
semantics may still let the answer model produce a visibly ungrounded response,
but the failed search remains explicit in the run evidence.

### Lifecycle, credentials, and exact run bindings

Search integrations use the same trust principles as the existing provider and
SMTP control planes:

- secrets are write-only, purpose/owner/value-bound encrypted values and never
  return to the browser;
- draft changes do not affect runs until bounded testing and explicit
  activation succeed;
- enabled/disabled is separate from tested/ready publication;
- activation is fenced to the tested revision; and
- active or recoverable runs retain the exact accepted revision and credential
  evidence.

An adapter declares one credential mode: reuse the accepted answer-provider
binding, resolve a referenced provider-model binding through existing
credential precedence, or use a dedicated Search-owned credential. The browser
never selects a credential version. Dedicated Search credentials reuse the
existing encryption envelope service and safe network boundary rather than a
new cryptographic format.

Run admission atomically resolves every selected option to one exact active
integration revision and persists an ordered immutable search binding for each
selection. The current one-search-role uniqueness is expanded or replaced by a
multi-binding relation; later configuration, grants, engine disablement, or
credential rotation affects future runs only. Actual invocations continue to
create separately attributable Search executions and usage records.

An integration referenced by active/recoverable work cannot be destructively
removed. Ordinary removal archives or disables its catalog presence while
historical run snapshots remain inspectable and sanitized.

### Entitlements and catalog projection

Search-option access remains independent from model entitlement and credential
selection. Existing direct/group grants migrate by stable strategy/option id,
and the built-in `full_access` group continues to cover every current and future
Search option without granting a credential.

The current-user catalog returns only enabled, ready, entitled Search options
plus their safe labels and the exact per-model/mode compatibility matrix. It
does not expose endpoint URLs, secrets, credential identities, raw adapter
configuration, or unavailable integrations. Run admission revalidates the
same facts transactionally before dispatch.

Access mutation stays in **Access & groups**. The Search detail may summarize
coverage and link to that owner, but it does not create a duplicate grant
editor.

### Control Center presentation

**Search** is a stable peer of **Providers** under **AI setup**. It uses the
existing task-first Control Center language:

- a quiet full-width divided resource index rather than marketplace cards;
- whole-row selection with label, concrete engine/adapter identity, separate
  Enabled/Disabled status, and factual readiness;
- one Back-connected full-width detail with horizontal peer tasks for Overview,
  Configuration, Credentials when applicable, Compatibility, and Diagnostics;
- progressive Test, Activate, Enable/Disable actions beside the state they
  advance; and
- a direct **Add search integration** task using plain engine and privacy
  language rather than backend schema terminology.

The signature detail element is a compact factual search route:

```text
User option -> active engine revision -> compatible answer models
```

It makes the QSA execution boundary legible without a decorative topology graph
or badge carpet. The surface reuses the existing `answer-paper`,
`control-surface`, `ink`, `trace`, `proof`, positive, caution, and critical
semantic tokens in every theme; it introduces no Search-specific palette,
gradient, ornamental motion, or alternative navigation system.

### Migration and compatibility

The migration preserves existing stable ids, defaults, grants, and accepted
runs:

- `search-disabled` becomes the empty Search plan and is not an engine;
- `openai-native-web-search`, `gemini-google-search`, and
  `perplexity-tool-search` become initial code-owned integrations/options with
  their current safety semantics;
- every stored/default single strategy becomes an ordered singleton plan;
- the old `searchStrategy` request field is accepted during a bounded
  compatibility window and normalized to a singleton plan, while new browser
  code sends `searchPlan`; and
- historical normalized requests, Search runs, provider bindings, citations,
  and share behavior are not rewritten.

The living QSA, backend, frontend, architecture, security, provider, and testing
contracts change with the implementation of this accepted decision.

## Rejected Alternatives

- **Move the existing hosted-search checkbox into a new tab.** This changes
  navigation but preserves provider/model coupling, fixed ids, and
  single-engine execution.
- **Store arbitrary HTTP templates or tool schemas.** This turns Search into an
  unsafe plugin/agent builder and pushes secret/schema/provider validation into
  browser-authored data.
- **Expose every MCP tool whose name resembles search.** Names do not prove
  query privacy, result/citation shape, idempotency, or bounded execution.
- **Let the model silently choose from every installed engine.** This bypasses
  user intent, entitlements, cost expectations, and exact run provenance.
- **Automatically fall back to another engine.** This makes privacy, cost, and
  evidence differ from the selected plan without consent.
- **Merge all engine results into one unattributed rank.** This invents ranking
  authority and loses the evidence needed to compare engines.

## Consequences

- Administrators get one coherent Search control plane instead of configuring
  search as a side effect of answer-model setup.
- Users can select one, two, or three entitled engines and choose deterministic
  fan-out per search action or model-directed engine choice.
- New engines require one bounded server adapter and tests rather than changes
  across model UI, catalog ids, and provider-host branches.
- Search cost and latency may rise with fan-out; the bounded selection,
  concurrency, per-adapter limits, explicit mode, and per-engine usage evidence
  make that tradeoff visible.
- Some hosted/provider combinations remain intentionally exclusive. The
  abstraction makes incompatibility explicit rather than pretending every
  engine is interchangeable at the wire level.
- The control plane, schema migration, run bindings, catalog, composer, tool
  loop, and evidence UI all change, so this is a vertical product slice rather
  than a cosmetic tab addition.

## Required Verification

Implementation requires deterministic coverage for:

- migration of all current strategies, defaults, direct/group/full-access
  grants, and singleton request compatibility;
- draft/test/activate/enable/archive lifecycle fencing, write-only secrets,
  SSRF-safe network access, and secret non-reflection;
- adapter registration, typed config rejection, exact compatibility filtering,
  and no hostname/model-id special cases;
- zero, one, two, and three-option plans, stable ordering, deduplication,
  selection limits, and both orchestration modes;
- bounded parallel fan-out, multiple queries, cancellation, timeout, partial
  failure, total failure, URL sanitization, deterministic merge, source
  attribution, usage, and recovery behavior;
- exact multi-search run admission/bindings and immunity of accepted runs to
  later grants, activation, disablement, rotation, or archival;
- native/compatible hosted search, migrated Perplexity client search, native
  Gemini exclusivity/live-only behavior, and MCP remaining ordinary unless a
  typed Search adapter is selected;
- Admin Search index/detail/add/lifecycle/compatibility states across responsive
  and short-height layouts, plus Research Chat multiselect labels and Run setup;
  and
- a sanitized, small-context `codex-lb` search smoke that proves the chosen
  generic adapter request, terminal response, source/citation normalization,
  and absence of provider-specific product branches.
