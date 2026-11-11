import { describe, expect, it } from "vitest";
import { connectorTurnRules, decodeConnectorTurn, DISCORD_CONNECTOR_NOTE } from "./turn";

describe("connector turn rules", () => {
  it("keep a Telegram turn the linked user's interactive personal run", () => {
    expect(connectorTurnRules("telegram")).toEqual({
      automations: true, memory: true, messageLimits: true, note: null, unattendedMcp: false, workspace: true
    });
  });

  it("make a Discord turn unattended, without Memory, Workspace, automations or the user's message limits, with its note", () => {
    expect(connectorTurnRules("discord")).toEqual({
      automations: false, memory: false, messageLimits: false, note: DISCORD_CONNECTOR_NOTE, unattendedMcp: true, workspace: false
    });
  });

  it("apply to no run a connector did not admit, and read back only a connector the server wrote down", () => {
    expect(connectorTurnRules(undefined)).toBeNull();
    expect(decodeConnectorTurn("discord")).toBe("discord");
    expect(decodeConnectorTurn("telegram")).toBe("telegram");
    for (const value of [undefined, null, true, "slack", "Discord"]) expect(decodeConnectorTurn(value)).toBeUndefined();
  });
});
