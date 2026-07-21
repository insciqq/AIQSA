#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateTaskLedger } from "./task-ledger.mjs";

const REQUIRED_DOCS = [
  "AGENTS.md",
  "README.md",
  "agent_docs/AUTONOMOUS_WORKFLOW.md",
  "agent_docs/ARCHITECTURE.md",
  "agent_docs/BACKEND.md",
  "agent_docs/FRONTEND.md",
  "agent_docs/ENV_VARIABLES.md",
  "agent_docs/SECURITY.md",
  "agent_docs/TESTING.md",
  "agent_docs/TASK_TEMPLATE.md",
  "agent_docs/ADR/README.md"
];

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
      if (entry.name === "done_tasks") continue;
      const target = path.join(directory, entry.name);
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

export function checkDocs(root = process.cwd()) {
  root = path.resolve(root);
  const errors = [];
  for (const filename of REQUIRED_DOCS) {
    const target = path.join(root, filename);
    if (!existsSync(target) || !statSync(target).isFile()) errors.push(`missing required document: ${filename}`);
  }
  errors.push(...localLinkErrors(root));
  errors.push(...validateTaskLedger(root).errors);
  errors.push(...envErrors(root));
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
