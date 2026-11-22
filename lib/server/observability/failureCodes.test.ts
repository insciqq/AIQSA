// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globSync } from "tinyglobby";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import codes from "./failureCodes.json";
import signInCodes from "./signInCodes.json";

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.tsx?$/u.test(entry.name) && !/\.(?:test|d)\./u.test(entry.name) ? [path] : [];
  });
}

type LoggedCode = Readonly<{ code: string; event: string | null; site: string }>;

/** Events whose `cause` is a registered code too (runtime.cjs `cause: safeCode`), and the one with `fetch_reason`. */
const causeEvents = new Set(["run_http_failed", "tool_call", "mcp_discovery_server_unavailable"]);
/** Helpers that log a code passed by position: the callee and the argument's index. */
const positionalCodes = new Map([["reportReadiness", 1], ["logEmailAttempt", 0]]);

function unwrap(node: ts.Expression): ts.Expression {
  let value = node;
  while (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value) || ts.isNonNullExpression(value)) {
    value = value.expression;
  }
  return value;
}

/**
 * The string literals a code expression can take: a literal, either branch of
 * a conditional or `??`/`||`, and a `const` of the same file holding one.
 * Anything computed (a variable, a call, a template) is left out: the scan is
 * deliberately literal, so it never guesses.
 */
function literals(node: ts.Expression, constants: ReadonlyMap<string, ts.Expression[]>, seen = new Set<string>()): string[] {
  const value = unwrap(node);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return [value.text];
  if (ts.isConditionalExpression(value)) return [...literals(value.whenTrue, constants, seen), ...literals(value.whenFalse, constants, seen)];
  if (ts.isBinaryExpression(value) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(value.operatorToken.kind)) {
    return [...literals(value.left, constants, seen), ...literals(value.right, constants, seen)];
  }
  if (ts.isIdentifier(value) && !seen.has(value.text)) {
    seen.add(value.text);
    return (constants.get(value.text) ?? []).flatMap((initializer) => literals(initializer, constants, seen));
  }
  return [];
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  return ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
}

/** `logEvent`, `reportSubsystemFailure` and the `log…` helpers that pass their fields on to them. */
const isLogger = (name: string) => name === "logEvent" || name === "reportSubsystemFailure" || positionalCodes.has(name) || /^log[A-Z]/u.test(name);

/** The code literals one source passes to a logger: `code` (and `cause`/`fetch_reason` where those are codes) of an object argument, or a positional code. */
function loggedCodes(file: string, text: string): LoggedCode[] {
  if (!/\b(?:log[A-Z]\w*|reportSubsystemFailure|reportReadiness)\(/u.test(text)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : /\.[cm]?js$/u.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const constants = new Map<string, ts.Expression[]>();
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
      ts.isVariableDeclarationList(node.parent) && node.parent.flags & ts.NodeFlags.Const) {
      constants.set(node.name.text, [...constants.get(node.name.text) ?? [], node.initializer]);
    }
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const found: LoggedCode[] = [];
  for (const call of calls) {
    const name = calleeName(call);
    if (!name || !isLogger(name)) continue;
    const site = `${file}:${source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1}`;
    const first = call.arguments[0];
    const event = name === "logEvent" && first ? literals(first, constants)[0] ?? null : null;
    const fields = new Set(["code", ...event && causeEvents.has(event) ? ["cause"] : [], ...event === "tool_call" ? ["fetch_reason"] : []]);
    const position = positionalCodes.get(name);
    const positional = position === undefined ? undefined : call.arguments[position];
    if (positional) for (const code of literals(positional, constants)) found.push({ code, event, site });
    for (const argument of call.arguments) {
      const object = unwrap(argument);
      if (!ts.isObjectLiteralExpression(object)) continue;
      for (const property of object.properties) {
        if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) continue;
        if (!fields.has(property.name.text)) continue;
        for (const code of literals(property.initializer, constants)) found.push({ code, event, site });
      }
    }
  }
  return found;
}

function productionSources(): string[] {
  return globSync(["lib/**/*.{ts,tsx,cjs,mjs,js}", "app/**/*.{ts,tsx}"], {
    ignore: ["**/*.test.*", "**/*.spec.*", "**/*.d.ts", "**/*.d.cts"]
  }).sort();
}

/** Logged codes the runtime would write as `unknown` (or, for a sign-in step, as `sign_in_failed`). */
function unregisteredLoggedCodes(files: ReadonlyArray<Readonly<{ file: string; text: string }>>): string[] {
  const registered = new Set<string>(codes);
  return files.flatMap(({ file, text }) => loggedCodes(file, text))
    .filter(({ code, event }) => event === "sign_in" ? !Object.hasOwn(signInCodes, code) : !registered.has(code))
    .map(({ code, site }) => `${site}: ${code}`);
}

describe("registered thrown failure codes", () => {
  it("registers literal stable codes thrown by production server code", () => {
    const registered = new Set(codes);
    const missing: string[] = [];
    // A deliberately narrow scan: literal first arguments of thrown Error constructors.
    // Arbitrary strings, provider codes and dynamically assembled messages never register themselves.
    const pattern = /throw new (?:[A-Za-z][A-Za-z0-9_]*(?:Error|Failure)|Error)\(\s*["']([a-z][a-z0-9]*(?:_[a-z0-9]+)+)["']/gu;
    for (const path of [...sources("lib/server"), ...sources("app/api")]) {
      for (const match of readFileSync(path, "utf8").matchAll(pattern)) {
        if (!registered.has(match[1]!) && !match[1]!.startsWith("synthetic_")) missing.push(`${path}: ${match[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("registers every research code, since an unregistered one logs as unknown and a refused tool call as a bare failure", () => {
    const registered = new Set(codes);
    /** Names that are no codes: a result's field, a thread name's start, and the two roles' binding keys. */
    const names = new Set(["research_researcher", "research_run", "research_text_draft_", "research_verifier"]);
    /** `verifierRole.ts` builds these from a role's binding key. */
    const built = ["research_researcher_unavailable", "research_researcher_unreadable", "research_verifier_unavailable", "research_verifier_unreadable"];
    const literal = [...sources("lib/server"), ...sources("app/api")].flatMap((path) => [...readFileSync(path, "utf8").matchAll(/"(research_[a-z0-9_]+)"/gu)].map((match) => match[1]!));
    expect([...new Set([...literal, ...built])].filter((code) => !names.has(code) && !registered.has(code))).toEqual([]);
    // `evidenceStore.ts` logs a page the bounds left out under this reason.
    expect(registered.has("page_not_stored")).toBe(true);
  });
});

describe("registered logged codes", () => {
  it("registers every code literal production code logs, since the runtime writes an unregistered one as unknown", () => {
    const files = productionSources().map((file) => ({ file, text: readFileSync(file, "utf8") }));
    expect(unregisteredLoggedCodes(files)).toEqual([]);
  });

  it("catches an unregistered code however a logger receives it", () => {
    const text = `
      const LOCAL = "synthetic_constant_code";
      logEvent("service_operation", { subsystem: "admin", stage: "write", outcome: "failed", code: "synthetic_direct_code" });
      reportSubsystemFailure({ subsystem: "admin", stage: "write", code: ready ? "assistant_listing_failed" : "synthetic_branch_code" });
      logConnect({ code: LOCAL as string });
      logEvent("tool_call", { tool_kind: "other", outcome: "failed", cause: "synthetic_cause_code", fetch_reason: "synthetic_fetch_code" });
      logEvent("provider_operation", { cause: "max_output_tokens" });
      logEvent("sign_in", { step: "start", outcome: "failed", code: "synthetic_sign_in_code" });
      reportReadiness("not_ready", "synthetic_readiness_code", 1);
      logEmailAttempt("synthetic_email_code", "dispatch", 1);
      json({ code: "synthetic_not_logged" });`;
    expect(unregisteredLoggedCodes([{ file: "lib/server/fixture.ts", text }]).map((entry) => entry.split(": ")[1])).toEqual([
      "synthetic_direct_code", "synthetic_branch_code", "synthetic_constant_code", "synthetic_cause_code", "synthetic_fetch_code",
      "synthetic_sign_in_code", "synthetic_readiness_code", "synthetic_email_code"
    ]);
  });
});
