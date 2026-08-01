import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildGeneratedReference,
  generatedReferenceErrors,
  writeGeneratedReference
} from "../../scripts/generate-doc-reference.mjs";

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "aiqsa-generated-docs-"));
  roots.push(root);
  mkdirSync(path.join(root, "app/api/items/[itemId]"), { recursive: true });
  mkdirSync(path.join(root, "app/api/oauth"), { recursive: true });
  mkdirSync(path.join(root, "prisma"), { recursive: true });
  writeFileSync(
    path.join(root, "app/api/items/[itemId]/route.ts"),
    "export const GET = handler;\nexport const DELETE = handler;\n"
  );
  writeFileSync(
    path.join(root, "app/api/oauth/route.ts"),
    "const start = () => {};\nexport { start as GET, start as POST };\n"
  );
  writeFileSync(
    path.join(root, "prisma/schema.prisma"),
    "model Zebra {\n  id String @id\n}\n\nmodel Alpha {\n  id String @id\n}\n\nenum State {\n  ready\n}\n"
  );
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("generated API and schema reference", () => {
  it("is deterministic, sorted, and understands direct and aliased route methods", () => {
    const root = fixture();
    const first = buildGeneratedReference(root);
    const second = buildGeneratedReference(root);

    expect(first).toBe(second);
    expect(first).toContain("| `/api/items/[itemId]` | `GET`, `DELETE` |");
    expect(first).toContain("| `/api/oauth` | `GET`, `POST` |");
    expect(first.indexOf("`Alpha`")).toBeLessThan(first.indexOf("`Zebra`"));
  });

  it("detects source drift without rewriting the reviewed artifact", () => {
    const root = fixture();
    const target = writeGeneratedReference(root);
    const reviewed = readFileSync(target, "utf8");
    writeFileSync(path.join(root, "app/api/oauth/route.ts"), "export const PATCH = handler;\n");

    expect(generatedReferenceErrors(root)).toEqual([
      "agent_docs/generated/API_AND_SCHEMA.md: stale generated reference; run npm run docs:generate and review the diff"
    ]);
    expect(readFileSync(target, "utf8")).toBe(reviewed);
  });
});
