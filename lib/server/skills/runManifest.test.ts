import { describe, expect, it } from "vitest";
import { estimateApproxTokens } from "../../domain/contextBudget";
import { assignSkillAliases, decodeFrozenSkillManifest, freezeSkillManifest, skillCatalogBudget } from "./runManifest";
import { skillToolsForRequest } from "../tools/skill";

const skill = (id: string, name = id) => ({ skillId: id, revisionId: `r-${id}`, name, instructions: `PRIVATE-${id}`, description: "Use for reviewing documents.", fileCount: 1 });

describe("accepted Skills catalog", () => {
  it("keeps a normal multilingual library discoverable when a provider omits the context window", () => {
    const available = Array.from({ length: 24 }, (_, index) => ({
      ...skill(`workflow-${String(index).padStart(2, "0")}`, `Workflow ${index + 1} — document review`),
      description: "Проверяет документ: выделяет факты, открытые вопросы и следующие действия. Используйте для анализа рабочих заметок и подготовки отчёта."
    }));
    const input = { mode: "auto" as const, pinned: available.slice(0, 3), available, toolsSupported: true };
    const frozen = freezeSkillManifest(input);
    expect(frozen.manifest.available).toHaveLength(21);
    expect(frozen.manifest.omittedCount).toBeUndefined();
    expect(estimateApproxTokens(frozen.catalog)).toBeLessThanOrEqual(skillCatalogBudget(undefined));
    expect(frozen.catalog).not.toContain("PRIVATE");
    const small = freezeSkillManifest({ ...input, contextWindow: 8_000 });
    expect(small.manifest.omittedCount).toBeGreaterThan(0);
    expect(estimateApproxTokens(small.catalog)).toBeLessThanOrEqual(skillCatalogBudget(8_000));
  });

  it("delivers the full Agent discovery catalog without AIQSA tools, context text or loaded ordering", () => {
    const available = Array.from({ length: 200 }, (_, index) => ({ ...skill(`a-${String(index).padStart(3, "0")}`),
      description: "長".repeat(1024), loadedBefore: index === 199 }));
    const native = freezeSkillManifest({ mode: "auto", pinned: [skill("p")], available, toolsSupported: false,
      nativeDiscovery: true, contextWindow: 1000, loadedBefore: new Set(["a-199"]) });
    expect(native.catalog).toBe("");
    expect(native.manifest.available).toHaveLength(200);
    expect(native.manifest.available[0]?.skillId).toBe("a-000");
    expect(native.manifest.available.every(entry => !entry.loadedBefore && entry.description.length === 1024)).toBe(true);
    expect(native.manifest.omittedCount).toBeUndefined();
    expect(skillToolsForRequest({ skills: native.manifest })).toEqual([]);
    const off = freezeSkillManifest({ mode: "off", pinned: [skill("p")], available, toolsSupported: false, nativeDiscovery: true });
    expect(off.manifest.available).toEqual([]);
    expect(off.pinned).toHaveLength(1);
  });
  it("freezes aliases without collisions and preserves legacy pinned-only admission", () => {
    const input = [skill("1", "中文"), skill("2", "русский"), skill("3", "skill"), skill("4", "A".repeat(80)), skill("5", "A".repeat(80))];
    const aliases = assignSkillAliases(input).map((item) => item.alias);
    expect(aliases).toEqual(["skill", "skill-2", "skill-3", "a".repeat(64), `${"a".repeat(62)}-2`]);
    const legacy = input.map(({ skillId, revisionId, name }) => ({ skillId, revisionId, name }));
    expect(decodeFrozenSkillManifest(legacy)).toMatchObject({ mode: "off", available: [], pinned: legacy.map((entry, index) => ({ ...entry, alias: aliases[index] })) });
    expect(skillToolsForRequest({ skills: legacy })).toEqual([]);
    expect(decodeFrozenSkillManifest([{ ...legacy[0], alias: "forged" }])).toBeNull();
  });

  it("keeps pinned bodies out of the catalog, escapes metadata and freezes only supported tools", () => {
    const frozen = freezeSkillManifest({ mode: "auto", pinned: [skill("p")], available: [skill("p"), skill("a", "<Review>")], toolsSupported: true, loadedBefore: new Set(["a"]) });
    expect(frozen.catalog).toContain('loaded_before="yes"');
    expect(frozen.catalog).toContain("&lt;Review&gt;");
    expect(frozen.catalog).not.toContain("PRIVATE");
    expect(frozen.manifest.available.map((entry) => entry.skillId)).toEqual(["a"]);
    expect(decodeFrozenSkillManifest(frozen.manifest)).toEqual(frozen.manifest);
    expect(skillToolsForRequest({ skills: frozen.manifest }).map((tool) => tool.name)).toEqual(["load_skill", "read_skill_file"]);
    const off = freezeSkillManifest({ mode: "off", pinned: [skill("p")], available: [skill("a")], toolsSupported: true });
    expect(off.catalog).toBe("");
    expect(skillToolsForRequest({ skills: off.manifest }).map((tool) => tool.name)).toEqual(["read_skill_file"]);
    const unsupported = freezeSkillManifest({ mode: "auto", pinned: [skill("p")], available: [skill("a")], toolsSupported: false });
    expect(unsupported.pinned[0]?.instructions).toBe("PRIVATE-p");
    expect(unsupported.catalog).toBe("");
    expect(skillToolsForRequest({ skills: unsupported.manifest })).toEqual([]);
  });

  it("trims descriptions evenly then retains loaded-before entries within the token budget", () => {
    const available = Array.from({ length: 100 }, (_, index) => ({ ...skill(`skill-${String(index).padStart(3, "0")}`), description: "説明".repeat(500) }));
    const frozen = freezeSkillManifest({ mode: "auto", pinned: [], available, toolsSupported: true, contextWindow: 10_000, loadedBefore: new Set(["skill-099"]) });
    expect(estimateApproxTokens(frozen.catalog)).toBeLessThanOrEqual(skillCatalogBudget(10_000));
    expect(frozen.manifest.available[0]?.skillId).toBe("skill-099");
    expect(frozen.manifest.omittedCount).toBe(available.length - frozen.manifest.available.length);
    expect(frozen.manifest.available.every((entry) => [...entry.description].length === 160)).toBe(true);
    const reordered = freezeSkillManifest({ mode: "auto", pinned: [], available: [...available].reverse(), toolsSupported: true, contextWindow: 10_000, loadedBefore: new Set(["skill-099"]) });
    expect(reordered).toEqual(frozen);
  });

  it("preserves the serialized baseline when ranked selection is absent", () => {
    const input = { mode: "auto" as const, pinned: [skill("p", "Review")],
      available: [skill("b", "Review"), skill("a", "Review")], toolsSupported: true, loadedBefore: new Set(["b"]) };
    const baseline = freezeSkillManifest(input);
    expect(baseline.manifest.available.map(({ skillId, alias, loadedBefore }) => ({ skillId, alias, loadedBefore })))
      .toEqual([{ skillId: "b", alias: "review-3", loadedBefore: true }, { skillId: "a", alias: "review-2", loadedBefore: false }]);
    expect(JSON.stringify(freezeSkillManifest({ ...input, rankedAvailableSkillIds: undefined }))).toBe(JSON.stringify(baseline));
    expect(baseline.manifest.pinned).toEqual([{ skillId: "p", revisionId: "r-p", name: "Review", alias: "review", fileCount: 1 }]);
  });

  it("applies the selected order after stable aliases without changing pins or loaded metadata", () => {
    const input = { mode: "auto" as const, pinned: [skill("p", "Review")],
      available: [skill("b", "Review"), skill("c", "Review"), skill("a", "Review"), skill("p", "Review")],
      toolsSupported: true, loadedBefore: new Set(["a"]) };
    const baseline = freezeSkillManifest(input);
    const ranked = freezeSkillManifest({ ...input, rankedAvailableSkillIds: ["c", "a"] });
    expect(ranked.manifest.available.map(({ skillId, alias, loadedBefore }) => ({ skillId, alias, loadedBefore })))
      .toEqual([{ skillId: "c", alias: "review-4", loadedBefore: false }, { skillId: "a", alias: "review-2", loadedBefore: true }]);
    expect(ranked.pinned).toEqual(baseline.pinned);
    expect(ranked.manifest.pinned).toEqual(baseline.manifest.pinned);
    expect(ranked.manifest.omittedCount).toBeUndefined();
    expect(ranked.catalog.indexOf('alias="review-4"')).toBeLessThan(ranked.catalog.indexOf('alias="review-2"'));
    expect(ranked.catalog).not.toContain('alias="review-3"');
    expect(decodeFrozenSkillManifest(ranked.manifest)).toEqual(ranked.manifest);
    expect(freezeSkillManifest({ ...input, available: [...input.available].reverse(), rankedAvailableSkillIds: ["c", "a"] })).toEqual(ranked);
  });

  it("keeps an empty complete selection empty while retaining pinned instructions and file reads", () => {
    const input = { mode: "auto" as const, pinned: [skill("p")], available: [skill("a")], toolsSupported: true };
    const empty = freezeSkillManifest({ ...input, rankedAvailableSkillIds: [] });
    expect(empty.manifest.available).toEqual([]);
    expect(empty.catalog).toBe("");
    expect(empty.manifest.omittedCount).toBeUndefined();
    expect(empty.pinned).toEqual(freezeSkillManifest(input).pinned);
    expect(skillToolsForRequest({ skills: empty.manifest }).map(({ name }) => name)).toEqual(["read_skill_file"]);
    const noFiles = freezeSkillManifest({ ...input, pinned: [{ ...skill("p"), fileCount: 0 }], rankedAvailableSkillIds: [] });
    expect(noFiles.manifest.tools).toBeUndefined();
  });

  it.each([
    { reason: "unknown identity", value: ["missing"] },
    { reason: "partly unknown selection", value: ["a", "missing"] },
    { reason: "pinned identity", value: ["p"] },
    { reason: "duplicate identity", value: ["a", "a"] },
    { reason: "empty identity", value: [""] },
    { reason: "non-string identity", value: [1] },
    { reason: "sparse array", value: Array(1) },
    { reason: "null", value: null },
    { reason: "non-array", value: "a" }
  ])("retains the entire baseline for an invalid ranked selection: $reason", ({ value }) => {
    const input = { mode: "auto" as const, pinned: [skill("p")], available: [skill("a"), skill("b")], toolsSupported: true };
    const baseline = freezeSkillManifest(input);
    const actual = freezeSkillManifest({ ...input, rankedAvailableSkillIds: value as readonly string[] });
    expect(JSON.stringify(actual)).toBe(JSON.stringify(baseline));
  });

  it("cannot use ranking to restore unavailable catalogs or create tools in native discovery", () => {
    const input = { mode: "auto" as const, pinned: [skill("p")], available: [skill("a"), skill("b")], toolsSupported: false };
    expect(freezeSkillManifest({ ...input, rankedAvailableSkillIds: ["a"] })).toEqual(freezeSkillManifest(input));
    const off = { ...input, mode: "off" as const, nativeDiscovery: true };
    expect(freezeSkillManifest({ ...off, rankedAvailableSkillIds: ["a"] })).toEqual(freezeSkillManifest(off));
    const native = freezeSkillManifest({ ...input, nativeDiscovery: true, rankedAvailableSkillIds: ["b", "a"] });
    expect(native.manifest.available.map(({ skillId }) => skillId)).toEqual(["b", "a"]);
    expect(native.catalog).toBe("");
    expect(native.manifest.tools).toBeUndefined();
    expect(native.pinned).toEqual(freezeSkillManifest(input).pinned);
  });

  it("budgets the selected priority order and counts only budget omissions", () => {
    const available = Array.from({ length: 100 }, (_, index) => ({ ...skill(`skill-${String(index).padStart(3, "0")}`),
      description: "説明".repeat(500) }));
    const rankedIds = available.slice(40).reverse().map(({ skillId }) => skillId);
    const input = { mode: "auto" as const, pinned: [skill("p")], available, toolsSupported: true, contextWindow: 10_000,
      loadedBefore: new Set(["skill-000", "skill-040"]) };
    const ranked = freezeSkillManifest({ ...input, rankedAvailableSkillIds: rankedIds });
    expect(estimateApproxTokens(ranked.catalog)).toBeLessThanOrEqual(skillCatalogBudget(input.contextWindow));
    expect(ranked.manifest.available.length).toBeGreaterThan(0);
    expect(ranked.manifest.available.length).toBeLessThan(rankedIds.length);
    expect(ranked.manifest.available.map(({ skillId }) => skillId)).toEqual(rankedIds.slice(0, ranked.manifest.available.length));
    expect(ranked.manifest.omittedCount).toBe(rankedIds.length - ranked.manifest.available.length);
    expect(ranked.manifest.available.every(entry => [...entry.description].length === 160)).toBe(true);
    expect(ranked.pinned).toEqual(freezeSkillManifest(input).pinned);
    const one = freezeSkillManifest({ ...input, rankedAvailableSkillIds: ["skill-099"] });
    expect(one.manifest.available).toHaveLength(1);
    expect(one.manifest.available[0]!.description).toBe(available[99]!.description);
    expect(one.manifest.omittedCount).toBeUndefined();
  });

  it("rejects malformed or ambiguous persisted manifests without applying current defaults", () => {
    const { manifest } = freezeSkillManifest({ mode: "auto", pinned: [skill("p")], available: [skill("a")], toolsSupported: true });
    expect(decodeFrozenSkillManifest({ ...manifest, available: [{ ...manifest.available[0], alias: manifest.pinned[0]!.alias }] })).toBeNull();
    expect(decodeFrozenSkillManifest({ ...manifest, mode: "off" })).toBeNull();
    expect(decodeFrozenSkillManifest({ ...manifest, surprise: true })).toBeNull();
    expect(decodeFrozenSkillManifest(undefined)).toMatchObject({ mode: "off", available: [], pinned: [] });
  });
});
