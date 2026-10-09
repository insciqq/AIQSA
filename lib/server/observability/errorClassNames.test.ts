// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { globSync } from "tinyglobby";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// The production server bundle renames classes, so telemetry names an error
// by its `name` (see errorSite.cjs). Every application error class must carry
// a literal name of its own or inherit one from an application error class.

type ErrorClassRecord = Readonly<{ base: string; className: string; ownName: string | null; site: string }>;

const sourceRoots = ["app", "components", "features", "lib"];
const rootSources = ["instrumentation.ts", "proxy.ts"];
const errorBase = /(?:Error|Exception)$/u;
const identifier = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u;

function literalText(node: ts.Expression | undefined): string | null {
  let value = node;
  while (value && (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value))) {
    value = value.expression;
  }
  return value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) ? value.text : null;
}

/** `name = "X"` as an instance field or `this.name = "X"` directly in the constructor. */
function ownName(node: ts.ClassLikeDeclaration): string | null {
  for (const member of node.members) {
    if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === "name" &&
      !member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)) {
      return literalText(member.initializer);
    }
    if (!ts.isConstructorDeclaration(member) || !member.body) continue;
    for (const statement of member.body.statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) continue;
      const { left, operatorToken, right } = statement.expression;
      if (operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(left) &&
        left.expression.kind === ts.SyntaxKind.ThisKeyword && left.name.text === "name") return literalText(right);
    }
  }
  return null;
}

function classesIn(file: string, text: string): ErrorClassRecord[] {
  if (!/\bclass\b/u.test(text) || !/\bextends\b/u.test(text)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const found: ErrorClassRecord[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const heritage = node.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword);
      const base = heritage?.types[0]?.expression.getText(source);
      if (base) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        found.push({ base, className: node.name?.text ?? "<anonymous>", ownName: ownName(node), site: `${file}:${line}` });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Error classes whose telemetry name would come from the (renamed) constructor. */
function unnamedErrorClasses(sources: readonly Readonly<{ file: string; text: string }>[]): string[] {
  const classes = sources.flatMap(({ file, text }) => classesIn(file, text));
  const byName = new Map<string, ErrorClassRecord[]>();
  for (const record of classes) byName.set(record.className, [...(byName.get(record.className) ?? []), record]);
  const isError = (record: ErrorClassRecord, seen = new Set<ErrorClassRecord>()): boolean => {
    if (seen.has(record)) return false;
    seen.add(record);
    return errorBase.test(record.base) || (byName.get(record.base) ?? []).some((parent) => isError(parent, seen));
  };
  // A name set by an application base class is assigned to every instance,
  // so a subclass inherits a stable name; a library or built-in base gives none.
  const isNamed = (record: ErrorClassRecord, seen = new Set<ErrorClassRecord>()): boolean => {
    if (seen.has(record)) return false;
    seen.add(record);
    if (record.ownName !== null) return identifier.test(record.ownName) && record.ownName !== "Error";
    const parents = byName.get(record.base) ?? [];
    return parents.length > 0 && parents.every((parent) => isNamed(parent, seen));
  };
  return classes.filter((record) => isError(record) && !isNamed(record))
    .map((record) => `${record.site} ${record.className} extends ${record.base}`);
}

function applicationSources() {
  const files = [
    ...sourceRoots.flatMap((root) => globSync([`${root}/**/*.{ts,tsx,js,cjs,mjs}`], { cwd: process.cwd() })),
    ...rootSources
  ].filter((file) => !/\.(?:test|spec)\.[^.]+$/u.test(file) && !file.endsWith(".d.ts") && !file.includes("/node_modules/"));
  return files.sort().map((file) => ({ file, text: readFileSync(resolve(process.cwd(), file), "utf8") }));
}

describe("readable error class names", () => {
  it("requires a literal name on every application error class", () => {
    const sources = applicationSources();
    const scanned = sources.flatMap(({ file, text }) => classesIn(file, text));
    // A broken scan must not pass silently.
    expect(scanned.length).toBeGreaterThan(200);
    expect(scanned).toContainEqual(expect.objectContaining({ className: "RunPipelineError", ownName: "RunPipelineError" }));
    expect(unnamedErrorClasses(sources)).toEqual([]);
  });

  it("flags a renamed-by-the-bundler class and accepts explicit or inherited names", () => {
    const text = [
      "class Unnamed extends Error {}",
      "class WithField extends Error { override name = \"WithField\"; }",
      "class WithConstructor extends Error { constructor() { super(\"x\"); this.name = \"WithConstructor\"; } }",
      "class Computed extends Error { constructor() { super(\"x\"); this.name = this.constructor.name; } }",
      "class Generic extends Error { override name = \"Error\"; }",
      "class Inherits extends WithConstructor {}",
      "class InheritsUnnamed extends Unnamed {}",
      "class FromLibrary extends Prisma.PrismaClientKnownRequestError {}",
      "class Plain extends Base {}",
      "const Anonymous = class extends TypeError {};"
    ].join("\n");
    expect(unnamedErrorClasses([{ file: "sample.ts", text }])).toEqual([
      "sample.ts:1 Unnamed extends Error",
      "sample.ts:4 Computed extends Error",
      "sample.ts:5 Generic extends Error",
      "sample.ts:7 InheritsUnnamed extends Unnamed",
      "sample.ts:8 FromLibrary extends Prisma.PrismaClientKnownRequestError",
      "sample.ts:10 <anonymous> extends TypeError"
    ]);
  });
});
