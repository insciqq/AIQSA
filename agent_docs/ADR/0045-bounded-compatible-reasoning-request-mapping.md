# ADR 0045: Bounded Compatible Reasoning Request Mapping

Status: Accepted
Amends: 0022-admin-managed-llm-provider-control-plane, 0039-custom-provider-discovery-tools-and-lifecycle, 0042-bounded-compatible-model-capability-discovery

## Context

AIQSA already lets an administrator declare compatible-model reasoning
options, but the wire shape is fixed: Chat Completions sends
`reasoning_effort`, while Responses sends `reasoning.effort` and
`reasoning.mode`. OpenAI-compatible gateways may instead accept fields such as
`effort`, `reason`, or another nested spelling. Capability metadata cannot
prove that spelling, and a general request-template facility would expose far
more authority than this use case needs.

OpenAI's GPT-5.6 Responses contract also treats `standard | pro` as a reasoning
mode independent from effort. Compatible Chat must not advertise that control
unless an administrator has explicitly declared where its value is serialized.

## Decision

- Compatible model configuration may contain one bounded reasoning request
  mapping: a required effort dot path and an optional mode dot path. The
  mapping is available only when reasoning is enabled and only for
  `openai_chat_completions_compatible` and `openai_responses_compatible`.
  Native provider adapters retain their code-owned request shapes.
- Compatible Chat defaults to `reasoning_effort` with no mode path. Compatible
  Responses defaults to `reasoning.effort` and `reasoning.mode`. Existing
  persisted compatible configurations without an explicit mapping normalize
  to those defaults, preserving their wire behavior.
- Each path is a bounded sequence of ordinary object-key segments. Empty,
  overlong, over-deep, prototype-related, structurally reserved, or
  effort/mode-colliding paths are rejected before persistence and outbound
  I/O. Arrays, arbitrary values, headers, request templates, and transforms are
  not part of this contract.
- The normalized mapping is stored in the versioned model configuration and is
  therefore copied into immutable execution snapshots. Runtime requests and
  always-redacted request previews use the same serializer.
- Compatible Responses retains its standard reasoning summary request only
  with the canonical OpenAI mapping. An override omits that extra canonical
  object so it cannot collide with a gateway-specific field.
- The current-user catalog exposes reasoning modes only when the selected
  adapter can serialize a mode: native Responses, compatible Responses with
  its default or overridden mode path, or compatible Chat with an explicit
  mode path. The reviewed GPT-5.6 Sol fallback remains efforts
  `none | low | medium | high | xhigh | max` and modes `standard | pro`;
  defaults remain `medium` and `standard`.
- Quick setup and the saved-model editor expose the effective effort path and
  optional mode path beside the reasoning declaration. Discovery remains a
  hint only; administrators own and test any non-standard mapping.

## Consequences

- Gateways with small OpenAI wire-shape differences can use the ordinary
  compatible adapters without AIQSA hardcoding a vendor or model.
- `pro` is an honest selectable mode only where AIQSA has a concrete field to
  send, while Chat keeps its backward-compatible effort-only default.
- The mapping is intentionally less expressive than a general compatibility
  DSL. Gateways requiring transforms or request rewrites still need a gateway
  adapter outside AIQSA.

## Required Verification

Tests must cover default and overridden Chat/Responses bodies, exact
`standard | pro` serialization, invalid/reserved/prototype/colliding paths,
configuration and snapshot round-trip, catalog mode projection, request-preview
parity, and both Custom setup and saved-model editing. A permitted live gateway
smoke may establish support, but must report only sanitized status and
capability facts.
