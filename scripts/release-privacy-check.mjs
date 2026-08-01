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
const ALLOWED_TASK_FILE = "agent_docs/tasks/README.md";
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
  return (filename === TASK_PATH || filename.startsWith(`${TASK_PATH}/`)) && filename !== ALLOWED_TASK_FILE;
}

function dockerPrivacyErrors(root) {
  const filename = path.join(root, ".dockerignore");
  if (!existsSync(filename)) return ["missing Docker privacy contract: .dockerignore"];
  const entries = new Set(
    readFileSync(filename, "utf8")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.replace(/\/$/u, ""))
  );
  const errors = [];
  for (const required of ["agent_docs", "**/AGENTS.md", "**/CLAUDE.md"]) {
    if (!entries.has(required)) errors.push(`.dockerignore: missing agent-only exclusion ${required}`);
  }
  return errors;
}

function currentTreeErrors(root) {
  const paths = git(root, ["ls-files", "--", ...LEGACY_PRIVATE_PATHS, TASK_PATH]);
  return paths.split(/\r?\n/u).filter(forbiddenTaskPath).map(
    (filename) => `${filename}: public Git tracks a private task artifact`
  );
}

function historyErrors(root, refs) {
  const errors = [];
  for (const ref of refs) {
    git(root, ["rev-parse", "--verify", `${ref}^{commit}`]);
    const paths = git(root, ["log", "--format=", "--name-only", ref, "--", ...LEGACY_PRIVATE_PATHS, TASK_PATH]);
    const forbidden = [...new Set(paths.split(/\r?\n/u).filter(forbiddenTaskPath))].sort();
    for (const filename of forbidden) errors.push(`${ref}: history contains private task artifact ${filename}`);
  }
  return errors;
}

function remoteErrors(root) {
  const names = git(root, ["remote"]).split(/\r?\n/u).filter(Boolean).sort();
  if (names.length !== 1 || names[0] !== "origin") {
    return [`public repository must have exactly one remote named origin; found ${names.join(", ") || "none"}`];
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
    } else {
      throw new Error("usage: release-privacy-check [--ref <git-ref>] [--require-origin]");
    }
  }
  return { refs: refs.length ? refs : ["HEAD"], requireOrigin };
}

export function checkReleasePrivacy(root = process.cwd(), options = {}) {
  root = path.resolve(root);
  git(root, ["rev-parse", "--is-inside-work-tree"]);
  const refs = options.refs?.length ? options.refs : ["HEAD"];
  const errors = [
    ...dockerPrivacyErrors(root),
    ...currentTreeErrors(root),
    ...historyErrors(root, refs)
  ];
  if (options.requireOrigin) errors.push(...remoteErrors(root));
  return errors;
}

export function runReleasePrivacyCheck(argv = process.argv.slice(2), root = process.cwd()) {
  const options = parseArguments(argv);
  const errors = checkReleasePrivacy(root, options);
  if (errors.length) throw new Error(`release privacy check failed:\n- ${errors.join("\n- ")}`);
  return `release privacy check passed for ${options.refs.join(", ")}.`;
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
