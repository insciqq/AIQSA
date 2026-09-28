import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { anthropicStrictSchema, anthropicToolSchemas } from "./anthropicStrictSchema";
import { anthropicMessagesToolBridge } from "../tools/bridges";
import { knowledgeRetrievalToolV2, parseKnowledgeExecutionRequest } from "../knowledge/knowledgeTools";
import { memoryFactExtractionTool } from "../memory/learning/extraction/prompt";
import { analyzeImageTool } from "../tools/analyzeImage";

describe("Anthropic strict schema projection", () => {
  it.each([knowledgeRetrievalToolV2])("projects the production $capability tool without changing its canonical schema", tool => {
    const original = JSON.stringify(tool);
    const hash = createHash("sha256").update(original).digest("hex");
    const projected = anthropicMessagesToolBridge.serializeTool(tool).tool.input_schema as Record<string, unknown>;
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(visit); return; }
      const node = value as Record<string, unknown>;
      for (const key of ["maxItems", "maxLength", "minLength", "pattern", "minimum", "maximum"]) {
        expect(node).not.toHaveProperty(key);
      }
      Object.values(node).forEach(visit);
    };
    visit(projected);
    expect(JSON.stringify(projected)).toContain("Required constraints:");
    expect(createHash("sha256").update(JSON.stringify(tool)).digest("hex")).toBe(hash);
    expect(projected).toMatchObject({ additionalProperties: false, type: "object" });
  });

  it("retains the complete Memory declaration when its grammar exceeds the union limit", () => {
    const original = JSON.stringify(memoryFactExtractionTool);
    const wire = anthropicMessagesToolBridge.serializeTool(memoryFactExtractionTool).tool;
    expect(wire.strict).toBe(false);
    expect(wire.input_schema).toBe(memoryFactExtractionTool.inputSchema);
    expect(JSON.stringify(memoryFactExtractionTool)).toBe(original);
    expect(memoryFactExtractionTool.strict).toBe(true);
  });

  it("budgets unions across all strict tools and keeps unrelated simple tools strict", () => {
    const nullable = { type: ["string", "null"] };
    const tool = { strict: true, inputSchema: { type: "object", additionalProperties: false,
      properties: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`field${i}`, nullable])),
      required: Array.from({ length: 8 }, (_, i) => `field${i}`) } };
    const projected = anthropicToolSchemas([tool, tool, tool, knowledgeRetrievalToolV2]);
    expect(projected.map(tool => tool.strict)).toEqual([true, true, false, true]);
    expect(projected[2]?.inputSchema).toBe(tool.inputSchema);
  });

  it("splits a nullable enum without weakening its allowed values", () => {
    const schema = { type: ["string", "null"], enum: ["SLOT", null] };
    expect(anthropicStrictSchema(schema)).toEqual({ anyOf: [{ type: "string", enum: ["SLOT"] }, { type: "null" }] });
    expect(schema.enum).toEqual(["SLOT", null]);
  });

  it("keeps schema positions separate from property names and literal data", () => {
    const literal = { maxItems: 5, pattern: "literal" };
    const schema = { type: "object", properties: { maxItems: { type: "string", maxLength: 5 },
      payload: { const: literal, enum: [literal] }, list: { type: "array", minItems: 1, maxItems: 3,
        items: { anyOf: [{ type: "integer", minimum: 0 }, { type: "string", format: "custom" }] } } } };
    expect(anthropicStrictSchema(schema)).toMatchObject({ properties: {
      maxItems: { type: "string", description: 'Required constraints: {"maxLength":5}' },
      payload: { const: literal, enum: [literal] },
      list: { minItems: 1, description: 'Required constraints: {"maxItems":3}', items: { anyOf: [
        { type: "integer", description: 'Required constraints: {"minimum":0}' },
        { type: "string", description: 'Required constraints: {"format":"custom"}' }
      ] } }
    } });
  });

  it("keeps non-strict ordinary tools intact and Knowledge validation authoritative", () => {
    const ordinary = analyzeImageTool();
    expect(anthropicMessagesToolBridge.serializeTool(ordinary).tool.input_schema).toBe(ordinary.inputSchema);
    for (const args of [{ query: "", sourceAliases: [] }, { query: "Orion", sourceAliases: ["invalid"] },
      { query: "Orion", sourceAliases: Array.from({ length: 33 }, (_, index) => `S${index + 1}`) }]) {
      expect(parseKnowledgeExecutionRequest({ name: knowledgeRetrievalToolV2.name, arguments: args })).toBeNull();
    }
    expect(parseKnowledgeExecutionRequest({ name: knowledgeRetrievalToolV2.name,
      arguments: { query: "Orion", sourceAliases: [] } })).not.toBeNull();
  });
});
