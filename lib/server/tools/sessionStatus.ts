import type { RunTool } from "./types";

export const SESSION_STATUS_TOOL_NAME = "get_session_status";
export const sessionStatusTool: RunTool = {
  capability: "session",
  description: "Read this chat's estimated context fullness and remaining space. Use when asked about context or continuing in a new chat. Read-only.",
  inputSchema: { additionalProperties: false, properties: {}, required: [], type: "object" },
  name: SESSION_STATUS_TOOL_NAME,
  strict: true
};
