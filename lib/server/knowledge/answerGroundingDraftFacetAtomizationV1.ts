export const KNOWLEDGE_ANSWER_DRAFT_COEQUAL_FACET_ATOMIZATION_CONTRACT_V1 =
  Object.freeze([
    '<aiqsa_knowledge_answer_draft_coequal_facet_atomization_contract version="1">',
    "Treat each co-equal answer facet as its own candidate claim. When one evidence-backed statement enumerates independently useful properties, comparison axes, reasons, mechanisms, constraints, risks, benefits, outcomes, actors, or beneficiaries, emit one claim per facet instead of compressing them into a conjunction or comma-separated list.",
    "Use the independent-verdict test: if a diligent verifier could accept or reject one part without accepting or rejecting the others, those parts belong in separate claims. Keep a material condition, attribution, direction, qualifier, or evidence-stated explanation with the one facet it qualifies; do not discard it merely to make the claim shorter.",
    "A conjunction remains valid only when its operands are inseparable parts of one relation, comparison, range, name, or truth condition. Do not split fixed entities, paired operands, or a single causal relation, and do not invent finer facets that the evidence or exact request does not support.",
    "Under the bounded claim limit, prioritize distinct direct answer facets over adjacent examples or elaboration. The later Selector may combine multiple independently supported claims to cover one compound answer task.",
    "</aiqsa_knowledge_answer_draft_coequal_facet_atomization_contract>"
  ].join("\n"));
