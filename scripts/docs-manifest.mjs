export const NESTED_AGENT_INSTRUCTIONS = Object.freeze([
  "components/AGENTS.md",
  "lib/server/AGENTS.md",
  "ops/AGENTS.md",
  "prisma/AGENTS.md"
]);

export const NESTED_CLAUDE_INSTRUCTIONS = Object.freeze(
  NESTED_AGENT_INSTRUCTIONS.map((filename) => filename.replace(/AGENTS\.md$/u, "CLAUDE.md"))
);

const ROOT_MARKDOWN = ["AGENTS.md", "CLAUDE.md", "README.md", "CONTRIBUTING.md", "SECURITY.md"];
const COLOCATED_MARKDOWN = ["ops/nginx/README.md", "ops/systemd/README.md"];

export const REQUIRED_DOCS = Object.freeze([
  ...ROOT_MARKDOWN,
  ...NESTED_AGENT_INSTRUCTIONS,
  ...NESTED_CLAUDE_INSTRUCTIONS,
  ...COLOCATED_MARKDOWN,
  "agent_docs/AUTONOMOUS_WORKFLOW.md",
  "agent_docs/ARCHITECTURE.md",
  "agent_docs/BACKEND.md",
  "agent_docs/CRITICAL_INVARIANTS.md",
  "agent_docs/DECISION_DEFAULTS.md",
  "agent_docs/DESIGN_SYSTEM.md",
  "agent_docs/FRONTEND.md",
  "agent_docs/frontend/composer/ANSWER_OUTPUTS_AND_BRANCHES.md",
  "agent_docs/ENV_VARIABLES.md",
  "agent_docs/PRODUCT_PRINCIPLES.md",
  "agent_docs/PROVIDER_API_NOTES.md",
  "agent_docs/RUN_PIPELINE.md",
  "agent_docs/run_pipeline/OUTPUTS_RECOVERY_SHARING_AND_RETENTION.md",
  "agent_docs/SECURITY.md",
  "agent_docs/TESTING.md",
  "agent_docs/tasks/README.md",
  "agent_docs/tasks/archive/README.md",
  "agent_docs/tasks/drafts/README.md",
  "agent_docs/tasks/queue/README.md",
  "agent_docs/generated/API_AND_SCHEMA.md"
]);
