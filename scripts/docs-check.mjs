#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatedReferenceErrors } from "./generate-doc-reference.mjs";
import { validateTaskLedger } from "./task-ledger.mjs";

const NESTED_INSTRUCTIONS = [
  "components/AGENTS.md",
  "lib/server/AGENTS.md",
  "ops/AGENTS.md",
  "prisma/AGENTS.md"
];
const REQUIRED_DOCS = [
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  ...NESTED_INSTRUCTIONS,
  "agent_docs/AUTONOMOUS_WORKFLOW.md",
  "agent_docs/AI_CONTEXT.md",
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
  "agent_docs/RISKS.md",
  "agent_docs/SECURITY.md",
  "agent_docs/TESTING.md",
  "agent_docs/TASK_TEMPLATE.md",
  "agent_docs/ADR/README.md",
  "agent_docs/active_tasks/README.md",
  "agent_docs/archive/README.md",
  "agent_docs/backlog/README.md",
  "agent_docs/done_tasks/README.md",
  "agent_docs/generated/API_AND_SCHEMA.md"
];

const LARGE_LIVING_DOC_BYTES = 12_000;
const VERIFICATION_MAX_AGE_DAYS = 120;
const METADATA_EXCLUDED_DIRECTORIES = new Set([
  "ADR",
  "active_tasks",
  "archive",
  "backlog",
  "done_tasks",
  "generated"
]);

function markdownFiles(root) {
  const files = [];
  for (const filename of ["AGENTS.md", "CLAUDE.md", "README.md"]) {
    const target = path.join(root, filename);
    if (existsSync(target)) files.push(target);
  }

  const docsRoot = path.join(root, "agent_docs");
  function walk(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name === "done_tasks") {
        const readme = path.join(target, "README.md");
        if (existsSync(readme)) files.push(readme);
        continue;
      }
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(target);
    }
  }
  walk(docsRoot);
  return files;
}

function localLinkErrors(root) {
  const errors = [];
  const link = /!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g;
  for (const filename of markdownFiles(root)) {
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
  if (existsSync(claudePath) && !/AGENTS\.md/u.test(readFileSync(claudePath, "utf8"))) {
    errors.push("CLAUDE.md: must route to AGENTS.md instead of duplicating repository instructions");
  }

  const rootInstructions = path.join(root, "AGENTS.md");
  const rootBody = existsSync(rootInstructions) ? readFileSync(rootInstructions, "utf8") : "";
  for (const filename of NESTED_INSTRUCTIONS) {
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
  return errors;
}

function metadataErrors(root, now = new Date()) {
  const errors = [];
  const docsRoot = path.join(root, "agent_docs");

  function walk(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(docsRoot, target);
      const topDirectory = relative.split(path.sep)[0];
      if (entry.isDirectory()) {
        if (!METADATA_EXCLUDED_DIRECTORIES.has(topDirectory)) walk(target);
        continue;
      }
      if (
        !entry.isFile() ||
        !entry.name.endsWith(".md") ||
        METADATA_EXCLUDED_DIRECTORIES.has(topDirectory) ||
        statSync(target).size < LARGE_LIVING_DOC_BYTES
      ) {
        continue;
      }

      const filename = path.relative(root, target);
      const header = readFileSync(target, "utf8").split(/\r?\n/).slice(0, 12).join("\n");
      const owner = /^Owner:\s+(.+)$/mu.exec(header)?.[1]?.trim();
      const scope = /^Scope:\s+(.+)$/mu.exec(header)?.[1]?.trim();
      const verified = /^Verified against:\s+([0-9a-f]{7,40})\s+\((\d{4}-\d{2}-\d{2})\)$/mu.exec(header);

      if (!owner || owner.length > 120) {
        errors.push(`${filename}: large living document needs a bounded Owner marker in its first 12 lines`);
      }
      if (!scope || scope.length < 12 || scope.length > 240) {
        errors.push(`${filename}: large living document needs a 12-240 character Scope marker in its first 12 lines`);
      }
      if (!verified) {
        errors.push(`${filename}: large living document needs Verified against: <commit> (YYYY-MM-DD) in its first 12 lines`);
        continue;
      }

      const verifiedAt = new Date(`${verified[2]}T00:00:00Z`);
      const nowDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const ageDays = Math.floor((nowDay - verifiedAt.getTime()) / 86_400_000);
      if (Number.isNaN(verifiedAt.getTime()) || verifiedAt.toISOString().slice(0, 10) !== verified[2]) {
        errors.push(`${filename}: verification marker has an invalid calendar date`);
      } else if (ageDays < 0) {
        errors.push(`${filename}: verification marker date is in the future`);
      } else if (ageDays > VERIFICATION_MAX_AGE_DAYS) {
        errors.push(`${filename}: stale verification marker (${ageDays} days; maximum ${VERIFICATION_MAX_AGE_DAYS})`);
      }
    }
  }

  walk(docsRoot);
  return errors;
}

export function checkDocs(root = process.cwd()) {
  root = path.resolve(root);
  const errors = [];
  for (const filename of REQUIRED_DOCS) {
    const target = path.join(root, filename);
    if (!existsSync(target) || !statSync(target).isFile()) errors.push(`missing required document: ${filename}`);
  }
  errors.push(...instructionErrors(root));
  errors.push(...metadataErrors(root));
  errors.push(...localLinkErrors(root));
  errors.push(...validateTaskLedger(root).errors);
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
