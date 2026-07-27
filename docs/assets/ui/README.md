# UI visual assets

All maintained UI screenshots, design concepts, and their generation sources live under this directory.

- `product/` contains publishable product screenshots referenced by project documentation.
- `concepts/` contains non-runtime design explorations and their source prompts.
- `_local/` contains ignored audit, implementation-review, and third-party benchmark captures. Review those files for account data, secrets, and publication rights before moving anything out of the ignored tree.

Runtime UI contracts belong to `agent_docs/FRONTEND.md`, `agent_docs/DESIGN_SYSTEM.md`, and accepted ADRs. Pixels may illustrate composition, but they do not establish capabilities, exact copy, or current product state.

Put new maintained UI visuals here rather than in the repository root, `output/`, or `.aiqsa/`. Generated Playwright output remains transient under `test-results/`; runtime icons remain under `public/`.
