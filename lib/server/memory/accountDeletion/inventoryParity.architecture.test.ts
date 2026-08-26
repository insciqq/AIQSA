import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function accountOwnedMemoryModels(schema: string): readonly string[] {
  return [...schema.matchAll(/^model\s+(\w+)\s+\{([\s\S]*?)^\}/gmu)]
    .flatMap((match) => {
      const name = match[1]!;
      const body = match[2]!;
      return /^(?:\s{2})userId\s+String(?:\s|$)/mu.test(body) &&
        /^(?:Memory|ChatMemory|ModelRunMemory)/u.test(name)
        ? [name]
        : [];
    })
    .sort();
}

describe("account Memory inventory architecture parity", () => {
  it("keeps every account-owned Memory schema owner in inventory and deletion audit", () => {
    const models = accountOwnedMemoryModels(source("prisma/schema.prisma"));
    const inventory = source("lib/server/memory/accountDeletion/inventory.ts");
    const deletion = source("lib/server/memory/accountDeletion/handler.ts");

    expect(models.length).toBeGreaterThan(30);
    for (const model of models) {
      expect(inventory, `${model} missing from account inventory`)
        .toContain(`"${model}"`);
      expect(deletion, `${model} missing from account deletion audit`)
        .toContain(`"${model}"`);
    }
  });
});
