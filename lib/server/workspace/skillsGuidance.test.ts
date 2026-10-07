// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SKILL_SAVE_MAX_FILES } from "@/lib/contracts/skillSaves";
import { SKILL_COMPATIBILITY_MAX_LENGTH, SKILL_TEXT_FILE_MAX_BYTES } from "@/lib/contracts/skills";
import { SKILL_WORKSPACE_DIRECTORY } from "@/lib/domain/skillBundlePaths";
import { SAVE_SKILL_TOOL_NAME } from "../tools/skillSave";
import { WORKSPACE_SKILLS_GUIDANCE } from "./skillsGuidance";

describe("Skill authoring guide", () => {
  it("names the real tool, paths, limits and guest client it documents", () => {
    for (const anchor of [SAVE_SKILL_TOOL_NAME, `${SKILL_WORKSPACE_DIRECTORY}/<alias>/`, "/workspace/project/skills/<name>/",
      `at most ${SKILL_TEXT_FILE_MAX_BYTES / 1_048_576} MiB per file and ${SKILL_SAVE_MAX_FILES} files`,
      `at most ${SKILL_COMPATIBILITY_MAX_LENGTH} characters`, "# /// script", "uv lock --script run.py", "uv run --script run.py",
      "pnpm install --frozen-lockfile", "--dry-run", "os.environ", "aiqsa.mcp.list_tools()", "aiqsa.mcp.call(", "aiqsa-mcp call",
      "restoreRevision", "Undo"]) expect(WORKSPACE_SKILLS_GUIDANCE).toContain(anchor);
  });

  it("names only error classes the guest client defines", () => {
    const source = readFileSync(join(process.cwd(), "ops/workspace-guest/python/aiqsa/errors.py"), "utf8");
    const defined = new Set([...source.matchAll(/^class (\w+)\(/gmu)].map(match => match[1]));
    const named = /Errors are typed \(aiqsa\.errors\): ([^.]+)\./u.exec(WORKSPACE_SKILLS_GUIDANCE)?.[1]
      ?.split(", ").map(entry => entry.split(" ")[0]!) ?? [];
    expect(named.length).toBeGreaterThan(5);
    for (const name of [...named, "OutcomeUnknown", "ResultUnsupported"]) expect(defined).toContain(name);
  });
});
