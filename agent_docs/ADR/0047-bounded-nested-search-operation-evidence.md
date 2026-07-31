# ADR 0047: Bounded Nested Search Operation Evidence

Status: Accepted
Amends: 0025-clean-slate-research-chat-and-control-center, 0038-reading-first-conversation-chrome, 0043-admin-managed-multi-engine-search-plans

## Context

ADR 0043 made a client Search execution an ordinary provider-neutral tool call.
The answer model may therefore make one call to `search_selected_engines` while
the selected engine performs one or several provider-native web-search
operations. The existing Run receipt correctly counted the outer model tool
call but could not answer which engine ran, which generated query it received,
how many provider-native searches happened, or which internal queries the
provider reported. A 145-second engine execution could consequently appear as
only `Used 1 tool` even when the upstream Responses stream contained finer
activity.

The durable tool result already belongs to the exact `ModelRunToolCall` and
contains bounded per-engine Search evidence. Reconstructing parentage from an
opaque provider invocation id or adding another relation would duplicate an
ownership edge that already exists. Persisting the complete provider event or
response would violate the existing bounded-preview and no-raw-payload rules.

## Decision

### Evidence source and bounds

A client engine using the reviewed Responses web-search protocol reduces only
already-normalized Search artifacts whose payload type is `web_search_call`.
Lifecycle observations are merged by bounded provider call id, then by output
index when present, while first observation owns stable display order. One
engine execution retains at most 32 operations. Each operation contains only:

- an optional bounded provider call id and its local ordinal;
- allowlisted `search`, `open_page`, `find_in_page`, or `unknown` kind;
- normalized `complete`, `error`, `running`, or `unknown` status;
- up to eight unique provider-reported queries of at most 512 characters;
- an optional 2,048-character URL and optional 512-character find pattern.

The complete retained operation list also has a 16 KiB UTF-8 ceiling per
engine execution. First-observed operations win when either the count or byte
ceiling is reached, and a separate truncation fact keeps the receipt honest;
the UI renders `N+`/omission wording instead of claiming the retained count is
the complete upstream count.

No raw provider event, source body, header, reasoning item, request envelope,
credential, or unrestricted response field crosses this reduction boundary.
The existing three-option Search-plan ceiling also bounds nested engine
executions. Malformed, inconsistent, or oversized stored projections fail
closed at the shared wire decoder.

`providerOperations = null` means the protocol or historical record did not
retain operation detail. An empty array means a supported new execution was
observed but the provider reported no internal operation. The independent
truncation flag means additional provider activity was observed but omitted by
the count/byte limit. The UI states those cases explicitly and never turns
missing or truncated evidence into a zero/exact-count claim.

### Persistence and projection

The complete bounded operation list is captured with its engine execution in
the durable normalized tool-result snapshot and copied into that invocation's
bounded `SearchRun.artifacts`. This is additive JSON evidence and requires no
new database relation. The exact parent remains `ModelRunToolCall`; opaque
Search/provider invocation ids remain attribution evidence and are never
parsed to infer ownership.

`toolInspection.ts` publishes the same client-safe nested execution projection
for live tool-result artifacts and for authenticated durable-call fallback.
Chat detail, terminal chat updates, and authenticated model-run reads therefore
share `ThreadToolActivity -> ThreadSearchExecution ->
ThreadSearchProviderOperation`. Historical tool results remain readable with
their saved engine name/query/status/duration/source count even when their
provider-operation field is absent. Public share snapshots do not acquire this
private run-inspection evidence.

### Presentation

The completed-answer evidence remains count-first and collapsed. `Used tools`
opens rounds, the Search tool opens its engine executions, and an engine opens
its generated query plus provider-reported operations and exact internal
queries. Status, duration, source count, provider/model identity, URL, pattern,
and explicit unavailable evidence remain secondary factual detail.

When Search executions are nested under an observed Search tool call, the
receipt suppresses the redundant standalone Search count/disclosure. Native or
provider-hosted Search activity without that client-tool parent keeps the
existing standalone Search disclosure. This changes presentation only; usage,
Search-run attribution, events, and tool-call counts retain their existing
owners.

## Rejected Alternatives

- **Show the outer tool count as the Search-call count.** It conflates answer
  model decisions, engine executions, and provider-native operations.
- **Persist the raw Responses output.** It is unbounded and may contain private
  provider data unrelated to the receipt.
- **Link executions by parsing invocation ids.** Those ids are opaque and the
  exact durable parent call already owns the result.
- **Retroactively guess historical operation counts.** Absence of evidence is
  not evidence of zero calls.
- **Keep both standalone and nested Search disclosures.** It presents one
  execution twice and makes the receipt harder to interpret.

## Consequences

- New Responses-backed client Search runs can explain both the outer model tool
  call and the provider-native work underneath it.
- Providers that omit internal queries remain supported with honest partial
  detail.
- Existing rows and schema remain compatible; old runs gain no invented data.
- Search evidence is slightly larger but is bounded before persistence and
  again at the browser contract.

## Required Verification

- provider lifecycle reduction, deduplication, kind/status normalization, and
  query/operation bounds;
- tool-result and crash-safe durable-call projection without opaque or raw
  preview leakage;
- chat/model-run contract rejection of malformed or oversized nested evidence;
- Run receipt disclosure order, historical-unavailable wording, and standalone
  Search suppression only for nested client Search;
- desktop and compact browser expansion with long-detail containment; and
- routine static, unit, component, and documentation checks.
