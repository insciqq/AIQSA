#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TASK_ROOT_DIRECTORY = "agent_docs/tasks";
const TASK_DIRECTORY = `${TASK_ROOT_DIRECTORY}/queue`;
const TASK_ARCHIVE_DIRECTORY = `${TASK_ROOT_DIRECTORY}/archive`;
const TASK_DRAFT_DIRECTORY = `${TASK_ROOT_DIRECTORY}/drafts`;
const LEGACY_TASK_ARCHIVE_DIRECTORY = "agent_docs/task_archive";
const LEGACY_TASK_DRAFT_DIRECTORY = "agent_docs/backlog";
const TASK_FILE = /^(\d{17})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const TASK_STEM = /^(\d{17})-([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const TASK_ID = /^\d{17}$/;
const ALLOWED_STATUSES = new Set(["backlog", "ready", "in_progress", "blocked"]);
const DURABLE_RATIONALE_PREFIX = "moved to ";
const REQUIRED_SECTIONS = [
  "Goal",
  "Context",
  "Scope",
  "Out Of Scope",
  "Acceptance Criteria",
  "Plan",
  "Progress",
  "Decisions",
  "Verification"
];
const READINESS_PLACEHOLDERS = [
  "Link the current owner documents and relevant code paths before promotion.",
  "Define the implementation slice.",
  "Unrelated product changes.",
  "The goal is observable and verified.",
  "Replace this scaffold with concrete implementation milestones.",
  "Replace this scaffold with exact focused checks."
];

function portable(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function taskOrder(left, right) {
  return left.id.localeCompare(right.id) || left.stem.localeCompare(right.stem);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function field(body, name) {
  const matches = [...body.matchAll(new RegExp(`^${escapeRegExp(name)}:\\s*(.*?)\\s*$`, "gmu"))];
  if (matches.length !== 1 || !matches[0][1]) return null;
  return matches[0][1].trim();
}

function replaceField(body, name, value) {
  const expression = new RegExp(`^${escapeRegExp(name)}:\\s*.*$`, "mu");
  if (!expression.test(body)) throw new Error(`task has no ${name} field`);
  return body.replace(expression, `${name}: ${value}`);
}

function sectionOccurrences(body, name) {
  const expression = new RegExp(`^## ${escapeRegExp(name)}\\s*$`, "gmu");
  return [...body.matchAll(expression)];
}

function section(body, name) {
  const matches = sectionOccurrences(body, name);
  if (matches.length !== 1) return null;
  const start = matches[0].index + matches[0][0].length;
  const remainder = body.slice(start);
  const next = /^##\s+/mu.exec(remainder);
  return remainder.slice(0, next?.index ?? remainder.length).trim();
}

function validTimestampId(id) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})$/.exec(id);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, millisecond] = match.map(Number);
  const value = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
  return value.getUTCFullYear() === year
    && value.getUTCMonth() === month - 1
    && value.getUTCDate() === day
    && value.getUTCHours() === hour
    && value.getUTCMinutes() === minute
    && value.getUTCSeconds() === second
    && value.getUTCMilliseconds() === millisecond;
}

function formatTimestampId(date) {
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return [
    pad(date.getFullYear(), 4),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    pad(date.getMilliseconds(), 3)
  ].join("");
}

function isGitRepository(root) {
  return existsSync(path.join(root, ".git"));
}

function legacyLayoutErrors(root) {
  const errors = [];
  const taskRoot = path.join(root, TASK_ROOT_DIRECTORY);
  const allowedEntries = new Set(["README.md", "archive", "drafts", "queue"]);
  if (existsSync(taskRoot)) {
    for (const entry of readdirSync(taskRoot, { withFileTypes: true })) {
      if (!allowedEntries.has(entry.name)) {
        errors.push(
          `${portable(path.join(TASK_ROOT_DIRECTORY, entry.name))}: legacy task-queue entry; `
          + `move unfinished task files to ${TASK_DIRECTORY}`
        );
      }
    }
  }
  for (const [legacyDirectory, destination] of [
    [LEGACY_TASK_ARCHIVE_DIRECTORY, TASK_ARCHIVE_DIRECTORY],
    [LEGACY_TASK_DRAFT_DIRECTORY, TASK_DRAFT_DIRECTORY]
  ]) {
    if (existsSync(path.join(root, legacyDirectory))) {
      errors.push(`${legacyDirectory}: legacy task directory; move its local state to ${destination}`);
    }
  }
  return errors;
}

function isIgnoredTask(root, relativePath) {
  if (!isGitRepository(root)) return true;
  const result = spawnSync("git", ["--work-tree", root, "check-ignore", "-q", "--", portable(relativePath)], {
    cwd: root,
    encoding: "utf8"
  });
  return result.status === 0;
}

export function parseDependencies(value) {
  if (value === "none") return [];
  if (!value) throw new Error("missing Depends on field");

  const dependencies = value.split(",").map((raw) => {
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

  if (new Set(dependencies).size !== dependencies.length) {
    throw new Error("Depends on contains duplicate task stems");
  }
  return dependencies;
}

function discoverTasks(root) {
  const directory = path.join(root, TASK_DIRECTORY);
  if (!existsSync(directory)) return { directory, invalidFiles: [], records: [] };

  const invalidFiles = [];
  const records = [];
  for (const filename of readdirSync(directory).sort()) {
    if (filename === "README.md") continue;
    const absolutePath = path.join(directory, filename);
    const match = TASK_FILE.exec(filename);
    if (!match) {
      invalidFiles.push(portable(path.join(TASK_DIRECTORY, filename)));
      continue;
    }
    const body = readFileSync(absolutePath, "utf8");
    records.push({
      blockedBy: field(body, "Blocked by"),
      body,
      dependencies: null,
      durableRationale: field(body, "Durable rationale"),
      filename,
      id: match[1],
      path: absolutePath,
      relativePath: portable(path.join(TASK_DIRECTORY, filename)),
      status: field(body, "Status"),
      stem: filename.slice(0, -3)
    });
  }
  records.sort(taskOrder);
  return { directory, invalidFiles, records };
}

function discoverArchivedTasks(root) {
  const directory = path.join(root, TASK_ARCHIVE_DIRECTORY);
  if (!existsSync(directory)) return { directory, invalidFiles: [], records: [] };

  const invalidFiles = [];
  const records = [];
  for (const filename of readdirSync(directory).sort()) {
    if (filename === "README.md") continue;
    const absolutePath = path.join(directory, filename);
    const match = TASK_FILE.exec(filename);
    if (!match || !statSync(absolutePath).isFile()) {
      invalidFiles.push(portable(path.join(TASK_ARCHIVE_DIRECTORY, filename)));
      continue;
    }
    const body = readFileSync(absolutePath, "utf8");
    records.push({
      body,
      filename,
      id: match[1],
      path: absolutePath,
      relativePath: portable(path.join(TASK_ARCHIVE_DIRECTORY, filename)),
      status: field(body, "Status"),
      stem: filename.slice(0, -3)
    });
  }
  records.sort(taskOrder);
  return { directory, invalidFiles, records };
}

function discoverDraftTasks(root) {
  const directory = path.join(root, TASK_DRAFT_DIRECTORY);
  if (!existsSync(directory)) return { directory, records: [] };

  const records = [];
  for (const filename of readdirSync(directory).sort()) {
    if (filename === "README.md") continue;
    const absolutePath = path.join(directory, filename);
    const match = TASK_FILE.exec(filename);
    if (!match || !statSync(absolutePath).isFile()) continue;
    const body = readFileSync(absolutePath, "utf8");
    records.push({
      body,
      filename,
      id: match[1],
      path: absolutePath,
      relativePath: portable(path.join(TASK_DRAFT_DIRECTORY, filename)),
      status: field(body, "Status"),
      stem: filename.slice(0, -3)
    });
  }
  records.sort(taskOrder);
  return { directory, records };
}

function indexRecords(records) {
  const byStem = new Map();
  const byId = new Map();
  for (const record of records) {
    const stemMatches = byStem.get(record.stem) ?? [];
    stemMatches.push(record);
    byStem.set(record.stem, stemMatches);

    const idMatches = byId.get(record.id) ?? [];
    idMatches.push(record);
    byId.set(record.id, idMatches);
  }
  return { byId, byStem };
}

export function readTaskLedger(root = process.cwd()) {
  root = path.resolve(root);
  const tasks = discoverTasks(root);
  const archive = discoverArchivedTasks(root);
  const drafts = discoverDraftTasks(root);
  const { byId, byStem } = indexRecords(tasks.records);
  const archiveIndex = indexRecords(archive.records);
  const draftIndex = indexRecords(drafts.records);
  return {
    archive: { ...archive, ...archiveIndex },
    byId,
    byStem,
    drafts: { ...drafts, ...draftIndex },
    root,
    tasks
  };
}

function cycleErrors(records) {
  const open = new Map(records.map((record) => [record.stem, record]));
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

function contentErrors(record) {
  const errors = [];
  for (const name of REQUIRED_SECTIONS) {
    const occurrences = sectionOccurrences(record.body, name);
    if (occurrences.length !== 1) {
      errors.push(`${record.relativePath}: expected exactly one ## ${name} section`);
      continue;
    }
    if (!section(record.body, name)) {
      errors.push(`${record.relativePath}: ## ${name} must not be empty`);
    }
  }
  return errors;
}

function readinessErrors(record) {
  const errors = [];
  for (const placeholder of READINESS_PLACEHOLDERS) {
    if (record.body.includes(placeholder)) {
      errors.push(`${record.relativePath}: replace scaffold placeholder ${JSON.stringify(placeholder)}`);
    }
  }

  const plan = section(record.body, "Plan") ?? "";
  if (!/-\s*\[[ xX]\]\s+\S/mu.test(plan)) {
    errors.push(`${record.relativePath}: ## Plan needs at least one concrete checkbox milestone`);
  }

  const verification = section(record.body, "Verification") ?? "";
  const evidence = verificationEvidence(record.body);
  if (evidence.planned + evidence.passed + evidence.unavailable === 0) {
    errors.push(`${record.relativePath}: ## Verification needs at least one concrete planned or unavailable check`);
  }
  errors.push(...evidence.errors.map((error) => `${record.relativePath}: ${error}`));
  return errors;
}

function verificationEvidence(body) {
  const verification = section(body, "Verification") ?? "";
  const planned = [...verification.matchAll(/^-\s*\[\s\]\s+\S.*$/gmu)].length;
  const passed = [...verification.matchAll(/^-\s*\[[xX]\]\s+\S.*$/gmu)].length;
  const unavailableLines = [...verification.matchAll(/^-\s*Not run:\s*(.*)$/gmu)];
  const validUnavailable = unavailableLines.filter((match) => /^\S.*\s+—\s+\S.*$/u.test(match[1].trim()));
  const errors = [];
  if (unavailableLines.length !== validUnavailable.length) {
    errors.push("every Not run entry must use `Not run: <check> — <specific reason>`");
  }
  return {
    complete: planned === 0
      && passed + validUnavailable.length > 0
      && errors.length === 0
      && !READINESS_PLACEHOLDERS.some((placeholder) => verification.includes(placeholder)),
    errors,
    passed,
    planned,
    unavailable: validUnavailable.length,
    unavailableOnly: passed === 0 && validUnavailable.length > 0
  };
}

function durableRationaleErrors(record, root, { requireSettled = false } = {}) {
  const value = record.durableRationale;
  if (!value) return [`${record.relativePath}: missing Durable rationale field`];
  if (value === "pending") {
    return requireSettled ? [`${record.relativePath}: Durable rationale must be settled before completion`] : [];
  }
  if (value === "none") return [];
  if (!value.startsWith(DURABLE_RATIONALE_PREFIX)) {
    return [`${record.relativePath}: Durable rationale must be pending, none, or moved to <agent_docs owner>`];
  }

  const owners = value.slice(DURABLE_RATIONALE_PREFIX.length).split(",").map((owner) => owner.trim()).filter(Boolean);
  if (!owners.length) return [`${record.relativePath}: Durable rationale moved-to value needs an owner path`];
  const errors = [];
  for (const owner of owners) {
    const normalized = portable(owner);
    if (
      path.isAbsolute(owner)
      || normalized.includes("../")
      || !normalized.startsWith("agent_docs/")
      || normalized === TASK_ROOT_DIRECTORY
      || normalized.startsWith(`${TASK_ROOT_DIRECTORY}/`)
    ) {
      errors.push(`${record.relativePath}: durable rationale owner must be an existing file outside local task directories: ${owner}`);
      continue;
    }
    const ownerPath = path.join(root, owner);
    if (!existsSync(ownerPath) || !statSync(ownerPath).isFile()) {
      errors.push(`${record.relativePath}: durable rationale owner does not exist: ${owner}`);
    }
  }
  return errors;
}

function completionReadiness(record, root) {
  const errors = [];
  const plan = section(record.body, "Plan") ?? "";
  const uncheckedPlanItems = [...plan.matchAll(/^-\s*\[\s\]\s+\S.*$/gmu)].length;
  if (uncheckedPlanItems > 0) {
    errors.push(`${record.relativePath}: ## Plan has ${uncheckedPlanItems} unchecked milestone(s); remove or resolve every item before completion`);
  }

  if ((section(record.body, "Progress") ?? "").trim() === "- Not started.") {
    errors.push(`${record.relativePath}: ## Progress must replace the scaffold value \`- Not started.\` before completion`);
  }
  if ((section(record.body, "Decisions") ?? "").trim() === "- None yet.") {
    errors.push(`${record.relativePath}: ## Decisions must replace the scaffold value \`- None yet.\`; use \`- None.\` when no task-local decision was needed`);
  }

  const evidence = verificationEvidence(record.body);
  if (!evidence.complete) {
    errors.push(`${record.relativePath}: Verification must contain checked results or concrete unavailable evidence and no unchecked checks before completion`);
  }
  errors.push(...evidence.errors.map((error) => `${record.relativePath}: ${error}`));
  errors.push(...durableRationaleErrors(record, root, { requireSettled: true }));
  return { errors, evidence };
}

export function validateTaskLedger(root = process.cwd()) {
  const ledger = readTaskLedger(root);
  const errors = legacyLayoutErrors(ledger.root);
  errors.push(...ledger.tasks.invalidFiles.map(
    (filename) => `${filename}: task filenames must be <YYYYMMDDHHMMSSmmm>-<kebab-slug>.md; only README.md is exempt`
  ));
  errors.push(...ledger.archive.invalidFiles.map(
    (filename) => `${filename}: archived task filenames must be <YYYYMMDDHHMMSSmmm>-<kebab-slug>.md; only README.md is exempt`
  ));

  for (const [stem, matches] of ledger.byStem) {
    if (matches.length > 1) errors.push(`${stem}: duplicate task stem`);
  }
  for (const [id, matches] of ledger.byId) {
    if (matches.length > 1) errors.push(`${id}: duplicate task id`);
  }
  for (const [stem, matches] of ledger.archive.byStem) {
    if (matches.length > 1) errors.push(`${stem}: duplicate archived task stem`);
    if (ledger.byStem.has(stem)) errors.push(`${stem}: task exists in both the open queue and completion archive`);
  }
  for (const [id, matches] of ledger.archive.byId) {
    if (matches.length > 1) errors.push(`${id}: duplicate archived task id`);
    if (ledger.byId.has(id)) errors.push(`${id}: task id exists in both the open queue and completion archive`);
  }

  for (const record of ledger.archive.records) {
    if (!isIgnoredTask(ledger.root, record.relativePath)) {
      errors.push(`${record.relativePath}: archived task instances must be ignored and must not be tracked by public Git`);
    }
    if (!validTimestampId(record.id)) {
      errors.push(`${record.relativePath}: archived task id is not a valid local timestamp`);
    }
    if (record.status !== "completed") {
      errors.push(`${record.relativePath}: archived task Status must be completed`);
    }
  }

  for (const record of ledger.tasks.records) {
    if (!isIgnoredTask(ledger.root, record.relativePath)) {
      errors.push(`${record.relativePath}: task instances must be ignored and must not be tracked by public Git`);
    }
    if (!validTimestampId(record.id)) {
      errors.push(`${record.relativePath}: task id is not a valid local timestamp`);
    }
    if (!ALLOWED_STATUSES.has(record.status)) {
      errors.push(`${record.relativePath}: Status must be backlog, ready, in_progress, or blocked`);
    }
    if (!record.blockedBy) {
      errors.push(`${record.relativePath}: missing Blocked by field`);
    } else if (record.status === "blocked" && record.blockedBy === "none") {
      errors.push(`${record.relativePath}: blocked task needs a specific Blocked by value`);
    } else if (record.status !== "blocked" && record.blockedBy !== "none") {
      errors.push(`${record.relativePath}: non-blocked task must use Blocked by: none`);
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
        errors.push(`${record.relativePath}: dependency ${dependency} does not resolve to exactly one open task`);
      }
      if (dependency === record.stem) errors.push(`${record.relativePath}: task cannot depend on itself`);
    }

    if (["ready", "in_progress"].includes(record.status) && record.dependencies.length > 0) {
      errors.push(`${record.relativePath}: ${record.status} task cannot have open dependencies`);
    }

    errors.push(...contentErrors(record));
    errors.push(...durableRationaleErrors(record, ledger.root));
    if (["ready", "in_progress", "blocked"].includes(record.status)) {
      errors.push(...readinessErrors(record));
    }
  }

  errors.push(...cycleErrors(ledger.tasks.records));
  return { errors, ledger };
}

function assertValid(root) {
  const result = validateTaskLedger(root);
  if (result.errors.length) throw new Error(`task ledger is invalid:\n- ${result.errors.join("\n- ")}`);
  return result.ledger;
}

function resolveTask(ledger, reference) {
  const exact = ledger.tasks.records.find((record) => record.stem === reference);
  if (exact) return exact;
  if (!TASK_ID.test(reference ?? "")) throw new Error(`task ${reference} was not found`);
  const matches = ledger.byId.get(reference) ?? [];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`task ${reference} is ambiguous; use one of: ${matches.map((record) => record.stem).join(", ")}`);
  }
  throw new Error(`task ${reference} was not found`);
}

function resolveDraftTask(ledger, reference) {
  const exact = ledger.drafts.records.find((record) => record.stem === reference);
  if (exact) return exact;
  if (!TASK_ID.test(reference ?? "")) throw new Error(`draft task ${reference} was not found`);
  const matches = ledger.drafts.byId.get(reference) ?? [];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`draft task ${reference} is ambiguous; use one of: ${matches.map((record) => record.stem).join(", ")}`);
  }
  throw new Error(`draft task ${reference} was not found`);
}

function noOpenDependencies(record) {
  const dependencies = parseDependencies(field(record.body, "Depends on"));
  if (dependencies.length) throw new Error(`open dependencies: ${dependencies.join(", ")}`);
}

function nextTaskId(ledger, date = new Date()) {
  let candidate = new Date(date.getTime());
  for (let attempts = 0; attempts < 10_000; attempts += 1) {
    const id = formatTimestampId(candidate);
    if (!ledger.byId.has(id) && !ledger.archive.byId.has(id) && !ledger.drafts.byId.has(id)) return id;
    candidate = new Date(candidate.getTime() + 1);
  }
  throw new Error("could not allocate a unique task timestamp within ten seconds");
}

export function createTask({ root = process.cwd(), slug, summary, date = new Date() }) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug ?? "")) {
    throw new Error("slug must be lowercase kebab-case");
  }
  if (!summary?.trim() || /[\r\n]/u.test(summary)) {
    throw new Error("--summary must be one non-empty line");
  }

  const ledger = assertValid(root);
  const id = nextTaskId(ledger, date);
  const stem = `${id}-${slug}`;
  const destination = path.join(ledger.tasks.directory, `${stem}.md`);
  mkdirSync(ledger.tasks.directory, { recursive: true });
  writeFileSync(destination, `# ${stem}\n\nStatus: backlog\nDepends on: none\nBlocked by: none\nDurable rationale: pending\n\n## Goal\n\n${summary.trim()}\n\n## Context\n\n- Link the current owner documents and relevant code paths before promotion.\n\n## Scope\n\n- Define the implementation slice.\n\n## Out Of Scope\n\n- Unrelated product changes.\n\n## Acceptance Criteria\n\n- The goal is observable and verified.\n\n## Plan\n\n- [ ] Replace this scaffold with concrete implementation milestones.\n\n## Progress\n\n- Not started.\n\n## Decisions\n\n- None yet.\n\n## Verification\n\n- [ ] Replace this scaffold with exact focused checks.\n`, "utf8");
  const relativePath = portable(path.relative(ledger.root, destination));
  if (!isIgnoredTask(ledger.root, relativePath)) {
    unlinkSync(destination);
    throw new Error(`${relativePath} must be ignored before local task creation`);
  }
  return stem;
}

export function promoteTask({ root = process.cwd(), reference }) {
  const ledger = assertValid(root);
  const record = resolveTask(ledger, reference);
  if (!["backlog", "blocked"].includes(record.status)) {
    throw new Error(`${record.stem} is ${record.status}, not eligible for promotion`);
  }
  noOpenDependencies(record);
  const errors = readinessErrors(record);
  if (errors.length) throw new Error(`task is not ready:\n- ${errors.join("\n- ")}`);

  let body = replaceField(record.body, "Status", "ready");
  body = replaceField(body, "Blocked by", "none");
  writeFileSync(record.path, body, "utf8");
  return record.stem;
}

export function startTask({ root = process.cwd(), reference }) {
  const ledger = assertValid(root);
  const record = resolveTask(ledger, reference);
  if (record.status !== "ready") throw new Error(`${record.stem} is ${record.status}, not ready to start`);
  noOpenDependencies(record);
  writeFileSync(record.path, replaceField(record.body, "Status", "in_progress"), "utf8");
  return record.stem;
}

export function blockTask({ root = process.cwd(), reference, reason }) {
  if (!reason?.trim() || /[\r\n]/u.test(reason)) throw new Error("--reason must be one non-empty line");
  const ledger = assertValid(root);
  const record = resolveTask(ledger, reference);
  if (!["ready", "in_progress", "blocked"].includes(record.status)) {
    throw new Error(`${record.stem} is ${record.status}, not eligible to block`);
  }
  let body = replaceField(record.body, "Status", "blocked");
  body = replaceField(body, "Blocked by", reason.trim());
  writeFileSync(record.path, body, "utf8");
  return record.stem;
}

export function parkTask({ root = process.cwd(), reference }) {
  const ledger = assertValid(root);
  const record = resolveTask(ledger, reference);
  if (record.status === "in_progress") {
    throw new Error(`${record.stem} is in_progress; block or otherwise reconcile it before parking`);
  }
  const dependents = ledger.tasks.records.filter(
    (candidate) => candidate.stem !== record.stem && candidate.dependencies.includes(record.stem)
  );
  if (dependents.length) {
    throw new Error(
      `${record.stem} is required by open task(s): ${dependents.map((candidate) => candidate.stem).join(", ")}; `
      + "park those dependents first"
    );
  }
  if (ledger.drafts.byStem.has(record.stem) || ledger.drafts.byId.has(record.id)) {
    throw new Error(`${record.stem} conflicts with an existing draft task`);
  }

  const destination = path.join(ledger.drafts.directory, record.filename);
  const relativePath = portable(path.relative(ledger.root, destination));
  if (existsSync(destination)) throw new Error(`${relativePath} already exists; refusing to overwrite a draft task`);
  if (!isIgnoredTask(ledger.root, relativePath)) {
    throw new Error(`${relativePath} must be ignored before parking a task`);
  }
  mkdirSync(ledger.drafts.directory, { recursive: true });
  renameSync(record.path, destination);
  return { relativePath, stem: record.stem };
}

export function restoreTask({ root = process.cwd(), reference }) {
  const ledger = assertValid(root);
  const record = resolveDraftTask(ledger, reference);
  if (!ALLOWED_STATUSES.has(record.status)) {
    throw new Error(`${record.stem} has Status: ${record.status ?? "missing"}; only unfinished tasks can be restored`);
  }
  if (ledger.byStem.has(record.stem) || ledger.archive.byStem.has(record.stem)) {
    throw new Error(`${record.stem} already exists in the queue or archive`);
  }
  if (ledger.byId.has(record.id) || ledger.archive.byId.has(record.id)) {
    throw new Error(`${record.id} already exists in the queue or archive`);
  }

  const destination = path.join(ledger.tasks.directory, record.filename);
  const relativePath = portable(path.relative(ledger.root, destination));
  if (existsSync(destination)) throw new Error(`${relativePath} already exists; refusing to overwrite a queued task`);
  if (!isIgnoredTask(ledger.root, relativePath)) {
    throw new Error(`${relativePath} must be ignored before restoring a task`);
  }
  mkdirSync(ledger.tasks.directory, { recursive: true });
  renameSync(record.path, destination);
  const validation = validateTaskLedger(ledger.root);
  if (validation.errors.length) {
    renameSync(destination, record.path);
    throw new Error(`draft task cannot be restored:\n- ${validation.errors.join("\n- ")}`);
  }
  return { relativePath, stem: record.stem };
}

function removeDependency(body, dependency) {
  const current = parseDependencies(field(body, "Depends on"));
  if (!current.includes(dependency)) return null;
  const remaining = current.filter((item) => item !== dependency);
  return replaceField(body, "Depends on", remaining.length ? remaining.join(", ") : "none");
}

export function completeTask({ root = process.cwd(), reference }) {
  const ledger = assertValid(root);
  const record = resolveTask(ledger, reference);
  if (record.status !== "in_progress") {
    throw new Error(`${record.stem} is ${record.status}, not completable`);
  }
  noOpenDependencies(record);
  const readiness = completionReadiness(record, ledger.root);
  if (readiness.errors.length) throw new Error(readiness.errors.join("\n"));
  const { evidence } = readiness;
  if (evidence.unavailableOnly) {
    throw new Error("Unavailable-only verification cannot complete a task; block it or add passed evidence");
  }
  const archivePath = path.join(ledger.archive.directory, record.filename);
  const archiveRelativePath = portable(path.relative(ledger.root, archivePath));
  if (existsSync(archivePath)) {
    throw new Error(`${archiveRelativePath} already exists; refusing to overwrite archived task evidence`);
  }
  if (!isIgnoredTask(ledger.root, archiveRelativePath)) {
    throw new Error(`${archiveRelativePath} must be ignored before task completion`);
  }

  let cleared = 0;
  for (const candidate of ledger.tasks.records) {
    if (candidate.stem === record.stem) continue;
    const updated = removeDependency(candidate.body, record.stem);
    if (updated !== null) {
      writeFileSync(candidate.path, updated, "utf8");
      cleared += 1;
    }
  }
  mkdirSync(ledger.archive.directory, { recursive: true });
  writeFileSync(record.path, replaceField(record.body, "Status", "completed"), "utf8");
  renameSync(record.path, archivePath);
  return { archiveRelativePath, cleared, stem: record.stem };
}

export function listTasks(root = process.cwd()) {
  const ledger = assertValid(root);
  if (ledger.tasks.records.length === 0) return "No open tasks.";
  return ledger.tasks.records.map((record) => `${record.status.padEnd(11)} ${record.stem}`).join("\n");
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

function oneReference(arguments_, command) {
  const reference = arguments_.shift();
  if (!reference || arguments_.length) {
    throw new Error(`usage: task-ledger ${command} <task-id-or-stem> [--root <path>]`);
  }
  return reference;
}

export function runTaskCli(argv = process.argv.slice(2)) {
  const arguments_ = [...argv];
  const root = path.resolve(takeOption(arguments_, "--root") ?? process.cwd());
  const command = arguments_.shift();

  if (command === "new") {
    const summary = takeOption(arguments_, "--summary");
    const slug = arguments_.shift();
    if (arguments_.length) throw new Error(`unexpected arguments: ${arguments_.join(" ")}`);
    return `Created ${createTask({ root, slug, summary })} with Status: backlog.`;
  }
  if (command === "list") {
    if (arguments_.length) throw new Error("usage: task-ledger list [--root <path>]");
    return listTasks(root);
  }
  if (command === "block") {
    const reason = takeOption(arguments_, "--reason");
    const reference = oneReference(arguments_, command);
    return `Blocked ${blockTask({ root, reference, reason })}.`;
  }
  if (["park", "restore"].includes(command)) {
    const reference = oneReference(arguments_, command);
    if (command === "park") {
      const result = parkTask({ root, reference });
      return `Parked ${result.stem} at ${result.relativePath}.`;
    }
    const result = restoreTask({ root, reference });
    return `Restored ${result.stem} at ${result.relativePath}.`;
  }
  if (["promote", "start"].includes(command)) {
    const reference = oneReference(arguments_, command);
    if (command === "promote") return `Promoted ${promoteTask({ root, reference })} to ready.`;
    return `Started ${startTask({ root, reference })}.`;
  }
  if (command === "complete") {
    const reference = oneReference(arguments_, command);
    const result = completeTask({ root, reference });
    return `Completed and archived ${result.stem} at ${result.archiveRelativePath}; cleared ${result.cleared} dependency reference(s).`;
  }
  throw new Error("usage: task-ledger <new|promote|start|block|park|restore|complete|list> ...");
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
