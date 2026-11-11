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

// Budgets are an alarm, not a target: when a document outgrows them, delete what the code already
// says. A rule the code cannot show (an operator decision, an accepted risk, an invariant with its
// reason) is never cut to fit; raise the budget instead (operator decision 2026-11-01).
export const AGENT_DOC_BUDGETS = Object.freeze({
  files: 16,
  nonEmptyLines: 900,
  nonEmptyLinesPerFile: 132,
  words: 25500,
  wordsPerFile: 7300
});

export const INSTRUCTION_BUDGETS = Object.freeze([
  Object.freeze({ filename: "AGENTS.md", lines: 120, words: 1800 }),
  Object.freeze({ filename: "CLAUDE.md", lines: 80, words: 100 })
]);

// Private checkout-local state the documents name on purpose; it never exists in a clean clone or a
// `git archive` export, so citations of it are not checked.
export const PRIVATE_LOCAL_PATHS = Object.freeze([
  "AGENTS.override.md",
  "CLAUDE.local.md",
  "DEV_SERVER.md",
  ".aiqsa/",
  ".claude/agents/",
  ".claude/settings.local.json",
  ".claude/worktrees/",
  "agent_docs/PRD/"
]);

const ROOT_MARKDOWN = ["AGENTS.md", "CLAUDE.md", "README.md", "CONTRIBUTING.md", "SECURITY.md"];

export const REQUIRED_DOCS = Object.freeze([...ROOT_MARKDOWN, ...HANDWRITTEN_AGENT_DOCS]);
