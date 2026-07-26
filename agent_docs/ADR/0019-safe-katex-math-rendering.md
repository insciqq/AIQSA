# ADR 0019: Render Untrusted Assistant Math Through Restricted KaTeX

Status: Accepted
Amends: 0006-custom-safe-markdown-renderer

## Context

Providers commonly return TeX math inside `\\(...\\)`, `\\[...\\]`, `$...$`, and `$$...$$`. The custom safe Markdown renderer treated those delimiters and commands as ordinary text, so otherwise complete answers exposed raw source such as `\\operatorname`, `\\frac`, and `\\Phi`.

Hand-writing a TeX layout engine would create a large correctness surface. Replacing the whole Markdown boundary with a dependency-backed pipeline would be broader than the reported defect. KaTeX can render the required math, but its HTML becomes a second generated-HTML producer beside the reviewed Shiki code-highlighting boundary in ADR 0006.

## Decision

Keep the custom Markdown block/inline parser and add only math delimiter recognition. Completed delimiter pairs render through a locally bundled, lazily loaded KaTeX dependency; no CDN or runtime external asset is used.

The KaTeX boundary is restricted as follows:

- provider TeX is capped at 20,000 characters, and commands that require trust (`\\href`, `\\url`, `\\includegraphics`, and KaTeX HTML extensions) fall back before KaTeX is loaded;
- admitted TeX is passed only as the `renderToString` source with `trust: false`, `strict: "error"`, `throwOnError: true`, `maxSize: 10`, and `maxExpand: 1000`;
- output includes the normal KaTeX HTML plus MathML rendering payload;
- only the successful KaTeX return value enters `dangerouslySetInnerHTML`; provider text, raw HTML, parse-error messages, and failed expressions never enter that sink;
- malformed, unsupported, incomplete, or refused TeX remains escaped React text with its original delimiters;
- display math owns a local horizontal-scroll region so a wide formula cannot widen the conversation or public snapshot;
- rendered results and failures use one bounded in-memory cache.

Single-dollar recognition is conservative: it stays within a line and does not cross inline-code boundaries or interpret an unclosed currency-like value as math. Fenced code remains owned by the existing code-block parser. Private answers and public snapshots continue to share `MarkdownMessage`.

## Consequences

- Common LLM math is readable without changing persisted message content or the rest of the Markdown implementation.
- KaTeX, its CSS, and its fonts become reviewed production dependencies and must pass the dependency-security gate on changes.
- Math arrives after the lazy client chunk resolves; the escaped source remains a readable initial/failure state.
- KaTeX supports a broad but intentionally incomplete TeX subset. Unsupported commands do not gain a custom compatibility layer; they fall back inertly.
- KaTeX is the only additional trusted HTML producer. Any trusted commands, external resources, custom HTML attributes, another math engine, or a general Markdown HTML pipeline requires another decision and security review.
