#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LEGACY_PRIVATE_PATHS = [
  "agent_docs/active_tasks",
  "agent_docs/backlog",
  "agent_docs/done_tasks",
  "agent_docs/archive",
  "agent_docs/exec_plans",
  "agent_docs/exec-plans"
];
const TASK_PATH = "agent_docs/tasks";
const TASK_ARCHIVE_PATH = "agent_docs/task_archive";
const ALLOWED_TASK_FILE = "agent_docs/tasks/README.md";
const ALLOWED_TASK_ARCHIVE_FILE = "agent_docs/task_archive/README.md";
// Older public commits and release tags are intentionally grandfathered. This
// clean commit introduced the local-only task policy and is the immutable scan
// boundary for every later public ref.
const DEFAULT_HISTORY_BASE = "233b7494c00adde46c12e9d49f29676bf52c0f6a";
const PUBLIC_REPOSITORY = /^(?:git@github\.com:|https:\/\/github\.com\/)insciqq\/AIQSA(?:\.git)?$/u;

function git(root, arguments_) {
  const result = spawnSync("git", arguments_, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${arguments_.join(" ")} failed: ${result.stderr.trim() || "unknown error"}`);
  }
  return result.stdout.trim();
}

function forbiddenTaskPath(filename) {
  if (!filename) return false;
  if (LEGACY_PRIVATE_PATHS.some((prefix) => filename === prefix || filename.startsWith(`${prefix}/`))) return true;
  if ((filename === TASK_PATH || filename.startsWith(`${TASK_PATH}/`)) && filename !== ALLOWED_TASK_FILE) return true;
  return (filename === TASK_ARCHIVE_PATH || filename.startsWith(`${TASK_ARCHIVE_PATH}/`))
    && filename !== ALLOWED_TASK_ARCHIVE_FILE;
}

function dockerPatternExpression(pattern) {
  const normalized = pattern.replace(/^\/+|\/+$/gu, "");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*") {
      if (normalized[index + 1] === "*") {
        index += 1;
        if (normalized[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[\\^$+?.()|{}[\]]/gu, "\\$&");
    }
  }
  const prefix = normalized.includes("/") ? "^" : "(?:^|/)";
  return new RegExp(`${prefix}${source}(?:$|/)`, "u");
}

function protectedCandidates(pattern, basename) {
  const normalized = pattern.replace(/^\/+|\/+$/gu, "");
  const wildcard = normalized.search(/[*?[]/u);
  if (wildcard < 0 && path.posix.basename(normalized).includes(".") && path.posix.basename(normalized) !== basename) {
    return [basename, `nested/${basename}`];
  }
  const literalPrefix = normalized.slice(0, wildcard < 0 ? normalized.length : wildcard).replace(/\/+$/u, "");
  const slash = literalPrefix.lastIndexOf("/");
  const directory = slash >= 0 ? literalPrefix.slice(0, slash + 1) : (wildcard < 0 ? `${literalPrefix}/` : "");
  return [...new Set([
    basename,
    `nested/${basename}`,
    directory ? `${directory}${basename}` : "",
    literalPrefix ? `${literalPrefix}/${basename}` : ""
  ].filter(Boolean))];
}

function negationMayInclude(pattern, protectedPath) {
  const normalized = pattern.replace(/^\/+|\/+$/gu, "");
  // Keep the privacy policy deliberately conservative for Docker patterns that
  // this small checker does not fully interpret.
  if (/[\\[]/u.test(normalized)) return true;
  const expression = dockerPatternExpression(pattern);
  if (protectedPath === "agent_docs") {
    if (normalized === "agent_docs" || normalized.startsWith("agent_docs/")) return true;
    return ["agent_docs", "agent_docs/SECURITY.md", "agent_docs/tasks/private-plan.md"]
      .some((candidate) => expression.test(candidate));
  }
  return protectedCandidates(pattern, protectedPath).some((candidate) => expression.test(candidate));
}

function dockerPrivacyErrors(root) {
  const filename = path.join(root, ".dockerignore");
  if (!existsSync(filename)) return ["missing Docker privacy contract: .dockerignore"];
  const rules = readFileSync(filename, "utf8")
    .split(/\r?\n/u)
    .map((line, index) => ({ index, value: line.trim() }))
    .filter(({ value }) => value && !value.startsWith("#"))
    .map(({ index, value }) => ({
      index,
      negated: value.startsWith("!"),
      pattern: value.replace(/^!/u, "").replace(/\/$/u, "")
    }));
  const errors = [];
  for (const [required, protectedPath] of [
    ["agent_docs", "agent_docs"],
    ["**/AGENTS.md", "AGENTS.md"],
    ["**/CLAUDE.md", "CLAUDE.md"]
  ]) {
    const exclusion = rules.filter((rule) => !rule.negated && rule.pattern === required).at(-1);
    if (!exclusion) {
      errors.push(`.dockerignore: missing agent-only exclusion ${required}`);
      continue;
    }
    for (const rule of rules) {
      if (rule.index > exclusion.index && rule.negated && negationMayInclude(rule.pattern, protectedPath)) {
        errors.push(`.dockerignore: later negation !${rule.pattern} may re-include protected ${protectedPath}`);
      }
    }
  }
  return errors;
}

function currentIndexErrors(root) {
  const paths = git(root, ["ls-files", "--", ...LEGACY_PRIVATE_PATHS, TASK_PATH, TASK_ARCHIVE_PATH]);
  return paths.split(/\r?\n/u).filter(forbiddenTaskPath).map(
    (filename) => `${filename}: public Git tracks a private task artifact`
  );
}

function refTreeErrors(root, refs) {
  const errors = [];
  for (const ref of refs) {
    git(root, ["rev-parse", "--verify", `${ref}^{commit}`]);
    const paths = git(root, ["ls-tree", "-r", "--name-only", ref, "--", ...LEGACY_PRIVATE_PATHS, TASK_PATH, TASK_ARCHIVE_PATH]);
    const forbidden = [...new Set(paths.split(/\r?\n/u).filter(forbiddenTaskPath))].sort();
    for (const filename of forbidden) errors.push(`${ref}: release tree contains private task artifact ${filename}`);
  }
  return errors;
}

function isAncestor(root, ancestor, descendant) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: root,
    encoding: "utf8"
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git merge-base --is-ancestor failed: ${result.stderr.trim() || "unknown error"}`);
}

function policyHistoryErrors(root, refs, historySince) {
  const errors = [];
  git(root, ["rev-parse", "--verify", `${historySince}^{commit}`]);
  for (const ref of refs) {
    git(root, ["rev-parse", "--verify", `${ref}^{commit}`]);
    if (!isAncestor(root, historySince, ref)) {
      errors.push(`${ref}: does not descend from the public task privacy baseline ${historySince}`);
      continue;
    }
    const range = `${historySince}..${ref}`;
    const paths = git(root, ["log", "--format=", "--name-only", range, "--", ...LEGACY_PRIVATE_PATHS, TASK_PATH, TASK_ARCHIVE_PATH]);
    const forbidden = [...new Set(paths.split(/\r?\n/u).filter(forbiddenTaskPath))].sort();
    for (const filename of forbidden) {
      errors.push(`${ref}: post-baseline history contains private task artifact ${filename}`);
    }
  }
  return errors;
}

function remoteErrors(root) {
  const names = git(root, ["remote"]).split(/\r?\n/u).filter(Boolean).sort();
  if (!names.includes("origin")) {
    return [`public repository needs an origin remote for release publication; found ${names.join(", ") || "none"}`];
  }
  const fetchUrl = git(root, ["remote", "get-url", "origin"]);
  const pushUrl = git(root, ["remote", "get-url", "--push", "origin"]);
  const errors = [];
  if (!PUBLIC_REPOSITORY.test(fetchUrl)) errors.push(`origin fetch URL is not the public AIQSA GitHub repository: ${fetchUrl}`);
  if (!PUBLIC_REPOSITORY.test(pushUrl)) errors.push(`origin push URL is not the public AIQSA GitHub repository: ${pushUrl}`);
  return errors;
}

function parseArguments(argv) {
  const refs = [];
  let requireOrigin = false;
  let historySince = DEFAULT_HISTORY_BASE;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--require-origin") {
      requireOrigin = true;
    } else if (argument === "--ref") {
      const ref = argv[index + 1];
      if (!ref) throw new Error("--ref requires a value");
      refs.push(ref);
      index += 1;
    } else if (argument.startsWith("--ref=")) {
      refs.push(argument.slice("--ref=".length));
    } else if (argument === "--history-since") {
      const ref = argv[index + 1];
      if (!ref) throw new Error("--history-since requires a value");
      historySince = ref;
      index += 1;
    } else if (argument.startsWith("--history-since=")) {
      historySince = argument.slice("--history-since=".length);
    } else {
      throw new Error("usage: release-privacy-check [--ref <git-ref>] [--history-since <git-ref>] [--require-origin]");
    }
  }
  return { refs: refs.length ? refs : ["HEAD"], historySince, requireOrigin };
}

export function checkReleasePrivacy(root = process.cwd(), options = {}) {
  root = path.resolve(root);
  git(root, ["rev-parse", "--is-inside-work-tree"]);
  const refs = options.refs?.length ? options.refs : ["HEAD"];
  const historySince = options.historySince ?? DEFAULT_HISTORY_BASE;
  const errors = [
    ...dockerPrivacyErrors(root),
    ...currentIndexErrors(root),
    ...refTreeErrors(root, refs),
    ...policyHistoryErrors(root, refs, historySince)
  ];
  if (options.requireOrigin) errors.push(...remoteErrors(root));
  return errors;
}

export function runReleasePrivacyCheck(argv = process.argv.slice(2), root = process.cwd()) {
  const options = parseArguments(argv);
  const errors = checkReleasePrivacy(root, options);
  if (errors.length) throw new Error(`release privacy check failed:\n- ${errors.join("\n- ")}`);
  return `release privacy check passed for ${options.refs.join(", ")} since ${options.historySince}.`;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    console.log(runReleasePrivacyCheck());
  } catch (error) {
    console.error(`release-privacy-check: ${error.message}`);
    process.exitCode = 1;
  }
}
