"use strict";

// The content-free facts of a failure's cause chain, beside its own projection
// (errorSite.cjs): the database facts of the first link that proves them
// (databaseCause.cjs), the Node system code and syscall of the first system
// error, and the class and application site of the root cause. The chain
// follows `cause` (an AggregateError without one, its first error) for a
// bounded depth. Only own data properties are read and nothing else of a
// message, address, port, host or path ever leaves this module. A wrapper that
// must not keep its cause retains these facts instead (`retainFailureCause`).

const { types } = require("node:util");
const { databaseLinkFacts, rememberDatabaseFailure } = require("./databaseCause.cjs");
const { describeError } = require("./errorSite.cjs");

const STATE_KEY = Symbol.for("aiqsa.observability.failure-facts.v1");
const MAX_CHAIN = 8;
const MAX_TRANSACTION_MS = 1_000_000_000;
/** Node errno names (`ENETUNREACH`, `ERR_*`) and undici's own codes. */
const SYSTEM_CODE = /^(?:E[A-Z0-9_]{2,31}|UND_ERR_[A-Z0-9_]{1,24})$/u;
const PRISMA_CODE = /^P\d{4}$/u;
const SQL_STATE = /^[0-9A-Z]{5}$/u;
const CLASS_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u;
const SITE = /^[A-Za-z0-9_.()[\]@+-]+(?:\/[A-Za-z0-9_.()[\]@+-]+)*:\d{1,9}(?::\d{1,9})?$/u;
const DATABASE_FAILURES = new Set([
  "transaction_expired", "transaction_start_timeout", "lock_timeout",
  "statement_timeout", "serialization_conflict", "deadlock"
]);
/** The syscalls a failure may name; any other becomes `other`. */
const FAILURE_SYSCALLS = Object.freeze([
  "accept", "access", "bind", "chmod", "chown", "close", "connect", "copyfile", "fdatasync", "fstat", "fsync",
  "ftruncate", "getaddrinfo", "getnameinfo", "kill", "link", "listen", "lstat", "mkdir", "mkdtemp", "open",
  "opendir", "queryA", "queryAaaa", "queryAny", "queryCname", "queryMx", "queryNs", "querySrv", "queryTxt",
  "read", "readdir", "readlink", "realpath", "rename", "rm", "rmdir", "scandir", "shutdown", "spawn", "spawnSync",
  "stat", "symlink", "truncate", "unlink", "utime", "watch", "write", "writev", "other"
]);
const syscalls = new Set(FAILURE_SYSCALLS);
const DATABASE_KEYS = ["prisma_code", "sqlstate", "db_failure", "tx_timeout_ms", "tx_elapsed_ms"];

/** One table per process: several bundles may load this module. */
function retained() {
  if (!globalThis[STATE_KEY]) {
    Object.defineProperty(globalThis, STATE_KEY, {
      value: new WeakMap(), configurable: false, enumerable: false, writable: false
    });
  }
  return globalThis[STATE_KEY];
}

function dataValue(object, key) {
  if (object === null || (typeof object !== "object" && typeof object !== "function")) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** `spawn /bin/sh` names its command; only the call itself is kept. */
function syscallName(value) {
  if (typeof value !== "string") return undefined;
  const call = value.split(" ", 1)[0];
  return syscalls.has(call) ? call : "other";
}

function milliseconds(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_TRANSACTION_MS ? value : undefined;
}

/** Only values of the closed fact vocabulary survive; anything else is dropped. */
function validFacts(value) {
  const facts = {};
  if (!value || typeof value !== "object") return facts;
  const pick = (key, valid) => { if (valid !== undefined) facts[key] = valid; };
  pick("prisma_code", typeof value.prisma_code === "string" && PRISMA_CODE.test(value.prisma_code) ? value.prisma_code : undefined);
  pick("sqlstate", typeof value.sqlstate === "string" && SQL_STATE.test(value.sqlstate) ? value.sqlstate : undefined);
  pick("db_failure", DATABASE_FAILURES.has(value.db_failure) ? value.db_failure : undefined);
  pick("tx_timeout_ms", milliseconds(value.tx_timeout_ms));
  pick("tx_elapsed_ms", milliseconds(value.tx_elapsed_ms));
  pick("sys_code", typeof value.sys_code === "string" && SYSTEM_CODE.test(value.sys_code) ? value.sys_code : undefined);
  pick("syscall", syscalls.has(value.syscall) ? value.syscall : undefined);
  pick("cause_class", typeof value.cause_class === "string" && CLASS_NAME.test(value.cause_class) ? value.cause_class : undefined);
  pick("cause_site", typeof value.cause_site === "string" && value.cause_site.length <= 160 && SITE.test(value.cause_site)
    ? value.cause_site : undefined);
  return facts;
}

/** The value and its causes, outermost first, without repeats. */
function chainOf(value) {
  const links = [];
  const seen = new Set();
  let current = value;
  while (links.length < MAX_CHAIN && current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    links.push(current);
    let next = dataValue(current, "cause");
    if (next === undefined && current instanceof AggregateError) next = dataValue(dataValue(current, "errors"), "0");
    current = next;
  }
  return links;
}

function addMissing(facts, source, keys) {
  for (const key of keys) {
    if (facts[key] === undefined && source[key] !== undefined) facts[key] = source[key];
  }
}

function collect(value, includeSelf) {
  const links = chainOf(value);
  const facts = {};
  // A database error in the chain states its own facts; only without one do
  // the facts a causeless wrapper retained (or its boundary remembered) count.
  let database = null;
  let remembered = null;
  for (const link of links) {
    database ??= databaseLinkFacts(link);
    const kept = retained().get(link);
    remembered ??= kept && DATABASE_KEYS.some((key) => kept[key] !== undefined) ? kept
      : databaseLinkFacts(link, "remembered");
    if (types.isNativeError(link)) {
      const code = dataValue(link, "code");
      if (facts.sys_code === undefined && typeof code === "string" && SYSTEM_CODE.test(code)) facts.sys_code = code;
      if (facts.syscall === undefined) {
        const call = syscallName(dataValue(link, "syscall"));
        if (call !== undefined) facts.syscall = call;
      }
    }
    if (kept) addMissing(facts, kept, ["sys_code", "syscall"]);
  }
  const proven = database ?? remembered;
  if (proven) addMissing(facts, validFacts(proven), DATABASE_KEYS);
  const root = links.at(-1);
  const keptRoot = root === undefined ? undefined : retained().get(root);
  if (keptRoot?.cause_class !== undefined) {
    facts.cause_class = keptRoot.cause_class;
    if (keptRoot.cause_site !== undefined) facts.cause_site = keptRoot.cause_site;
  } else if (root !== undefined && (links.length > 1 || includeSelf)) {
    const projection = describeError(root);
    if (projection.error_class !== undefined) facts.cause_class = projection.error_class;
    if (projection.error_site !== undefined) facts.cause_site = projection.error_site;
  }
  return facts;
}

/** The facts of a caught value's cause chain, or an empty object. Never throws. */
function describeFailureFacts(value) {
  try {
    if (value === null || typeof value !== "object") return {};
    return collect(value, false);
  } catch {
    return {};
  }
}

/** Gives `wrapper`, which must not keep `cause` itself, the facts of `cause`:
 * the cause is then its root unless a deeper one is known. */
function retainFailureCause(wrapper, cause) {
  try {
    if (wrapper === null || typeof wrapper !== "object" || cause === null || typeof cause !== "object") return;
    const facts = validFacts(collect(cause, true));
    if (Object.keys(facts).length === 0) return;
    retained().set(wrapper, Object.freeze(facts));
    rememberDatabaseFailure(wrapper, { prisma_code: facts.prisma_code, db_failure: facts.db_failure });
  } catch { /* Diagnostics never replace the failure. */ }
}

module.exports = { FAILURE_SYSCALLS, describeFailureFacts, retainFailureCause };
