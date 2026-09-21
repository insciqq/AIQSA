import { describe, expect, it } from "vitest";
import { SKILL_FILE_MAX_BYTES, SKILL_INSTRUCTIONS_MAX_BYTES } from "../../contracts/skills";
import { skillAlias, skillTarPath } from "../../domain/skillBundlePaths";
import { writeZip } from "../artifacts/zip";
import { createSkillBundle, parseSkillImport, parseSkillMarkdown, skillExportEntries } from "./bundle";
import { readSkillZip } from "./zipReader";

const markdown = (name: string, description = "A useful procedure.", body = "Follow this procedure.") =>
  Buffer.from(`---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
const file = (path: string, bytes: Buffer | string) => ({ path, bytes: typeof bytes === "string" ? Buffer.from(bytes) : bytes });

describe("Skill bundle interchange", () => {
  it("preserves byte order marks and rejects case-folded archive roots", () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf, 0x61]);
    const bundle = createSkillBundle({ name: "bom", description: "Fixture", instructions: "Read" }, [file("references/bom.txt", bom)]);
    expect(Buffer.from(bundle.files[0]!.textContent!)).toEqual(bom);
    const restored = parseSkillImport(readSkillZip(writeZip(skillExportEntries([bundle])))).candidates[0]!.bundle!;
    expect(restored.bundleDigest).toBe(bundle.bundleDigest);
    const named = readSkillZip(writeZip([file("\ufeffname.txt", "value")]));
    expect(named[0]?.path).toBe("\ufeffname.txt");
    const duplicates = parseSkillImport(readSkillZip(writeZip([file("A/SKILL.md", markdown("a")), file("a/SKILL.md", markdown("b")), file("valid/SKILL.md", markdown("valid"))])));
    expect(duplicates.candidates.filter((candidate) => candidate.error?.code === "skill_path_duplicate")).toHaveLength(2);
    expect(duplicates.candidates.at(-1)?.bundle?.name).toBe("valid");
  });
  it("accepts a large library without a separate skill count cap and reports failed skills separately", () => {
    const files = Array.from({ length: 51 }, (_, index) => file(`skill-${index}/SKILL.md`, markdown(`skill-${index}`)));
    files.push(file("too-long/SKILL.md", markdown("too-long", "x".repeat(1025))), file("README.txt", "not a skill"));
    const result = parseSkillImport(readSkillZip(writeZip(files)));
    expect(result.candidates.filter((candidate) => candidate.bundle)).toHaveLength(51);
    expect(result.candidates.at(-1)).toMatchObject({ error: { code: "skill_field_too_long", field: "description", actual: 1025, limit: 1024 } });
    expect(result.ignoredFiles).toBe(1);
  });

  it("accepts real-world field sizes and narrowly repairs an unquoted description colon", () => {
    expect(parseSkillMarkdown(markdown("large", "x".repeat(727), "y".repeat(34343)), "fallback").instructions).toHaveLength(34343);
    expect(parseSkillMarkdown(markdown("description", "Use when: the task needs this workflow"), "fallback").description)
      .toBe("Use when: the task needs this workflow");
    expect(() => parseSkillMarkdown(Buffer.from("---\nname: x\ndescription: y\nmetadata: [broken\n---\nbody"), "x"))
      .toThrow("skill_frontmatter_invalid");
  });

  it("preserves unicode names, unknown frontmatter, binary bytes and executable modes across export", () => {
    const bundle = createSkillBundle({ name: "Проверка текста", description: "Check prose", instructions: "Use references.",
      frontmatterJson: { license: "MIT", metadata: { author: "Synthetic" }, "allowed-tools": "Read", custom: [true, 2] } }, [
      { ...file("scripts/run.py", "#!/usr/bin/env python3\nprint('ok')"), executable: true },
      file("assets/image.bin", Buffer.from([0, 255, 2])), file("references/a.md", "Read this.")
    ]);
    const entries = skillExportEntries([bundle]);
    expect(entries[0]!.path).toBe("skill/SKILL.md");
    const result = parseSkillImport(readSkillZip(writeZip(entries)));
    const imported = result.candidates[0]!.bundle!;
    expect(imported.bundleDigest).toBe(bundle.bundleDigest);
    expect(imported.name).toBe(bundle.name);
    expect(imported.frontmatterJson?.metadata).toEqual({ author: "Synthetic" });
    expect(imported.files.find((entry) => entry.path === "scripts/run.py")?.executable).toBe(true);
  });

  it("accepts highly compressible allowed files and rejects actual oversized expansion", () => {
    const text = "a".repeat(500_000);
    const archive = writeZip([file("skill/SKILL.md", markdown("skill")), file("skill/data.txt", text)]);
    expect(text.length / archive.length).toBeGreaterThan(200);
    expect(parseSkillImport(readSkillZip(archive)).candidates[0]!.bundle?.files[0]?.byteSize).toBe(text.length);
    const oversized = writeZip([file("skill/file", "a".repeat(SKILL_FILE_MAX_BYTES + 1))]);
    const directory = oversized.readUInt32LE(oversized.length - 6);
    oversized.writeUInt32LE(1, 22);
    oversized.writeUInt32LE(1, directory + 24);
    expect(() => readSkillZip(oversized)).toThrow("skill_archive_expansion_invalid");
  });

  it("treats nested SKILL.md as an ordinary bundled file and rejects path aliases atomically", () => {
    const nested = parseSkillImport([file("outer/SKILL.md", markdown("outer")), file("outer/inner/SKILL.md", markdown("inner"))]);
    expect(nested.candidates).toHaveLength(1);
    expect(nested.candidates[0]!.bundle?.files[0]?.path).toBe("inner/SKILL.md");
    for (const entries of [
      [file("references/A.md", "one"), file("references/a.md", "two")],
      [file("references", "one"), file("references/a.md", "two")],
      [file("x".repeat(101), "long")]
    ]) {
      expect(() => createSkillBundle({ name: "skill", description: "test", instructions: "test" }, entries)).toThrow(/skill_path/u);
    }
  });

  it("rejects hostile ZIP metadata and local/central mismatches", () => {
    for (const path of ["../SKILL.md", "/absolute/SKILL.md", "C:/SKILL.md", "skill/../SKILL.md"]) {
      expect(() => readSkillZip(writeZip([file(path, markdown("skill"))]))).toThrow("skill_path_invalid");
    }
    const original = writeZip([file("skill/SKILL.md", markdown("skill"))]);
    const directory = original.readUInt32LE(original.length - 6);
    const malicious = (mutate: (bytes: Buffer) => void) => {
      const bytes = Buffer.from(original);
      mutate(bytes);
      expect(() => readSkillZip(bytes)).toThrow(/skill_/u);
    };
    malicious((bytes) => bytes.writeUInt32LE((0o120777 << 16) >>> 0, directory + 38));
    malicious((bytes) => { bytes.writeUInt16LE(0x1314, directory + 4); bytes.writeUInt32LE((0o120777 << 16) >>> 0, directory + 38); });
    malicious((bytes) => bytes.writeUInt16LE(1, directory + 8));
    malicious((bytes) => bytes.writeUInt16LE(99, directory + 10));
    malicious((bytes) => bytes.writeUInt32LE(0xffffffff, directory + 24));
    malicious((bytes) => bytes.writeUInt32LE(directory + 1, bytes.length - 6));
    malicious((bytes) => bytes.writeUInt32LE(12, 14));
  });

  it("rejects YAML aliases and preserves legacy empty descriptions only at export", () => {
    expect(() => parseSkillMarkdown(Buffer.from("---\nname: skill\ndescription: test\ncustom: &x [a]\nother: *x\n---\nbody"), "skill"))
      .toThrow("skill_frontmatter_invalid");
    const legacy = createSkillBundle({ name: "legacy", description: "", instructions: "Do work" });
    const result = parseSkillImport(skillExportEntries([legacy]));
    expect(legacy.description).toBe("");
    expect(result.candidates[0]?.bundle?.description).toBe("legacy");
    expect(result.candidates[0]?.bundle?.bundleDigest).not.toBe(legacy.bundleDigest);
    expect(() => parseSkillMarkdown(markdown("skill", "required", "я".repeat(SKILL_INSTRUCTIONS_MAX_BYTES / 2 + 1)), "skill"))
      .toThrow("skill_field_too_long");
  });

  it("uses lossless UTF-8 ustar boundaries and deterministic collision aliases", () => {
    expect(skillTarPath(`${"я".repeat(77)}/${"z".repeat(100)}`)).toEqual(["я".repeat(77), "z".repeat(100)]);
    expect(skillTarPath("я".repeat(51))).toBeNull();
    const used = new Set<string>();
    expect([skillAlias("A b", used), skillAlias("a-b", used), skillAlias("Русский", used)])
      .toEqual(["a-b", "a-b-2", "skill"]);
  });
});
