// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { SubagentDefinitionDraft } from "@/lib/contracts/subagentDefinitions";
import { MemorySubagentDefinitionStore } from "@/tests/support/subagentDefinitionStore";
import { renderSubagentTypeCatalog } from "./typeCatalog";
import { createSubagentTypeResolver } from "./typeResolver";

const draft = (name: string, patch: Partial<SubagentDefinitionDraft> = {}): SubagentDefinitionDraft => ({
  description: `Use ${name} for long work.`, effort: "low", instructions: `You are ${name}.`, modelId: "model-cheap", name, tools: ["workspace"], ...patch
});

async function setup() {
  const memory = new MemorySubagentDefinitionStore();
  const db = {} as never;
  const browser = await memory.store.create(db, "user-a", draft("browser"));
  await memory.store.create(db, "user-a", draft("analyst", { effort: null, modelId: null, tools: null }));
  await memory.store.create(db, "user-b", draft("private"));
  if (browser.kind !== "written") throw new Error("create failed");
  return { browser: browser.record, memory, resolver: createSubagentTypeResolver(db, memory.store) };
}

describe("custom sub-agent type resolver", () => {
  it("lists only the user's own types, by name", async () => {
    const { resolver } = await setup();
    expect(await resolver.catalog({ userId: "user-a" })).toEqual([
      { description: "Use analyst for long work.", name: "analyst" }, { description: "Use browser for long work.", name: "browser" }
    ]);
    expect(await resolver.catalog({ userId: "user-c" })).toEqual([]);
  });

  it("resolves the current revision as a snapshot by name or id, and builds no model binding", async () => {
    const { browser, resolver } = await setup();
    const byName = await resolver.resolve({ name: " Browser ", userId: "user-a" });
    expect(byName).toEqual({ kind: "found", type: { definitionId: browser.id, description: "Use browser for long work.", instructions: "You are browser.",
      name: "browser", providerModelId: "model-cheap", reasoningEffort: "low", revisionId: browser.revisionId, toolGroups: ["workspace"] } });
    expect(await resolver.resolve({ definitionId: browser.id, userId: "user-a" })).toEqual(byName);
    expect(await resolver.resolve({ name: "analyst", userId: "user-a" })).toMatchObject({ type: { providerModelId: null, reasoningEffort: null, toolGroups: null } });
  });

  it("follows a rename by id and sees the latest revision", async () => {
    const { browser, memory, resolver } = await setup();
    await memory.store.revise({} as never, "user-a", browser.id, 1, draft("web", { instructions: "Renamed." }));
    expect(await resolver.resolve({ name: "browser", userId: "user-a" })).toEqual({ kind: "unavailable" });
    expect(await resolver.resolve({ definitionId: browser.id, userId: "user-a" })).toMatchObject({ kind: "found", type: { instructions: "Renamed.", name: "web" } });
  });

  it("is unavailable for another user's, a deleted or a malformed type", async () => {
    const { browser, memory, resolver } = await setup();
    expect(await resolver.resolve({ name: "private", userId: "user-a" })).toEqual({ kind: "unavailable" });
    expect(await resolver.resolve({ definitionId: browser.id, userId: "user-b" })).toEqual({ kind: "unavailable" });
    expect(await resolver.resolve({ name: "main", userId: "user-a" })).toEqual({ kind: "unavailable" });
    expect(await resolver.resolve({ definitionId: "../x", userId: "user-a" })).toEqual({ kind: "unavailable" });
    await memory.store.remove({} as never, "user-a", browser.id, 1);
    expect(await resolver.resolve({ definitionId: browser.id, userId: "user-a" })).toEqual({ kind: "unavailable" });
    expect(await resolver.resolve({ name: "browser", userId: "user-a" })).toEqual({ kind: "unavailable" });
  });
});

describe("custom sub-agent catalog in run context", () => {
  it("adds no item without custom types and escapes the user's text", () => {
    expect(renderSubagentTypeCatalog([])).toBeNull();
    const text = renderSubagentTypeCatalog([{ description: "Use <b>me</b> & \"quote\"", name: "browser" }])!;
    expect(text).toContain("<custom_subagents>");
    expect(text).toContain("call_subagent");
    expect(text).toContain("<subagent name=\"browser\">Use &lt;b&gt;me&lt;/b&gt; &amp; &quot;quote&quot;</subagent>");
    expect(text).not.toContain("<b>");
  });
});
