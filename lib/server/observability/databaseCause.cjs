"use strict";

// The content-free projection of a database failure: its Prisma code and, for
// transaction, lock and serialization failures, a closed failure kind. Only
// instances of Prisma's own error classes count, and only their own data
// properties `code`, `errorCode`, `meta.code` and `meta.error` are read, plus
// the PostgreSQL code a connector error states in its structured form; nothing
// else of a message and no getter is evaluated, and no text leaves this module.
// A wrapper that keeps its database cause in `cause` is followed for a bounded
// depth; a wrapper without one carries what its boundary remembered for it.

const STATE_KEY = Symbol.for("aiqsa.observability.database-failure.v1");
const MAX_CAUSE_DEPTH = 4;
const prismaCode = /^P\d{4}$/u;
const sqlState = /^[0-9A-Z]{5}$/u;
const connectorSqlState = /PostgresError\s*\{\s*code:\s*"([0-9A-Z]{5})"/u;
const failureKinds = new Set([
  "transaction_expired", "transaction_start_timeout", "lock_timeout",
  "statement_timeout", "serialization_conflict", "deadlock"
]);
const kindBySqlState = Object.freeze({
  "40001": "serialization_conflict",
  "40P01": "deadlock",
  "55P03": "lock_timeout",
  "57014": "statement_timeout"
});

/** One table per process: several bundles may load this module. */
function remembered() {
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

function stringValue(object, key) {
  const value = dataValue(object, key);
  return typeof value === "string" ? value : undefined;
}

function transactionKind(meta) {
  const detail = stringValue(meta, "error");
  if (detail === undefined) return undefined;
  if (detail.startsWith("Unable to start a transaction")) return "transaction_start_timeout";
  if (detail.includes("expired transaction")) return "transaction_expired";
  return undefined;
}

/** The class that constructed the error. An own `name` alone proves nothing:
 * only an instance of Prisma's own error classes carries a database code. */
function constructorName(error) {
  const prototype = Object.getPrototypeOf(error);
  const constructor = prototype === null ? undefined : dataValue(prototype, "constructor");
  return typeof constructor === "function" ? stringValue(constructor, "name") : undefined;
}

function ownProjection(error) {
  const name = constructorName(error);
  if (name === "PrismaClientKnownRequestError") {
    const code = stringValue(error, "code");
    if (code === undefined || !prismaCode.test(code)) return null;
    const meta = dataValue(error, "meta");
    const state = stringValue(meta, "code");
    const kind = code === "P2028" ? transactionKind(meta)
      : code === "P2034" ? "serialization_conflict"
        : code === "P2010" && state !== undefined && sqlState.test(state) ? kindBySqlState[state] : undefined;
    return kind === undefined ? { prisma_code: code } : { prisma_code: code, db_failure: kind };
  }
  if (name === "PrismaClientInitializationError") {
    const code = stringValue(error, "errorCode");
    return code !== undefined && prismaCode.test(code) ? { prisma_code: code } : null;
  }
  if (name === "PrismaClientUnknownRequestError") {
    // A connector failure without a Prisma code states its PostgreSQL code in
    // a fixed structured form; the rest of the message is never inspected.
    const message = stringValue(error, "message");
    const state = message === undefined ? undefined : connectorSqlState.exec(message)?.[1];
    const kind = state === undefined ? undefined : kindBySqlState[state];
    return kind === undefined ? null : { db_failure: kind };
  }
  return null;
}

function validProjection(value) {
  if (!value || typeof value !== "object") return null;
  const projection = {};
  if (typeof value.prisma_code === "string" && prismaCode.test(value.prisma_code)) projection.prisma_code = value.prisma_code;
  if (typeof value.db_failure === "string" && failureKinds.has(value.db_failure)) projection.db_failure = value.db_failure;
  return projection.prisma_code === undefined && projection.db_failure === undefined ? null : projection;
}

/** Records the proven projection of `cause` on a wrapper that does not keep it. */
function rememberDatabaseFailure(wrapper, projection) {
  try {
    if (wrapper === null || typeof wrapper !== "object") return;
    const valid = validProjection(projection);
    if (valid) remembered().set(wrapper, Object.freeze(valid));
  } catch { /* Diagnostics never replace the failure. */ }
}

/** `{ prisma_code?, db_failure? }` of a caught value, or an empty object. Never throws. */
function describeDatabaseFailure(value) {
  try {
    let current = value;
    for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
      if (current === null || typeof current !== "object") return {};
      const known = ownProjection(current) ?? remembered().get(current);
      if (known) return { ...known };
      current = dataValue(current, "cause");
    }
  } catch { /* An unreadable value has no database projection. */ }
  return {};
}

module.exports = { describeDatabaseFailure, rememberDatabaseFailure };
