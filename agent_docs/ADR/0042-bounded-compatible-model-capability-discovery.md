# ADR 0042: Bounded Compatible-Model Capability Discovery

Status: Accepted
Amends: 0022-admin-managed-llm-provider-control-plane, 0039-custom-provider-discovery-tools-and-lifecycle

## Context

ADR 0039 intentionally reduced arbitrary OpenAI-compatible `/models` rows to
IDs. That protected secrets and prevented catalog presence from being mistaken
for runtime proof, but it also discarded bounded metadata that some gateways
publish for context and reasoning controls. Administrators then had no clear
way to configure compatible reasoning, and the saved-model editor exposed
hosted search only as an ambiguous low-level capability override.

A catalog still cannot prove that a model accepts Responses, reasoning, or a
hosted tool. AIQSA therefore needs a narrow hint contract plus explicit
administrator choices, not general remote-schema import.

## Decision

- Only `openai_compatible` discovery may project capability hints. Each row
  contains its validated ID and a strict optional allowlist: context window,
  default maximum output tokens, reasoning support, bounded reasoning effort
  and mode options, and defaults that must belong to those options.
- The server accepts a small reviewed set of common field aliases, bounds
  integers, strings, option counts, and lengths, and discards every other
  remote field. Provider bodies, endpoint configuration, credentials, routing,
  pricing, arbitrary metadata, and tool declarations never reach browser
  state. Discovery remains transient and persists nothing.
- Model selection may apply these safe context/reasoning hints to an ordinary
  draft. It still does not infer wire protocol or hosted tools. The admin must
  choose Responses or Chat Completions and explicitly enable hosted
  `web_search`; enabling it selects Responses.
- Compatible setup and saved-model editing expose one explicit reasoning
  choice: reported metadata when complete, the current reviewed GPT-5.6 Sol
  control profile as the disclosed fallback, or disabled. The fallback is
  efforts `none | low | medium | high | xhigh | max` with default `medium`, and
  Responses modes `standard | pro` with default `standard`.
- When one setup creates several models, reported reasoning options are
  intersected because the setup persists one shared capability shape. Missing
  or incomplete metadata uses the disclosed fallback; an administrator may
  disable reasoning before the paid exact-model tests and commit.
- Persisted model capability metadata remains server-validated. The
  current-user catalog projects its exact options/defaults into Run setup;
  compatible Chat omits Responses-only reasoning modes even if the stored
  fallback contains them.
- Catalog hints and administrator declarations are not runtime verification.
  Exact model tests retain their existing role, and tool-specific smoke remains
  separate evidence.

## Consequences

- A metadata-rich gateway can produce accurate per-model reasoning controls,
  including provider-specific values such as `ultra`, without AIQSA hardcoding
  that gateway or model ID.
- A silent gateway still gives the administrator a visible, editable reasoning
  proposal instead of silently declaring reasoning unsupported.
- Hosted web search becomes a first-class compatible-model control while its
  Responses dependency remains explicit.
- The browser receives more than IDs, but only a bounded non-secret schema;
  arbitrary catalog content continues to be rejected or discarded.

## Required Verification

Tests must cover metadata bounds and secret non-reflection, default membership,
invalid persisted shapes, reported options, multi-model intersection, the
GPT-5.6 Sol fallback, Chat/Responses catalog projection, explicit hosted-search
selection, and both Custom setup and saved-model UI request shapes. A permitted
real-gateway smoke may prove Chat/Responses reasoning and Responses
`web_search`, but it must emit only status/capability booleans and counts.
