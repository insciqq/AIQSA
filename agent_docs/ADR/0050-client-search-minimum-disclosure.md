# ADR 0050: Client Search Minimum Disclosure

Status: Accepted
Amends: 0004-private-auth-entitlements-uploads-and-sharing, 0043-admin-managed-multi-engine-search-plans, 0047-bounded-nested-search-operation-evidence

## Context

The migrated Search router already intended to send only a generated query to
client Search engines, but the legacy Perplexity executor still derived its
request by spreading the complete answer request. Its search request type
inherited attachments, branch context, prompts, and provider tool messages;
the OpenRouter builder appended extracted document text and fell back to the
original user content for an empty query. Request previews repeated the same
provider body. This made a selected client Search engine an automatic
cross-provider disclosure path and let attachment prompt injection influence a
second provider call.

A query-only serializer prevents direct field inheritance, but it cannot prove
that an answer model did not copy attachment content into its generated query.
AIQSA has no per-run disclosure-consent object that names the external engine,
files, and amount of text.

## Decision

- `ProviderSearchRequest` is independent from `ProviderRunRequest`. It contains
  only one validated query, an opaque correlation id, server-owned Search
  policy, validated Search controls, and the selected option id. Attachments,
  attachment ids, answer content/context/prompts, answer provider/model facts,
  and provider tool transcripts are not representable on that interface.
- Provider-generated Search arguments must be exactly `{ query: string }`.
  AIQSA trims whitespace, replaces control-character runs with spaces, and
  rejects empty, wrong-type, extra-property, or over-limit arguments. Limits
  are integration-owned within the reviewed 32-1,000-character configuration
  range; legacy Perplexity uses 500. Rejection returns a bounded tool error and
  performs no Search-provider call or `SearchRun` creation.
- Malformed provider tool-argument JSON becomes an internal invalid marker,
  never raw executable arguments. Search and MCP dispatch both reject that
  marker before external I/O and return the ordinary bounded tool error.
- Until AIQSA implements separate informed per-run disclosure consent, any run
  containing an attachment is incompatible with every client Search option.
  Preparation rejects a direct stale request, the composer retains but marks
  such an option unavailable, and legacy/recovery execution checks the same
  boundary again. Provider-hosted Search inside the already selected answer
  provider remains available with attachments.
- Client Search request previews retain only server-known provider/model/
  protocol/strategy facts and query length. They never retain the provider
  body, query plaintext, document metadata, or answer context. The exact
  validated query remains once in the authenticated durable Search/tool
  evidence already required by ADRs 0043 and 0047; this decision adds no second
  plaintext copy and does not place it in ordinary logs.

## Consequences

- Attachment-assisted cross-provider Search is intentionally unavailable
  rather than silently degraded or consented through a generic Search choice.
- A future attachment-assisted client Search feature requires a new explicit
  consent contract and must amend this ADR.
- Existing attachment-free Search retains citations, source normalization,
  usage attribution, cancellation, provider-error handling, recovery, and the
  common bounded tool loop.

## Required Verification

- Compile-time and runtime request-builder tests prove attachment text,
  filenames, ids, bytes/data URLs, original content, prompts, branch context,
  and provider tool messages cannot enter the client Search request or preview.
- Empty, whitespace, malformed, wrong-type, extra-property, and oversized
  arguments make zero external calls and no `SearchRun`.
- Preparation and recovery tests cover attachment-bearing client Search,
  attachment-free client Search, Search Off, and provider-hosted native Search.
- Valid Search retains citations, usage, cancellation, errors, and bounded
  final synthesis behavior.
