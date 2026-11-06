import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadShippedSkill, loadShippedSkills, SHIPPED_SKILLS, ShippedSkillError } from "./shippedSkills";

const roots: string[] = [];
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "shipped-skill-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, "skill", path, ".."), { recursive: true });
    writeFileSync(join(root, "skill", path), text);
  }
  return root;
}
const markdown = "---\nname: synthetic-procedure\ndescription: Load for a synthetic procedure.\n---\n# Procedure\n\nFollow the steps.\n";

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("shipped Skills", () => {
  it("ships only the listed Skills, never the coding-agent ones, and each loads as an import would", () => {
    expect(SHIPPED_SKILLS.map((entry) => entry.key)).toEqual(["health-questions"]);
    expect(SHIPPED_SKILLS.some((entry) => entry.directory.includes("aiqsa-troubleshooting"))).toBe(false);
    const [health] = loadShippedSkills();
    expect(health).toMatchObject({ key: "health-questions", content: { name: "health-questions", fileCount: 0, hasExecutables: false } });
    // The run catalog may trim descriptions to 160 characters; the trigger stays inside them.
    expect([...health!.content.description].slice(0, 160).join("")).toMatch(/health/u);
    expect(loadShippedSkills()[0]!.content.bundleDigest).toBe(health!.content.bundleDigest);
  });

  it("reads bundled text files and changes the digest only when the text changes", () => {
    const entry = { key: "synthetic-procedure", directory: "skill" };
    const first = loadShippedSkill(fixture({ "SKILL.md": markdown, "references/steps.md": "Step one." }), entry);
    expect(first.content.files).toEqual([expect.objectContaining({ path: "references/steps.md", kind: "text", textContent: "Step one." })]);
    expect(loadShippedSkill(fixture({ "SKILL.md": markdown, "references/steps.md": "Step one." }), entry).content.bundleDigest)
      .toBe(first.content.bundleDigest);
    expect(loadShippedSkill(fixture({ "SKILL.md": markdown, "references/steps.md": "Step two." }), entry).content.bundleDigest)
      .not.toBe(first.content.bundleDigest);
  });

  it("refuses what bootstrap cannot store: binary files, links and a missing SKILL.md", () => {
    const entry = { key: "synthetic-procedure", directory: "skill" };
    expect(() => loadShippedSkill(fixture({ "notes.md": "No skill file." }), entry)).toThrow(ShippedSkillError);
    const binary = fixture({ "SKILL.md": markdown });
    writeFileSync(join(binary, "skill", "image.bin"), Buffer.from([0, 1, 2, 255]));
    expect(() => loadShippedSkill(binary, entry)).toThrow(ShippedSkillError);
    const linked = fixture({ "SKILL.md": markdown });
    symlinkSync(join(linked, "skill", "SKILL.md"), join(linked, "skill", "copy.md"));
    expect(() => loadShippedSkill(linked, entry)).toThrow(ShippedSkillError);
  });
});
