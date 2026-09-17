import type { ProviderExecutionSnapshot } from "../../../providers/runtimeFactory";
import type { RunTool } from "../../../tools/types";

function isSchema(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaForGemini(schema: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(schema).flatMap(([key, value]) => {
    if (key === "maxItems") return [];
    // Gemini's schema subset uses enum for the extraction contract's string
    // discriminators. Leaving const on the wire can produce invalid tags.
    if (key === "const" && typeof value === "string") {
      if (Object.hasOwn(schema, "enum") &&
        (!Array.isArray(schema.enum) || !schema.enum.includes(value))) {
        throw new Error("memory_fact_provider_schema_invalid");
      }
      return [["enum", [value]]];
    }
    if (key === "enum" && typeof schema.const === "string") return [];
    // Visit schema positions, not property names or const/enum payloads. These
    // are the schema applicators used by the canonical extraction contract.
    if (key === "properties" && isSchema(value)) {
      return [[key, Object.fromEntries(Object.entries(value).map(([name, child]) =>
        [name, isSchema(child) ? schemaForGemini(child) : child]))]];
    }
    if (key === "items" && isSchema(value)) {
      return [[key, schemaForGemini(value)]];
    }
    if (key === "anyOf" && Array.isArray(value)) {
      return [[key, value.map((child: unknown) =>
        isSchema(child) ? schemaForGemini(child) : child)]];
    }
    return [[key, value]];
  }));
}

/** Both tested Gemini 3.8 Flash transports reject the bounded extraction
 * schema. Removing its five maxItems constraints avoids their HTTP 400 while
 * the canonical decoder still enforces every array bound and discriminator.
 * String const becomes an equivalent singleton enum. Other schemas and
 * model versions need their own evidence before receiving this projection. */
export function memoryFactExtractionProviderTool(
  model: Pick<ProviderExecutionSnapshot["model"], "adapterKind" | "upstreamModelId">,
  tool: RunTool
): RunTool {
  const nativeGemini = model.adapterKind === "gemini_interactions_native" &&
    model.upstreamModelId === "gemini-3.8-flash";
  const openRouterGemini = model.adapterKind === "openrouter_chat_completions" &&
    model.upstreamModelId === "google/gemini-3.8-flash";
  if (!nativeGemini && !openRouterGemini) return tool;
  return { ...tool, inputSchema: schemaForGemini(tool.inputSchema) };
}
