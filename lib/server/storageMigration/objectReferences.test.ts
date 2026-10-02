import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { databaseHasObjectReferences, OBJECT_KEY_COLUMNS } from "./objectReferences";

function schemaKeyColumns(): string[] {
  const schema = readFileSync(path.resolve("prisma/schema.prisma"), "utf8");
  const columns: string[] = [];
  let model: string | null = null;
  for (const line of schema.split("\n")) {
    const opened = /^model\s+(\w+)\s*\{/u.exec(line);
    if (opened) { model = opened[1]; continue; }
    if (/^\}/u.test(line)) { model = null; continue; }
    const field = /^\s+(\w+)\s+String\??(?:\s|$)/u.exec(line);
    if (model && field && /storageKey$/iu.test(field[1])) columns.push(`${model}.${field[1]}`);
  }
  return columns.sort();
}

describe("object key column registry", () => {
  it("covers every object-key column in the Prisma schema", () => {
    const listed = OBJECT_KEY_COLUMNS.map(({ column, model }) => `${model}.${column}`).sort();
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed).toEqual(schemaKeyColumns());
  });

  it("probes every existing column in one read-only statement", async () => {
    const tables = [...new Set(OBJECT_KEY_COLUMNS.map(({ model }) => model))].map((name) => ({ name }));
    const $queryRawUnsafe = vi.fn<(sql: string, ...values: unknown[]) => Promise<unknown>>()
      .mockResolvedValueOnce(tables)
      .mockResolvedValueOnce([{ present: true }]);
    await expect(databaseHasObjectReferences({ $queryRawUnsafe } as never)).resolves.toBe(true);
    const sql = $queryRawUnsafe.mock.calls[1]![0];
    expect(sql.startsWith("SELECT (")).toBe(true);
    for (const { column, model } of OBJECT_KEY_COLUMNS) {
      expect(sql).toContain(`FROM "${model}" WHERE "${column}" IS NOT NULL`);
    }
  });

  it("treats a database before its first migration as holding no references", async () => {
    const $queryRawUnsafe = vi.fn<(sql: string, ...values: unknown[]) => Promise<unknown>>()
      .mockResolvedValueOnce([]);
    await expect(databaseHasObjectReferences({ $queryRawUnsafe } as never)).resolves.toBe(false);
    expect($queryRawUnsafe).toHaveBeenCalledTimes(1);
    const partial = vi.fn<(sql: string, ...values: unknown[]) => Promise<unknown>>()
      .mockResolvedValueOnce([{ name: "Attachment" }])
      .mockResolvedValueOnce([{ present: false }]);
    await expect(databaseHasObjectReferences({ $queryRawUnsafe: partial } as never)).resolves.toBe(false);
    expect(partial.mock.calls[1]![0]).toBe(
      'SELECT (EXISTS (SELECT 1 FROM "Attachment" WHERE "storageKey" IS NOT NULL)) AS "present"'
    );
  });
});
