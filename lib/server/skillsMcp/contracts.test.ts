import { describe, expect, it } from "vitest";
import { SKILL_BUNDLE_MAX_BYTES, SKILL_FILE_MAX_BYTES } from "../../contracts/skills";
import { createSkillBundle, renderSkillMarkdown } from "../skills/bundle";
import { decodeTransferBundle, transferWriteSchema } from "./contracts";

const markdown = Buffer.from("---\nname: portable\ndescription: Synthetic portable package\nmetadata:\n  fixture: yes\n---\nRead references/a.txt.\n");
const file = (path: string, bytes: Buffer, executable = false) => ({ path, contentBase64: bytes.toString("base64"), executable });
describe("Skill store complete package transfer", () => {
  it("preserves binary bytes, executable files, metadata and canonical content identity", () => {
    const bundle = decodeTransferBundle([
      file("SKILL.md", markdown), file("references/a.txt", Buffer.from("reference\n")),
      file("scripts/check", Buffer.from("#!/bin/sh\ntrue\n"), true), file("assets/template.docx", Buffer.from([0, 255, 7, 6]))
    ]);
    expect(bundle.files).toHaveLength(3);
    expect(bundle.files.find((entry) => entry.path === "assets/template.docx")?.bytes).toEqual(Buffer.from([0, 255, 7, 6]));
    expect(bundle.files.find((entry) => entry.path === "scripts/check")?.executable).toBe(true);
    const again = decodeTransferBundle([file("SKILL.md", Buffer.from(renderSkillMarkdown(bundle))),
      ...bundle.files.map((entry) => file(entry.path, entry.bytes, entry.executable))]);
    expect(again.bundleDigest).toBe(bundle.bundleDigest);
    expect(bundle.frontmatterJson).toEqual({ metadata: { fixture: "yes" } });
  });
  it.each(["../escape", "/absolute", "SKILL.md", "skill.md", "scripts/../escape", "references\\secret"])("rejects unsafe or colliding path %s without ignoring it", (path) => {
    expect(() => decodeTransferBundle([file("SKILL.md", markdown), file(path, Buffer.from("extra"))])).toThrow();
  });
  it("requires root markdown and exact base64, rejects type/settings additions", () => {
    expect(() => decodeTransferBundle([file("nested/SKILL.md", markdown)])).toThrow("skill_markdown_required");
    expect(() => decodeTransferBundle([file("SKILL.md", markdown), { path: "extra", contentBase64: "AA=A", executable: false }])).toThrow();
    expect(() => decodeTransferBundle([file("SKILL.md", markdown), { path: "extra", contentBase64: "AB==", executable: false }])).toThrow();
    const value = { operation: "create", operationKey: "fixture-operation-1", files: [file("SKILL.md", markdown)] };
    expect(transferWriteSchema.safeParse(value).success).toBe(true);
    expect(transferWriteSchema.safeParse({ ...value, ownerUserId: "someone" }).success).toBe(false);
    expect(transferWriteSchema.safeParse({ ...value, enabled: false }).success).toBe(false);
    expect(transferWriteSchema.safeParse({ ...value, operation: "update" }).success).toBe(false);
  });
  it("decodes a near-limit binary file without recursive regular-expression expansion", () => {
    const bytes = Buffer.alloc(8 * 1_024 * 1_024, 255);
    const decoded = decodeTransferBundle([file("SKILL.md", markdown), file("assets/large.bin", bytes)]);
    expect(decoded.files[0]!.byteSize).toBe(bytes.length);
    expect(decoded.files[0]!.bytes.equals(bytes)).toBe(true);
  });
  it("reimports a maximum-size canonical bundle after portable title rendering", () => {
    const draft = { name: "A full package with a readable title", description: "Synthetic package", instructions: "Use the files." };
    const headBytes = Buffer.byteLength(renderSkillMarkdown(draft));
    const files = [
      { path: "assets/a.bin", bytes: Buffer.alloc(SKILL_FILE_MAX_BYTES) },
      { path: "assets/b.bin", bytes: Buffer.alloc(SKILL_FILE_MAX_BYTES) },
      { path: "assets/c.bin", bytes: Buffer.alloc(SKILL_BUNDLE_MAX_BYTES - headBytes - 2 * SKILL_FILE_MAX_BYTES) }
    ];
    const original = createSkillBundle(draft, files);
    const portable = Buffer.from(renderSkillMarkdown(original, "a-full-package"));
    expect(portable.length + files.reduce((sum, entry) => sum + entry.bytes.length, 0)).toBeGreaterThan(SKILL_BUNDLE_MAX_BYTES);
    expect(decodeTransferBundle([file("SKILL.md", portable), ...files.map(entry => file(entry.path, entry.bytes))]).bundleDigest).toBe(original.bundleDigest);
    expect(() => createSkillBundle({ ...draft, instructions: "More canonical content than the storage limit allows." }, files)).toThrow("skill_limit_exceeded");
  });
  it("rejects parent paths that collide with a regular file", () => {
    expect(() => createSkillBundle({ name: "fixture", description: "Fixture", instructions: "Use files." }, [
      { path: "scripts", bytes: Buffer.from("file") }, { path: "scripts/check", bytes: Buffer.from("child") }
    ])).toThrow("skill_path_duplicate");
  });
});
