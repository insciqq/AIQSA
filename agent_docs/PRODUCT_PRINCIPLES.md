# PRODUCT_PRINCIPLES

AIQSA is an open-source, self-hosted, multi-user, model-agnostic conversational workspace. Chat is primary; administration makes its provider, model, files, Search, Knowledge, Memory, Assistant, and tool choices available and trustworthy.

- Prefer working functionality, explicit user control, reliable outputs, and private-by-default data handling. Preserve supported capabilities through one discoverable presentation and one state owner.
- Keep the reading flow central. Answers show content, sources, generated files, factual progress, and actionable failures. Internal execution inspection is not a product goal; [Frontend](FRONTEND.md) owns the presentation boundary.
- Retain internal records only for demonstrated execution, recovery, side-effect safety, privacy/security, retention, or aggregate accounting needs. Delete unused diagnostics and their supporting projections.
- Future agent work should extend existing conversation, provider, tool, entitlement, and run contracts. Do not advertise planned capabilities as shipped or invent a disconnected workflow product.

When safe alternatives satisfy the request, choose the smallest complete change that keeps a self-hosted installation runnable. [Decision defaults](DECISION_DEFAULTS.md) resolve choices the operator leaves open.
