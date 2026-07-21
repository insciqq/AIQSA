# ADR 0006: Extend The Custom Safe Markdown Renderer

Status: Accepted
Amends: none

## Context

Assistant answers and public share snapshots need to render common LLM markdown: tables, emphasis, nested lists, blockquotes, deeper headings, horizontal rules, and mixed paragraph/list blocks. The existing renderer was intentionally small and safe, but it only covered headings through h3, flat lists, bold, links, inline code, and fenced code.

The alternative was adding `react-markdown` plus `remark-gfm`, which would improve standards coverage but add dependency and supply-chain review work for a narrow UI slice.

## Decision

Keep the custom renderer and extend it without new dependencies.

The renderer continues to avoid `dangerouslySetInnerHTML`, keeps inline HTML as escaped React text, and preserves the existing link allowlist of `http://`, `https://`, and `mailto:`. It now parses the additional markdown structures needed for normal assistant answers and public share rendering.

## Consequences

- No lockfile or dependency-security gate changes are required for this slice.
- The implementation remains intentionally limited instead of becoming a full CommonMark engine.
- Future markdown features should either extend this renderer with tests or revisit a dependency-backed renderer through a fresh ADR and supply-chain review.

## Addendum (2026-07-12)

Fenced-code syntax highlighting later introduced the reviewed `shiki` dependency. That implementation narrowly supersedes the statement that the renderer never uses `dangerouslySetInnerHTML`:

- ordinary Markdown, inline HTML, unknown code languages, and streaming code continue to render through escaped React text nodes;
- completed supported fenced-code blocks pass the untrusted source string to the local curated Shiki highlighter, then inject only Shiki's generated HTML result;
- provider output, stored HTML, arbitrary plugin output, and caller-supplied HTML can never enter that injection boundary directly;
- supported languages and the dual light/dark themes remain locally curated, and dependency changes still require the supply-chain gate;
- a regression test using the real Shiki implementation must prove that hostile fenced-code source remains inert text with no executable element or event-handler DOM.

This is a reviewed rendering boundary, not a general HTML-rendering capability. Any second HTML producer or broader sanitizer policy requires a new decision.
