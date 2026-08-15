#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_DOC_BUDGETS,
  HANDWRITTEN_AGENT_DOCS,
  NESTED_AGENT_INSTRUCTIONS,
  NESTED_CLAUDE_INSTRUCTIONS,
  REQUIRED_DOCS
} from "./docs-manifest.mjs";

const DISCOVERY_EXCLUDED_PREFIXES = [
  ".agents/",
  ".codex/",
  ".git/",
  ".next/",
  ".turbo/",
  ".aiqsa/",
  "agent_docs/PRD/",
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
const TASK_CONTRACT_FILES = new Set([
  "agent_docs/tasks/README.md",
  "agent_docs/tasks/archive/README.md",
  "agent_docs/tasks/drafts/README.md",
  "agent_docs/tasks/queue/README.md"
]);

function portablePath(value) {
  return value.split(path.sep).join("/");
}

function discoveryExcluded(relative) {
  if (relative === "agent_docs/tasks/") return false;
  if (["archive", "drafts", "queue"].some((name) => relative === `agent_docs/tasks/${name}/`)) {
    return false;
  }
  if (relative.startsWith("agent_docs/tasks/") && !TASK_CONTRACT_FILES.has(relative)) return true;
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
  return files.sort();
}

function repositoryFiles(root) {
  const inside = spawnSync("git", ["--work-tree", root, "rev-parse", "--is-inside-work-tree"], {
    cwd: root,
    encoding: "utf8"
  });
  if (inside.status !== 0) return filesystemFiles(root);

  const listed = spawnSync(
    "git",
    ["--work-tree", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1_024 * 1_024 }
  );
  if (listed.status !== 0) {
    throw new Error(`git ls-files failed during documentation discovery: ${listed.stderr.trim() || "unknown error"}`);
  }
  return [...new Set(listed.stdout.split("\0").filter(Boolean).map(portablePath))]
    .filter((relative) => !discoveryExcluded(relative))
    .filter((relative) => existsSync(path.join(root, relative)))
    .sort();
}

function localLinkErrors(root, files) {
  const errors = [];
  const link = /!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g;
  for (const relative of files.filter((filename) => filename.endsWith(".md"))) {
    const filename = path.join(root, relative);
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

function nonEmptyLines(filename) {
  return readFileSync(filename, "utf8").split(/\r?\n/u).filter((line) => line.trim()).length;
}

function documentationBudgetErrors(root, files) {
  const errors = [];
  const allowed = new Set(HANDWRITTEN_AGENT_DOCS);
  const handwritten = files.filter(
    (filename) => filename.startsWith("agent_docs/") &&
      filename.endsWith(".md") &&
      !filename.startsWith("agent_docs/generated/")
  );
  for (const filename of handwritten) {
    if (!allowed.has(filename)) errors.push(`${filename}: orphan handwritten agent document; merge it into a core owner or add it deliberately`);
  }
  if (handwritten.length > AGENT_DOC_BUDGETS.files) {
    errors.push(`agent_docs: ${handwritten.length} handwritten files exceed the ${AGENT_DOC_BUDGETS.files}-file budget`);
  }
  let total = 0;
  for (const filename of handwritten) {
    const lines = nonEmptyLines(path.join(root, filename));
    total += lines;
    if (lines > AGENT_DOC_BUDGETS.nonEmptyLinesPerFile) {
      errors.push(`${filename}: ${lines} nonempty lines exceed the ${AGENT_DOC_BUDGETS.nonEmptyLinesPerFile}-line file budget`);
    }
  }
  if (total > AGENT_DOC_BUDGETS.nonEmptyLines) {
    errors.push(`agent_docs: ${total} nonempty lines exceed the ${AGENT_DOC_BUDGETS.nonEmptyLines}-line budget`);
  }
  return errors;
}

function instructionBudgetErrors(root) {
  const errors = [];
  const budgets = [
    ["AGENTS.md", 200],
    ["CLAUDE.md", 80],
    ...NESTED_AGENT_INSTRUCTIONS.map((filename) => [filename, 40]),
    ...NESTED_CLAUDE_INSTRUCTIONS.map((filename) => [filename, 10])
  ];
  for (const [filename, maximum] of budgets) {
    const target = path.join(root, filename);
    if (!existsSync(target)) continue;
    const lines = readFileSync(target, "utf8").split(/\r?\n/u).length;
    if (lines > maximum) errors.push(`${filename}: ${lines} lines exceed the ${maximum}-line instruction budget`);
  }
  return errors;
}

function manifestErrors() {
  const errors = [];
  for (const [label, entries] of [
    ["required", REQUIRED_DOCS],
    ["handwritten", HANDWRITTEN_AGENT_DOCS]
  ]) {
    const seen = new Set();
    for (const filename of entries) {
      if (seen.has(filename)) errors.push(`scripts/docs-manifest.mjs: duplicate ${label} document: ${filename}`);
      seen.add(filename);
    }
  }
  return errors;
}

export function checkDocs(root = process.cwd()) {
  root = path.resolve(root);
  const errors = manifestErrors();
  const files = repositoryFiles(root);
  for (const filename of REQUIRED_DOCS) {
    const target = path.join(root, filename);
    if (!existsSync(target) || !statSync(target).isFile()) errors.push(`missing required document: ${filename}`);
  }
  errors.push(...documentationBudgetErrors(root, files));
  errors.push(...instructionBudgetErrors(root));
  errors.push(...localLinkErrors(root, files));
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
  const errors = checkDocs(path.resolve(cliRoot(argv)));
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
