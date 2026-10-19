export const HANDWRITTEN_AGENT_DOCS = Object.freeze([
  "agent_docs/ARCHITECTURE.md",
  "agent_docs/BACKEND.md",
  "agent_docs/PERSISTENCE.md",
  "agent_docs/PROVIDERS.md",
  "agent_docs/MEMORY.md",
  "agent_docs/RUN_CONTRACTS.md",
  "agent_docs/FRONTEND.md",
  "agent_docs/SECURITY.md",
  "agent_docs/SIGN_IN.md",
  "agent_docs/ENV_VARIABLES.md",
  "agent_docs/TESTING.md",
  "agent_docs/tasks/README.md",
  "agent_docs/tasks/archive/README.md",
  "agent_docs/tasks/drafts/README.md",
  "agent_docs/tasks/queue/README.md"
]);

// Claude Code loads `.claude/rules/*.md` when a file matching their `paths:` frontmatter is read
// or edited. Each rule there is a symlink to the agent document that carries the frontmatter.
export const AGENT_RULES_DIRECTORY = ".claude/rules";

// Budgets leave little headroom on purpose: when a document outgrows them, delete what the code
// already says instead of compressing the prose.
export const AGENT_DOC_BUDGETS = Object.freeze({
  files: 16,
  nonEmptyLines: 900,
  nonEmptyLinesPerFile: 120,
  words: 17500,
  wordsPerFile: 2500
});

export const INSTRUCTION_BUDGETS = Object.freeze([
  Object.freeze({ filename: "AGENTS.md", lines: 120, words: 1700 }),
  Object.freeze({ filename: "CLAUDE.md", lines: 80, words: 100 })
]);

const ROOT_MARKDOWN = ["AGENTS.md", "CLAUDE.md", "README.md", "CONTRIBUTING.md", "SECURITY.md"];

export const REQUIRED_DOCS = Object.freeze([...ROOT_MARKDOWN, ...HANDWRITTEN_AGENT_DOCS]);
