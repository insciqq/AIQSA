#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TASK_FILE = /^(\d{3,})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const TASK_STEM = /^(\d{3,})-([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const DIRECTORIES = {
  active: "agent_docs/active_tasks",
  backlog: "agent_docs/backlog",
  done: "agent_docs/done_tasks"
};
const DONE_SENTINEL = "Fill this in with the outcome and checks before `task:complete`.";

function taskOrder(left, right) {
  const idOrder = BigInt(left.id) < BigInt(right.id) ? -1 : BigInt(left.id) > BigInt(right.id) ? 1 : 0;
  return idOrder || left.stem.localeCompare(right.stem);
}

function field(body, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...body.matchAll(new RegExp(`^${escaped}:\\s*(.*?)\\s*$`, "gm"))];
  if (matches.length !== 1 || !matches[0][1]) return null;
  return matches[0][1];
}

export function parseDependencies(value) {
  if (value === "none") return [];
  if (!value) throw new Error("missing Depends on field");

  return value.split(",").map((raw) => {
    const trimmed = raw.trim();
    const quoted = trimmed.startsWith("`") || trimmed.endsWith("`");
    const dependency = quoted && trimmed.startsWith("`") && trimmed.endsWith("`")
      ? trimmed.slice(1, -1)
      : trimmed;
    if ((quoted && dependency === trimmed) || !TASK_STEM.test(dependency)) {
      throw new Error(`invalid dependency ${JSON.stringify(trimmed)}; use an exact task stem`);
    }
    return dependency;
  });
}

function doneNotes(body) {
  const marker = /^## Done Notes\s*$/m.exec(body);
  if (!marker) return null;
  return body.slice(marker.index + marker[0].length).trim();
}

function hasDoneEvidence(body) {
  const notes = doneNotes(body);
  return Boolean(notes && !/^Fill this in\b/.test(notes));
}

function discoverDirectory(root, state) {
  const directory = path.join(root, DIRECTORIES[state]);
  if (!existsSync(directory)) return { directory, invalidFiles: [], records: [] };

  const invalidFiles = [];
  const records = [];
  for (const filename of readdirSync(directory).sort()) {
    if (filename === "README.md" || !filename.endsWith(".md")) continue;
    const match = TASK_FILE.exec(filename);
    if (!match) {
      invalidFiles.push(path.join(DIRECTORIES[state], filename));
      continue;
    }
    const absolutePath = path.join(directory, filename);
    const body = readFileSync(absolutePath, "utf8");
    records.push({
      body,
      dependencies: null,
      filename,
      id: match[1],
      path: absolutePath,
      relativePath: path.join(DIRECTORIES[state], filename),
      state,
      status: field(body, "Status"),
      stem: filename.slice(0, -3)
    });
  }
  records.sort(taskOrder);
  return { directory, invalidFiles, records };
}

export function readTaskLedger(root = process.cwd()) {
  const ledgers = Object.fromEntries(
    Object.keys(DIRECTORIES).map((state) => [state, discoverDirectory(root, state)])
  );
  const records = Object.values(ledgers).flatMap((ledger) => ledger.records);
  const byStem = new Map();
  for (const record of records) {
    const matches = byStem.get(record.stem) ?? [];
    matches.push(record);
    byStem.set(record.stem, matches);
  }
  return { byStem, ledgers, records, root };
}

function cycleErrors(openRecords) {
  const open = new Map(openRecords.map((record) => [record.stem, record]));
  const visiting = new Set();
  const visited = new Set();
  const errors = [];

  function visit(stem, trail) {
    if (visiting.has(stem)) {
      const start = trail.indexOf(stem);
      errors.push(`task dependency cycle: ${[...trail.slice(start), stem].join(" -> ")}`);
      return;
    }
    if (visited.has(stem)) return;
    visiting.add(stem);
    const record = open.get(stem);
    for (const dependency of record?.dependencies ?? []) {
      if (open.has(dependency)) visit(dependency, [...trail, stem]);
    }
    visiting.delete(stem);
    visited.add(stem);
  }

  for (const stem of open.keys()) visit(stem, []);
  return [...new Set(errors)];
}

export function validateTaskLedger(root = process.cwd()) {
  const ledger = readTaskLedger(root);
  const errors = Object.values(ledger.ledgers).flatMap((entry) =>
    entry.invalidFiles.map((filename) => `${filename}: task filenames must be <three-or-more-digits>-<kebab-slug>.md`)
  );

  for (const [stem, matches] of ledger.byStem) {
    if (matches.length > 1) errors.push(`${stem}: duplicate task stem across task directories`);
  }

  const openRecords = [...ledger.ledgers.active.records, ...ledger.ledgers.backlog.records];
  for (const record of openRecords) {
    const validStatus = record.state === "active"
      ? record.status === "ready"
      : ["backlog", "pending", "blocked"].includes(record.status);
    if (!validStatus) {
      const expected = record.state === "active" ? "ready" : "backlog, pending, or blocked";
      errors.push(`${record.relativePath}: expected Status: ${expected}`);
    }
    try {
      record.dependencies = parseDependencies(field(record.body, "Depends on"));
    } catch (error) {
      errors.push(`${record.relativePath}: ${error.message}`);
      record.dependencies = [];
    }
    for (const dependency of record.dependencies) {
      const matches = ledger.byStem.get(dependency) ?? [];
      if (matches.length !== 1) {
        errors.push(`${record.relativePath}: dependency ${dependency} does not resolve to exactly one task`);
      }
      if (dependency === record.stem) errors.push(`${record.relativePath}: task cannot depend on itself`);
    }
  }

  for (const record of ledger.ledgers.active.records) {
    for (const dependency of record.dependencies ?? []) {
      const target = ledger.byStem.get(dependency)?.[0];
      if (target && target.state !== "done") {
        errors.push(`${record.relativePath}: active task dependency ${dependency} is not done`);
      }
    }
  }
  errors.push(...cycleErrors(openRecords));

  const historicalDoneStatuses = new Set(["done", "complete", "completed", "ready", "done via completed tasks 130-135"]);
  for (const record of ledger.ledgers.done.records) {
    if (record.status !== null && !historicalDoneStatuses.has(record.status)) {
      errors.push(`${record.relativePath}: unrecognized completed-task status ${JSON.stringify(record.status)}`);
    }
    const notes = doneNotes(record.body);
    if (notes !== null && !hasDoneEvidence(record.body)) {
      errors.push(`${record.relativePath}: Done Notes must contain completion evidence`);
    }
  }

  return { errors, ledger };
}

function assertValid(root) {
  const result = validateTaskLedger(root);
  if (result.errors.length) throw new Error(`task ledger is invalid:\n- ${result.errors.join("\n- ")}`);
  return result.ledger;
}

function resolveIn(ledger, state, reference) {
  const records = ledger.ledgers[state].records;
  const exact = records.find((record) => record.stem === reference);
  if (exact) return exact;
  if (!/^\d{3,}$/.test(reference)) throw new Error(`task ${reference} was not found in ${state}`);
  const matches = records.filter((record) => record.id === reference);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`task ${reference} is ambiguous; use one of: ${matches.map((record) => record.stem).join(", ")}`);
  }
  throw new Error(`task ${reference} was not found in ${state}`);
}

function replaceStatus(body, status) {
  if (!/^Status:\s*.*$/m.test(body)) throw new Error("task has no Status field");
  return body.replace(/^Status:\s*.*$/m, `Status: ${status}`);
}

function removeLegacyClaims(body) {
  return body
    .replace(/^Claimed by:.*\n?/gm, "")
    .replace(/^Claim lease expires:.*\n?/gm, "")
    .replace(/^Claim generation:.*\n?/gm, "");
}

function requireDoneDependencies(ledger, record) {
  const dependencies = parseDependencies(field(record.body, "Depends on"));
  const unfinished = dependencies.filter((dependency) => ledger.byStem.get(dependency)?.[0]?.state !== "done");
  if (unfinished.length) throw new Error(`unfinished dependencies: ${unfinished.join(", ")}`);
}

export function createTask({ root = process.cwd(), slug, summary }) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug ?? "")) {
    throw new Error("slug must be lowercase kebab-case");
  }
  if (!summary?.trim() || /[\r\n]/.test(summary)) throw new Error("--summary must be one non-empty line");
  const ledger = assertValid(root);
  const max = ledger.records.reduce((value, record) => {
    const id = BigInt(record.id);
    return id > value ? id : value;
  }, 0n);
  const next = max + 1n;
  const id = next < 1000n ? next.toString().padStart(3, "0") : next.toString();
  const stem = `${id}-${slug}`;
  const directory = path.join(root, DIRECTORIES.backlog);
  const destination = path.join(directory, `${stem}.md`);
  if (existsSync(destination)) throw new Error(`${stem} already exists`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(destination, `# ${stem}\n\nStatus: backlog\nDepends on: none\n\n## Goal\n\n${summary.trim()}\n\n## Scope\n\n- Define the implementation slice.\n\n## Out Of Scope\n\n- Unrelated product changes.\n\n## Acceptance Criteria\n\n- The goal is observable and verified.\n\n## Tests\n\n- Focused checks for the changed behavior.\n- docker compose exec -T app npm run check.\n\n## Done Notes\n\n${DONE_SENTINEL}\n`, "utf8");
  return stem;
}

export function promoteTask({ root = process.cwd(), reference }) {
  const ledger = assertValid(root);
  const record = resolveIn(ledger, "backlog", reference);
  if (record.status !== "backlog") throw new Error(`${record.stem} is ${record.status}, not ready for promotion`);
  requireDoneDependencies(ledger, record);
  const destination = path.join(ledger.ledgers.active.directory, record.filename);
  if (existsSync(destination)) throw new Error(`${record.stem} already exists in active_tasks`);
  mkdirSync(ledger.ledgers.active.directory, { recursive: true });
  writeFileSync(record.path, removeLegacyClaims(replaceStatus(record.body, "ready")), "utf8");
  renameSync(record.path, destination);
  return record.stem;
}

export function completeTask({ root = process.cwd(), reference, date = new Date() }) {
  const ledger = assertValid(root);
  const record = resolveIn(ledger, "active", reference);
  requireDoneDependencies(ledger, record);
  if (!hasDoneEvidence(record.body)) throw new Error("Done Notes must contain completion evidence");
  const destination = path.join(ledger.ledgers.done.directory, record.filename);
  if (existsSync(destination)) throw new Error(`${record.stem} already exists in done_tasks`);
  mkdirSync(ledger.ledgers.done.directory, { recursive: true });
  let body = removeLegacyClaims(replaceStatus(record.body, "done"));
  body = body.replace(/^Completed:.*\n?/m, "");
  body = body.replace(/^Status: done$/m, `Status: done\nCompleted: ${date.toISOString().slice(0, 10)}`);
  writeFileSync(record.path, body, "utf8");
  renameSync(record.path, destination);
  return record.stem;
}

function takeOption(arguments_, name) {
  const prefix = `${name}=`;
  const inline = arguments_.findIndex((argument) => argument.startsWith(prefix));
  if (inline >= 0) return arguments_.splice(inline, 1)[0].slice(prefix.length);
  const index = arguments_.indexOf(name);
  if (index < 0) return null;
  const value = arguments_[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  arguments_.splice(index, 2);
  return value;
}

export function runTaskCli(argv = process.argv.slice(2)) {
  const arguments_ = [...argv];
  const root = path.resolve(takeOption(arguments_, "--root") ?? process.cwd());
  const command = arguments_.shift();
  if (command === "new") {
    const summary = takeOption(arguments_, "--summary");
    const slug = arguments_.shift();
    if (arguments_.length) throw new Error(`unexpected arguments: ${arguments_.join(" ")}`);
    return `Created ${createTask({ root, slug, summary })} in backlog.`;
  }
  if (command === "promote" || command === "complete") {
    const reference = arguments_.shift();
    if (!reference || arguments_.length) throw new Error(`usage: task-ledger ${command} <task-id-or-stem> [--root <path>]`);
    const stem = command === "promote" ? promoteTask({ root, reference }) : completeTask({ root, reference });
    return `${command === "promote" ? "Promoted" : "Completed"} ${stem}.`;
  }
  throw new Error("usage: task-ledger <new|promote|complete> ...");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    console.log(runTaskCli());
  } catch (error) {
    console.error(`task-ledger: ${error.message}`);
    process.exitCode = 1;
  }
}
