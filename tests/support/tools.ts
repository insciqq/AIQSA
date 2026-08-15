import type { RunTool } from "@/lib/server/tools/types";

export const currentSearchToolFixture: RunTool = Object.freeze({
  capability: "web_search",
  description: "Search one user-selected web source with a concise query.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      query: {
        maxLength: 500,
        minLength: 1,
        type: "string"
      }
    },
    required: ["query"],
    type: "object"
  },
  name: "search_engine_1",
  strict: true
});
