#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatedReferenceErrors } from "./generate-doc-reference.mjs";
import { validateTaskLedger } from "./task-ledger.mjs";

const NESTED_AGENT_INSTRUCTIONS = [
  "components/AGENTS.md",
  "lib/server/AGENTS.md",
  "ops/AGENTS.md",
  "prisma/AGENTS.md"
];
const NESTED_CLAUDE_INSTRUCTIONS = NESTED_AGENT_INSTRUCTIONS.map((filename) => (
  filename.replace(/AGENTS\.md$/u, "CLAUDE.md")
));
const ROOT_MARKDOWN = ["AGENTS.md", "CLAUDE.md", "README.md", "CONTRIBUTING.md", "SECURITY.md"];
const COLOCATED_MARKDOWN = ["ops/nginx/README.md", "ops/systemd/README.md"];
const REQUIRED_DOCS = [
  ...ROOT_MARKDOWN,
  ...NESTED_AGENT_INSTRUCTIONS,
  ...NESTED_CLAUDE_INSTRUCTIONS,
  ...COLOCATED_MARKDOWN,
  "agent_docs/AUTONOMOUS_WORKFLOW.md",
  "agent_docs/ARCHITECTURE.md",
  "agent_docs/BACKEND.md",
  "agent_docs/backend/API_AND_AUTH.md",
  "agent_docs/backend/PERSISTENCE_AND_RETENTION.md",
  "agent_docs/backend/PROVIDER_ADAPTERS.md",
  "agent_docs/backend/RUNS_AND_STREAMING.md",
  "agent_docs/CRITICAL_INVARIANTS.md",
  "agent_docs/DECISION_DEFAULTS.md",
  "agent_docs/DESIGN_SYSTEM.md",
  "agent_docs/FRONTEND.md",
  "agent_docs/frontend/ACCOUNT_ADMIN_AND_SHARING.md",
  "agent_docs/frontend/COMPOSER_AND_CONTROLS.md",
  "agent_docs/frontend/IMPLEMENTATION_STATE.md",
  "agent_docs/frontend/MESSAGES_AND_MARKDOWN.md",
  "agent_docs/frontend/PRODUCT_AND_LAYOUT.md",
  "agent_docs/frontend/VISUAL_INTERACTION.md",
  "agent_docs/ENV_VARIABLES.md",
  "agent_docs/PRODUCT_PRINCIPLES.md",
  "agent_docs/PROVIDER_API_NOTES.md",
  "agent_docs/QSA_PIPELINE.md",
  "agent_docs/SECURITY.md",
  "agent_docs/TESTING.md",
  "agent_docs/tasks/README.md",
  "agent_docs/generated/API_AND_SCHEMA.md"
];

const LARGE_LIVING_DOC_BYTES = 12_000;
const MAX_LIVING_DOC_BYTES = 40 * 1_024;
const LIVING_DOC_SIZE_EXEMPTIONS = new Map();
const DISCOVERY_EXCLUDED_PREFIXES = [
  ".agents/",
  ".codex/",
  ".git/",
  ".next/",
  ".turbo/",
  ".aiqsa/",
  "agent_docs/generated/",
  "build/",
  "coverage/",
  "dist/",
  "node_modules/",
  "out/",
  "playwright-report/",
  "prisma/migrations/",
  "test-results/",
  "vendor/"
];
const OBSOLETE_HARNESS_DIRECTORIES = [
  "agent_docs/ADR",
  "agent_docs/active_tasks",
  "agent_docs/archive",
  "agent_docs/backlog",
  "agent_docs/done_tasks",
  "agent_docs/exec_plans",
  "agent_docs/exec-plans"
];
const CURRENT_SOURCE_EXTENSIONS = new Set([
  ".cjs", ".js", ".json", ".jsx", ".mjs", ".prisma", ".sh", ".ts", ".tsx", ".yaml", ".yml"
]);
const CURRENT_SOURCE_BASENAMES = new Set([".dockerignore", ".gitignore", "Dockerfile", "Makefile"]);
const CURRENT_SOURCE_EXCLUDED_FILES = new Set([
  "scripts/docs-check.mjs",
  "scripts/release-privacy-check.mjs",
  "tests/harness/docs-check.test.ts",
  "tests/harness/release-privacy-check.test.ts"
]);

function discoveryExcluded(relative) {
  if (relative.startsWith("agent_docs/tasks/") && relative !== "agent_docs/tasks/README.md") return true;
  return DISCOVERY_EXCLUDED_PREFIXES.some((prefix) => relative.startsWith(prefix));
}

function filesystemFiles(root) {
  const files = [];
  function walk(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const relative = portablePath(path.relative(root, target));
      if (discoveryExcluded(entry.isDirectory() ? `${relative}/` : relative)) continue;
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile()) files.push(relative);
    }
  }
  walk(root);
  return files;
}

function repositoryFiles(root) {
  const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, encoding: "utf8" });
  if (inside.status !== 0) return filesystemFiles(root);

  const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1_024 * 1_024
  });
  if (listed.status !== 0) {
    throw new Error(`git ls-files failed during documentation discovery: ${listed.stderr.trim() || "unknown error"}`);
  }
  return [...new Set(listed.stdout.split("\0").filter(Boolean).map(portablePath))]
    .filter((relative) => !discoveryExcluded(relative))
    .filter((relative) => existsSync(path.join(root, relative)))
    .sort();
}

function markdownFiles(root, files) {
  return files.filter((relative) => relative.endsWith(".md")).map((relative) => path.join(root, relative));
}

function localLinkErrors(root, markdown) {
  const errors = [];
  const link = /!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g;
  for (const filename of markdown) {
    const relative = path.relative(root, filename);
    const body = readFileSync(filename, "utf8");
    for (const match of body.matchAll(link)) {
      let target = match[1].replace(/^<|>$/g, "");
      if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue;
      target = target.split("#", 1)[0].split("?", 1)[0];
      if (!target) continue;
      try {
        target = decodeURIComponent(target);
      } catch {
        errors.push(`${relative}: malformed encoded Markdown link ${match[1]}`);
        continue;
      }
      const resolved = target.startsWith("/")
        ? path.join(root, target.slice(1))
        : path.resolve(path.dirname(filename), target);
      if (!resolved.startsWith(`${root}${path.sep}`) && resolved !== root) {
        errors.push(`${relative}: Markdown link leaves the repository: ${match[1]}`);
      } else if (!existsSync(resolved)) {
        errors.push(`${relative}: broken local Markdown link: ${match[1]}`);
      }
    }
  }
  return errors;
}


function obsoleteHarnessErrors(root, markdown) {
  const errors = [];
  for (const relative of OBSOLETE_HARNESS_DIRECTORIES) {
    if (existsSync(path.join(root, relative))) {
      errors.push(`${relative}: obsolete harness directory; keep unfinished work only in agent_docs/tasks`);
    }
  }
  const forbidden = [
    { pattern: /(?:agent_docs\/ADR(?:\/|\b)|\bADR\s+\d{3,}\b)/u, label: "ADR path or numbered ADR reference" },
    { pattern: /\bactive_tasks\b/u, label: "active_tasks directory" },
    { pattern: /\bdone_tasks\b/u, label: "done_tasks directory" },
    { pattern: /\bexec[_-]plans?\b/u, label: "separate execution-plan directory" },
    { pattern: /agent_docs\/(?:backlog|archive)(?:\/|\b)/u, label: "separate backlog/archive directory" }
  ];

  for (const filename of markdown) {
    const relative = portablePath(path.relative(root, filename));
    if (relative.startsWith("agent_docs/tasks/") && relative !== "agent_docs/tasks/README.md") continue;
    const body = readFileSync(filename, "utf8");
    for (const { pattern, label } of forbidden) {
      if (pattern.test(body)) errors.push(`${relative}: references obsolete ${label}`);
    }
  }
  return errors;
}

function currentSourceReferenceErrors(root, files) {
  const errors = [];
  const patterns = [
    /agent_docs\/ADR(?:\/|\b)/u,
    /\bactive_tasks\b/u,
    /\bdone_tasks\b/u,
    /\bexec[_-]plans?\b/u,
    /agent_docs\/(?:backlog|archive)(?:\/|\b)/u
  ];

  for (const relative of files) {
    if (relative.endsWith(".md") || CURRENT_SOURCE_EXCLUDED_FILES.has(relative)) continue;
    if (!CURRENT_SOURCE_EXTENSIONS.has(path.extname(relative)) && !CURRENT_SOURCE_BASENAMES.has(path.basename(relative))) {
      continue;
    }
    const body = readFileSync(path.join(root, relative), "utf8");
    if (patterns.some((pattern) => pattern.test(body))) {
      errors.push(`${relative}: references obsolete harness state`);
    }
  }
  return errors;
}

function portablePath(value) {
  return value.split(path.sep).join("/");
}

function envErrors(root) {
  const examplePath = path.join(root, ".env.example");
  const docsPath = path.join(root, "agent_docs/ENV_VARIABLES.md");
  if (!existsSync(examplePath)) return ["missing environment contract: .env.example"];
  if (!existsSync(docsPath)) return [];
  const errors = [];
  const keys = [];
  const seen = new Set();
  for (const [index, raw] of readFileSync(examplePath, "utf8").split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (!match) {
      errors.push(`.env.example:${index + 1}: expected KEY=value`);
      continue;
    }
    if (seen.has(match[1])) errors.push(`.env.example:${index + 1}: duplicate key ${match[1]}`);
    seen.add(match[1]);
    keys.push(match[1]);
  }
  const docs = readFileSync(docsPath, "utf8");
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`(^|[^A-Z0-9_])${escaped}([^A-Z0-9_]|$)`, "m").test(docs)) {
      errors.push(`agent_docs/ENV_VARIABLES.md: missing .env.example key ${key}`);
    }
  }
  return errors;
}

function taskPrivacyErrors(root) {
  const errors = [];
  const ignorePath = path.join(root, ".gitignore");
  if (!existsSync(ignorePath)) return ["missing task privacy contract: .gitignore"];
  const ignoreLines = new Set(readFileSync(ignorePath, "utf8").split(/\r?\n/u).map((line) => line.trim()));
  if (!ignoreLines.has("/agent_docs/tasks/*.md")) {
    errors.push(".gitignore: must ignore /agent_docs/tasks/*.md");
  }
  if (!ignoreLines.has("!/agent_docs/tasks/README.md")) {
    errors.push(".gitignore: must keep agent_docs/tasks/README.md trackable");
  }

  if (existsSync(path.join(root, ".git"))) {
    const tracked = spawnSync("git", ["ls-files", "--", "agent_docs/tasks/*.md"], {
      cwd: root,
      encoding: "utf8"
    });
    if (tracked.status !== 0) {
      errors.push(`task privacy check could not inspect tracked files: ${tracked.stderr.trim() || "git ls-files failed"}`);
    } else {
      const instances = tracked.stdout.split(/\r?\n/u).filter(Boolean).filter(
        (filename) => filename !== "agent_docs/tasks/README.md"
      );
      for (const filename of instances) errors.push(`${filename}: public Git must not track task instances`);
    }
  }
  return errors;
}

function instructionErrors(root) {
  const errors = [];
  for (const [filename, maximum] of [["AGENTS.md", 200], ["CLAUDE.md", 80]]) {
    const target = path.join(root, filename);
    if (!existsSync(target)) continue;
    const lines = readFileSync(target, "utf8").split(/\r?\n/).length;
    if (lines > maximum) {
      errors.push(`${filename}: ${lines} lines exceed the ${maximum}-line root-instruction budget; route details to agent_docs`);
    }
  }

  const claudePath = path.join(root, "CLAUDE.md");
  if (existsSync(claudePath) && readFileSync(claudePath, "utf8").trim() !== "@AGENTS.md") {
    errors.push("CLAUDE.md: must contain only the shared-instruction import @AGENTS.md");
  }

  const rootInstructions = path.join(root, "AGENTS.md");
  const rootBody = existsSync(rootInstructions) ? readFileSync(rootInstructions, "utf8") : "";
  for (const filename of NESTED_AGENT_INSTRUCTIONS) {
    const target = path.join(root, filename);
    if (!existsSync(target)) continue;
    const body = readFileSync(target, "utf8");
    const lines = body.split(/\r?\n/).length;
    if (lines > 40 || Buffer.byteLength(body) > 4_096) {
      errors.push(`${filename}: exceeds the 40-line/4096-byte nested-instruction budget`);
    }
    if (!/^Scope:\s+\S/mu.test(body)) {
      errors.push(`${filename}: must declare one bounded Scope line`);
    }
    if (/^##\s+(?:Autonomy Trigger|Repository Publication|Before Final Response)$/mu.test(body)) {
      errors.push(`${filename}: duplicates a root-only instruction section`);
    }
    const combinedLines = rootBody.split(/\r?\n/).length + lines;
    const combinedBytes = Buffer.byteLength(rootBody) + Buffer.byteLength(body);
    if (combinedLines > 240 || combinedBytes > 10_240) {
      errors.push(`${filename}: root plus nearest instructions exceed the 240-line/10240-byte discovery budget`);
    }
  }
  for (const filename of NESTED_CLAUDE_INSTRUCTIONS) {
    const target = path.join(root, filename);
    if (existsSync(target) && readFileSync(target, "utf8").trim() !== "@AGENTS.md") {
      errors.push(`${filename}: must contain only the scoped-instruction import @AGENTS.md`);
    }
  }
  return errors;
}

function livingDocumentErrors(root, markdown) {
  const errors = [];
  for (const target of markdown) {
    const filename = portablePath(path.relative(root, target));
    if (!filename.startsWith("agent_docs/")) continue;
    const relative = filename.slice("agent_docs/".length);
    const topDirectory = relative.split("/", 1)[0];
    if (topDirectory === "generated" || topDirectory === "tasks") continue;

    const body = readFileSync(target, "utf8");
    const size = Buffer.byteLength(body);
    if (/^Verified against:/mu.test(body)) {
      errors.push(`${filename}: ordinary living documents must not carry a global Verified against stamp`);
    }

    const exemption = LIVING_DOC_SIZE_EXEMPTIONS.get(filename);
    if (size > MAX_LIVING_DOC_BYTES && !exemption) {
      errors.push(`${filename}: ${size} bytes exceed the ${MAX_LIVING_DOC_BYTES}-byte non-generated living-document cap`);
    }

    if (size < LARGE_LIVING_DOC_BYTES) continue;
    const header = body.split(/\r?\n/).slice(0, 12).join("\n");
    const owner = /^Owner:\s+(.+)$/mu.exec(header)?.[1]?.trim();
    const scope = /^Scope:\s+(.+)$/mu.exec(header)?.[1]?.trim();
    if (!owner || owner.length > 120) {
      errors.push(`${filename}: large living document needs a bounded Owner marker in its first 12 lines`);
    }
    if (!scope || scope.length < 12 || scope.length > 240) {
      errors.push(`${filename}: large living document needs a 12-240 character Scope marker in its first 12 lines`);
    }
  }
  return errors;
}

export function checkDocs(root = process.cwd()) {
  root = path.resolve(root);
  const errors = [];
  const files = repositoryFiles(root);
  const markdown = markdownFiles(root, files);
  for (const filename of REQUIRED_DOCS) {
    const target = path.join(root, filename);
    if (!existsSync(target) || !statSync(target).isFile()) errors.push(`missing required document: ${filename}`);
  }
  errors.push(...instructionErrors(root));
  errors.push(...obsoleteHarnessErrors(root, markdown));
  errors.push(...currentSourceReferenceErrors(root, files));
  errors.push(...livingDocumentErrors(root, markdown));
  errors.push(...localLinkErrors(root, markdown));
  errors.push(...validateTaskLedger(root).errors);
  errors.push(...taskPrivacyErrors(root));
  errors.push(...envErrors(root));
  errors.push(...generatedReferenceErrors(root));
  return errors;
}

function cliRoot(argv) {
  if (argv.length === 0) return process.cwd();
  if (argv.length !== 2 || argv[0] !== "--root" || !argv[1]) {
    throw new Error("usage: docs-check [--root <path>]");
  }
  return argv[1];
}

export function runDocsCheck(argv = process.argv.slice(2)) {
  const root = path.resolve(cliRoot(argv));
  const errors = checkDocs(root);
  if (errors.length) throw new Error(`documentation sanity check failed:\n- ${errors.join("\n- ")}`);
  return "docs:check passed.";
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    console.log(runDocsCheck());
  } catch (error) {
    console.error(`docs:check: ${error.message}`);
    process.exitCode = 1;
  }
}
