#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_DOC_BUDGETS,
  AGENT_RULES_DIRECTORY,
  HANDWRITTEN_AGENT_DOCS,
  INSTRUCTION_BUDGETS,
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

// Committed migrations are not documentation, yet agent documents cite them as code.
const CITABLE_PREFIXES = ["prisma/migrations/"];

function discoveryExcluded(relative, citable = false) {
  if (relative === "agent_docs/tasks/") return false;
  if (["archive", "drafts", "queue"].some((name) => relative === `agent_docs/tasks/${name}/`)) {
    return false;
  }
  if (relative.startsWith("agent_docs/tasks/") && !TASK_CONTRACT_FILES.has(relative)) return true;
  if (citable && CITABLE_PREFIXES.some((prefix) => relative.startsWith(prefix))) return false;
  return DISCOVERY_EXCLUDED_PREFIXES.some((prefix) => relative.startsWith(prefix));
}

function filesystemFiles(root, citable) {
  const files = [];
  function walk(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const relative = portablePath(path.relative(root, target));
      if (discoveryExcluded(entry.isDirectory() ? `${relative}/` : relative, citable)) continue;
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile()) files.push(relative);
    }
  }
  walk(root);
  return files.sort();
}

function repositoryFiles(root, { citable = false } = {}) {
  const inside = spawnSync("git", ["--work-tree", root, "rev-parse", "--is-inside-work-tree"], {
    cwd: root,
    encoding: "utf8"
  });
  if (inside.status !== 0) return filesystemFiles(root, citable);

  const listed = spawnSync(
    "git",
    ["--work-tree", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1_024 * 1_024 }
  );
  if (listed.status !== 0) {
    throw new Error(`git ls-files failed during documentation discovery: ${listed.stderr.trim() || "unknown error"}`);
  }
  return [...new Set(listed.stdout.split("\0").filter(Boolean).map(portablePath))]
    .filter((relative) => !discoveryExcluded(relative, citable))
    .filter((relative) => existsSync(path.join(root, relative)))
    .sort();
}

function isSymlink(filename) {
  try {
    return lstatSync(filename).isSymbolicLink();
  } catch {
    return false;
  }
}

function localLinkErrors(root, files) {
  const errors = [];
  const link = /!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g;
  for (const relative of files.filter((filename) => filename.endsWith(".md"))) {
    const filename = path.join(root, relative);
    // A symlinked rule resolves its links from the target document, which is checked itself.
    if (isSymlink(filename)) continue;
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

function textSize(body) {
  return {
    nonEmptyLines: body.split(/\r?\n/u).filter((line) => line.trim()).length,
    words: body.match(/\S+/gu)?.length ?? 0
  };
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
  let totalWords = 0;
  for (const filename of handwritten) {
    const { nonEmptyLines: lines, words } = textSize(readFileSync(path.join(root, filename), "utf8"));
    total += lines;
    totalWords += words;
    if (lines > AGENT_DOC_BUDGETS.nonEmptyLinesPerFile) {
      errors.push(`${filename}: ${lines} nonempty lines exceed the ${AGENT_DOC_BUDGETS.nonEmptyLinesPerFile}-line file budget`);
    }
    if (words > AGENT_DOC_BUDGETS.wordsPerFile) {
      errors.push(`${filename}: ${words} words exceed the ${AGENT_DOC_BUDGETS.wordsPerFile}-word file budget`);
    }
  }
  if (total > AGENT_DOC_BUDGETS.nonEmptyLines) {
    errors.push(`agent_docs: ${total} nonempty lines exceed the ${AGENT_DOC_BUDGETS.nonEmptyLines}-line budget`);
  }
  if (totalWords > AGENT_DOC_BUDGETS.words) {
    errors.push(`agent_docs: ${totalWords} words exceed the ${AGENT_DOC_BUDGETS.words}-word budget`);
  }
  return errors;
}

function instructionBudgetErrors(root) {
  const errors = [];
  for (const { filename, lines: maximum, words: maximumWords } of INSTRUCTION_BUDGETS) {
    const target = path.join(root, filename);
    if (!existsSync(target)) continue;
    const body = readFileSync(target, "utf8");
    const lines = body.split(/\r?\n/u).length;
    if (lines > maximum) errors.push(`${filename}: ${lines} lines exceed the ${maximum}-line instruction budget`);
    const { words } = textSize(body);
    if (words > maximumWords) errors.push(`${filename}: ${words} words exceed the ${maximumWords}-word instruction budget`);
  }
  return errors;
}

// Claude Code reads only `paths` from rule frontmatter and loads a rule whose frontmatter does not
// parse unconditionally, so the accepted shape is deliberately narrow: quoted globs in a list.
function frontmatterPaths(body) {
  if (!body.startsWith("---\n")) return { paths: null, errors: [] };
  const end = body.indexOf("\n---\n", 4);
  if (end === -1) return { paths: null, errors: ["unterminated frontmatter"] };
  const lines = body.slice(4, end).split("\n");
  if (lines[0] !== "paths:") return { paths: null, errors: ["frontmatter must contain only a paths: list"] };
  const paths = [];
  const errors = [];
  for (const line of lines.slice(1)) {
    const item = /^ {2}- "([^"]+)"$/u.exec(line);
    if (item) paths.push(item[1]);
    else errors.push(`frontmatter line is not a quoted paths item: ${line}`);
  }
  if (!paths.length) errors.push("frontmatter paths list is empty");
  return { paths, errors };
}

function globExpression(glob) {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (glob.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 2;
    } else if (glob.startsWith("/**", index) && index + 3 === glob.length) {
      source += "(?:/.*)?";
      index += 2;
    } else if (glob.startsWith("**", index)) {
      source += ".*";
      index += 1;
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else if (character === "{") source += "(?:";
    else if (character === "}") source += ")";
    else if (character === ",") source += "|";
    else source += character.replace(/[.+^$()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`^${source}$`, "u");
}

function realRelative(root, target) {
  try {
    return portablePath(path.relative(realpathSync(root), realpathSync(target)));
  } catch {
    return null;
  }
}

function ruleErrors(root, files) {
  const errors = [];
  const handwritten = new Set(HANDWRITTEN_AGENT_DOCS);
  const ruleTargets = new Map();
  const rulesRoot = path.join(root, AGENT_RULES_DIRECTORY);
  function walk(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const relative = portablePath(path.relative(root, target));
      if (entry.isDirectory()) {
        walk(target);
        continue;
      }
      if (!entry.name.endsWith(".md")) continue;
      const resolved = entry.isSymbolicLink() ? realRelative(root, target) : null;
      if (!resolved || !handwritten.has(resolved)) {
        errors.push(`${relative}: rules must be symlinks to a handwritten agent document that carries the paths frontmatter`);
        continue;
      }
      ruleTargets.set(resolved, [...(ruleTargets.get(resolved) ?? []), relative]);
    }
  }
  walk(rulesRoot);

  for (const filename of HANDWRITTEN_AGENT_DOCS) {
    const target = path.join(root, filename);
    if (!existsSync(target)) continue;
    const { paths, errors: parseErrors } = frontmatterPaths(readFileSync(target, "utf8"));
    errors.push(...parseErrors.map((message) => `${filename}: ${message}`));
    const rules = ruleTargets.get(filename) ?? [];
    if (paths === null) {
      if (rules.length) errors.push(`${filename}: linked from ${rules.join(", ")} but has no paths frontmatter`);
      continue;
    }
    if (rules.length !== 1) {
      errors.push(`${filename}: paths frontmatter needs exactly one symlink in ${AGENT_RULES_DIRECTORY}/, found ${rules.length}`);
    }
    for (const glob of paths) {
      const expression = globExpression(glob);
      if (!files.some((file) => expression.test(file))) errors.push(`${filename}: paths glob matches no file: ${glob}`);
    }
  }
  return errors;
}

// Private local paths such as `.claude/agents/` are named on purpose and never exist in a clean clone.
function gitIgnored(root, relative) {
  return spawnSync("git", ["check-ignore", "-q", "--no-index", relative], { cwd: root }).status === 0;
}

// Agent documents cite code by repository path in backticks; a renamed file must not leave a stale pointer.
function codePathErrors(root, files) {
  const errors = [];
  const known = new Set(files);
  const directories = new Set();
  for (const file of files) {
    const parts = file.split("/");
    for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join("/"));
  }
  const topLevel = new Set([...directories].filter((directory) => !directory.includes("/")));
  for (const filename of ["AGENTS.md", ...HANDWRITTEN_AGENT_DOCS].filter((name) => known.has(name))) {
    const body = readFileSync(path.join(root, filename), "utf8").replace(/^```[\s\S]*?^```/gmu, "");
    for (const match of body.matchAll(/`([^`\s]+)`/gu)) {
      const candidate = match[1].replace(/\/$/u, "");
      if (!candidate.includes("/") || /[*?{}<>:]/u.test(candidate)) continue;
      if (!topLevel.has(candidate.split("/", 1)[0])) continue;
      if (known.has(candidate) || directories.has(candidate) || gitIgnored(root, match[1])) continue;
      errors.push(`${filename}: cited path does not exist: ${match[1]}`);
    }
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
  errors.push(...ruleErrors(root, files));
  errors.push(...codePathErrors(root, repositoryFiles(root, { citable: true })));
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
