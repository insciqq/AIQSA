// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SubagentDefinitionDraft } from "@/lib/contracts/subagentDefinitions";
import { MemorySubagentDefinitionStore } from "@/tests/support/subagentDefinitionStore";
import { decodeFrozenSubagentDefault, freezeSubagentDefault, renderSubagentTypeCatalog, SUBAGENT_TYPE_CATALOG_LIMITS } from "./typeCatalog";
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

  it("marks a type whose tool groups leave the Workspace out, and only such a type", async () => {
    const memory = new MemorySubagentDefinitionStore();
    for (const [name, tools] of [["any", null], ["files", ["workspace", "web_search"]], ["judge", []], ["searcher", ["web_search"]]] as const) {
      await memory.store.create({} as never, "user-a", draft(name, { tools }));
    }
    expect(await createSubagentTypeResolver({} as never, memory.store).catalog({ userId: "user-a" })).toEqual([
      { description: "Use any for long work.", name: "any" }, { description: "Use files for long work.", name: "files" },
      { description: "Use judge for long work.", name: "judge", workspace: false }, { description: "Use searcher for long work.", name: "searcher", workspace: false }
    ]);
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

  it("stays bounded: the first line of each description, short, and at most the cap of types with a count of the rest", () => {
    const long = `${"Compares shop offers carefully. ".repeat(20)}\nSecond line with more detail.`;
    const entries = Array.from({ length: SUBAGENT_TYPE_CATALOG_LIMITS.types + 3 }, (_unused, index) => ({ description: long,
      name: `type-${index}` }));
    const text = renderSubagentTypeCatalog(entries)!;
    const listed = [...text.matchAll(/<subagent name="[^"]+">([^<]*)<\/subagent>/gu)];
    expect(listed).toHaveLength(SUBAGENT_TYPE_CATALOG_LIMITS.types);
    for (const [, description] of listed) {
      expect(Array.from(description!).length).toBeLessThanOrEqual(SUBAGENT_TYPE_CATALOG_LIMITS.descriptionCharacters);
      expect(description).not.toContain("Second line");
      expect(description!.endsWith("…")).toBe(true);
    }
    expect(text).toContain("3 more custom sub-agents are not listed here");
    expect(text).not.toContain(`type-${SUBAGENT_TYPE_CATALOG_LIMITS.types}"`);
    expect(text.length).toBeLessThan(16_000);
    expect(renderSubagentTypeCatalog(entries.slice(0, 2))).not.toContain("more custom sub-agent");
  });

  const ENTRY = { description: "Long research.", name: "browser" };
  const DEFAULT = { definitionId: "def-1", name: "gemini-helper", version: 1 } as const;

  it("says what no type starts without a default, and steers no one toward dropping a type", () => {
    const text = renderSubagentTypeCatalog([ENTRY])!;
    expect(text).toContain("A call with no type starts the built-in sub-agent, which runs on your model with your tools. " +
      "When the user asks for a custom one, pass its name; when none matches, tell the user instead of starting the built-in one.");
    expect(text).not.toMatch(/omit/iu);
    expect(text).not.toContain("default");
  });

  it("names the default and the reserved value, and adds no default's name to the list of types", () => {
    const text = renderSubagentTypeCatalog([ENTRY], DEFAULT)!;
    expect(text).toContain("The user's default sub-agent is \"gemini-helper\": a call with no type starts it, with its own model and tools. " +
      "Another custom one starts by its name, and type \"built-in\" starts the built-in sub-agent, which runs on your model with your tools; " +
      "pass it only when the user asks for it. When the default cannot start, tell the user instead of starting another one.");
    expect([...text.matchAll(/<subagent name="([^"]+)">/gu)].map((match) => match[1])).toEqual(["browser"]);
  });

  it("still names a default past the cut of the list", () => {
    const entries = Array.from({ length: SUBAGENT_TYPE_CATALOG_LIMITS.types + 2 }, (_unused, index) => ({ description: "d", name: `type-${String(index).padStart(2, "0")}` }));
    const last = entries.at(-1)!.name;
    const text = renderSubagentTypeCatalog(entries, { definitionId: "def-last", name: last, version: 1 })!;
    expect(text).not.toContain(`<subagent name="${last}">`);
    expect(text).toContain(`The user's default sub-agent is "${last}"`);
  });

  it("renders the default with no list at all: its definition went or the list could not be read", () => {
    const text = renderSubagentTypeCatalog([], DEFAULT)!;
    expect(text).toContain("The user's default sub-agent is \"gemini-helper\"");
    expect(text).not.toContain("<subagent ");
    expect(renderSubagentTypeCatalog([], null)).toBeNull();
  });

  it("renders a list of types that all have the Workspace byte for byte as it did before any type was marked", () => {
    // The texts of 2026-11-16 before the mark: a change here is a deliberate rewording, never a side effect.
    const sha = (text: string | null) => createHash("sha256").update(text ?? "").digest("hex");
    const entries = [{ description: "Compares shop offers.\nSecond line.", name: "analyst" }, ENTRY];
    expect([renderSubagentTypeCatalog(entries), renderSubagentTypeCatalog(entries, DEFAULT), renderSubagentTypeCatalog([], DEFAULT),
      renderSubagentTypeCatalog(entries, { unreadable: true, version: 1 })].map(sha)).toEqual([
      "c0505d8f592c4c176d2822f8a9ecad30e69b3a1ff9d28e012b18b5b0eb05a1d0",
      "d03f49e5034ae028b4380f998fdf68238489824ede62fe183b12446ae4df1c13",
      "bf94736e7c83773bdabbee7ba414d9156f7c626f350dbea4db76201e0809b3ef",
      "0e4e4f5a5766ca85ac1c707d4301d5d770eeff6892ae7d309c86ba84f1d9f56f"
    ]);
  });

  it("marks a type and a default without the Workspace, says once what the mark means, and names no Workspace path", () => {
    const searcher = { description: "Searches the web.", name: "searcher", workspace: false } as const;
    const text = renderSubagentTypeCatalog([ENTRY, searcher])!;
    const meaning = "A sub-agent marked workspace=\"none\" has no Workspace, so it cannot read or write files: brief it to put its results in its report.";
    expect(text).toContain(`<subagent name="browser">Long research.</subagent>\n<subagent name="searcher" workspace="none">Searches the web.</subagent>`);
    expect(text.split(meaning)).toHaveLength(2);
    // Above the list, below what a call with no type starts.
    expect(text.indexOf(meaning)).toBeGreaterThan(text.indexOf("A call with no type starts"));
    expect(text.indexOf(meaning)).toBeLessThan(text.indexOf("<subagent "));
    expect(text).not.toMatch(/\/workspace/u);
    // The default's line carries the same mark, and it alone brings the meaning.
    const marked = renderSubagentTypeCatalog([ENTRY], { ...DEFAULT, workspace: false })!;
    expect(marked).toContain("The user's default sub-agent is \"gemini-helper\", marked workspace=\"none\": a call with no type starts it");
    expect(marked).toContain(meaning);
    expect(renderSubagentTypeCatalog([], { ...DEFAULT, workspace: false })).toContain(meaning);
    // Nothing marked, nothing said: an unmarked list keeps its text (pinned above).
    for (const plain of [renderSubagentTypeCatalog([ENTRY], DEFAULT)!, renderSubagentTypeCatalog([ENTRY], { unreadable: true, version: 1 })!]) {
      expect(plain).not.toContain("workspace=\"none\"");
    }
    // A marked type past the list's cut is not listed, so the meaning is not said for it.
    const many = Array.from({ length: SUBAGENT_TYPE_CATALOG_LIMITS.types }, (_unused, index) => ({ description: "d", name: `type-${String(index).padStart(2, "0")}` }));
    expect(renderSubagentTypeCatalog([...many, searcher])).not.toContain(meaning);
  });

  it("says a default that could not be read refuses, instead of claiming the built-in", () => {
    const text = renderSubagentTypeCatalog([ENTRY], { unreadable: true, version: 1 })!;
    expect(text).toContain("The user's default sub-agent could not be read for this answer, so a call with no type is refused");
    expect(text).not.toContain("A call with no type starts");
  });
});

describe("the default sub-agent as admission freezes it", () => {
  it("freezes the current pointer, nothing when there is none, and an unread pointer as unreadable", async () => {
    expect(await freezeSubagentDefault(async () => ({ definitionId: "def-1", name: "gemini" }))).toEqual({ definitionId: "def-1", name: "gemini", version: 1 });
    expect(await freezeSubagentDefault(async () => null)).toBeUndefined();
    expect(await freezeSubagentDefault(async () => { throw new Error("database down"); })).toEqual({ unreadable: true, version: 1 });
  });

  it("decodes what it froze; anything else refuses like an unread pointer, never as no default", () => {
    expect(decodeFrozenSubagentDefault(undefined)).toBeNull();
    expect(decodeFrozenSubagentDefault(null)).toBeNull();
    const frozen = { definitionId: "def-1", name: "gemini", version: 1 };
    expect(decodeFrozenSubagentDefault(JSON.parse(JSON.stringify(frozen)))).toEqual(frozen);
    expect(decodeFrozenSubagentDefault({ unreadable: true, version: 1 })).toEqual({ unreadable: true, version: 1 });
    for (const malformed of [{ definitionId: 1, name: "x", version: 1 }, { name: "x", version: 1 }, { definitionId: "d", name: "x", version: 2 }, "def-1", []]) {
      expect(decodeFrozenSubagentDefault(malformed)).toEqual({ unreadable: true, version: 1 });
    }
  });

  it("freezes a default without the Workspace with its mark, within version 1, and reads values frozen before the mark as they were", async () => {
    const marked = await freezeSubagentDefault(async () => ({ definitionId: "def-1", name: "searcher", workspace: false }));
    expect(marked).toEqual({ definitionId: "def-1", name: "searcher", version: 1, workspace: false });
    expect(decodeFrozenSubagentDefault(JSON.parse(JSON.stringify(marked)))).toEqual(marked);
    // A value frozen before the mark existed has none, and still runs its default; a mark of any other value says nothing.
    const older = { definitionId: "def-1", name: "searcher", version: 1 };
    expect(decodeFrozenSubagentDefault(older)).toEqual(older);
    expect(decodeFrozenSubagentDefault({ ...older, workspace: "none" })).toEqual(older);
    expect(decodeFrozenSubagentDefault({ ...older, workspace: true })).toEqual(older);
  });
});
