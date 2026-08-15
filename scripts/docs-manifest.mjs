export const NESTED_AGENT_INSTRUCTIONS = Object.freeze([
  "components/AGENTS.md",
  "lib/server/AGENTS.md",
  "ops/AGENTS.md",
  "prisma/AGENTS.md"
]);

export const NESTED_CLAUDE_INSTRUCTIONS = Object.freeze(
  NESTED_AGENT_INSTRUCTIONS.map((filename) => filename.replace(/AGENTS\.md$/u, "CLAUDE.md"))
);

export const HANDWRITTEN_AGENT_DOCS = Object.freeze([
  "agent_docs/INDEX.md",
  "agent_docs/PRODUCT_PRINCIPLES.md",
  "agent_docs/DECISION_DEFAULTS.md",
  "agent_docs/CRITICAL_INVARIANTS.md",
  "agent_docs/ARCHITECTURE.md",
  "agent_docs/BACKEND.md",
  "agent_docs/PERSISTENCE.md",
  "agent_docs/PROVIDERS.md",
  "agent_docs/MEMORY.md",
  "agent_docs/RUN_CONTRACTS.md",
  "agent_docs/FRONTEND.md",
  "agent_docs/SECURITY.md",
  "agent_docs/ENV_VARIABLES.md",
  "agent_docs/TESTING.md",
  "agent_docs/AUTONOMOUS_WORKFLOW.md",
  "agent_docs/tasks/README.md",
  "agent_docs/tasks/archive/README.md",
  "agent_docs/tasks/drafts/README.md",
  "agent_docs/tasks/queue/README.md"
]);

export const AGENT_DOC_BUDGETS = Object.freeze({
  files: 20,
  nonEmptyLines: 1_500,
  nonEmptyLinesPerFile: 150
});

const ROOT_MARKDOWN = ["AGENTS.md", "CLAUDE.md", "README.md", "CONTRIBUTING.md", "SECURITY.md"];
const COLOCATED_MARKDOWN = ["ops/nginx/README.md", "ops/systemd/README.md"];

export const REQUIRED_DOCS = Object.freeze([
  ...ROOT_MARKDOWN,
  ...NESTED_AGENT_INSTRUCTIONS,
  ...NESTED_CLAUDE_INSTRUCTIONS,
  ...COLOCATED_MARKDOWN,
  ...HANDWRITTEN_AGENT_DOCS,
  "agent_docs/generated/API_AND_SCHEMA.md"
]);
