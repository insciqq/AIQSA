import { describe, expect, it } from "vitest";
import { connectorTurnRules, connectorWorkspaceRequest, decodeConnectorTurn, DISCORD_CONNECTOR_NOTE } from "./turn";

describe("connector turn rules", () => {
  it("keep a Telegram turn the linked user's interactive personal run", () => {
    expect(connectorTurnRules("telegram")).toEqual({
      automations: true, memory: true, messageLimits: true, note: null, unattendedMcp: false
    });
  });

  it("make a Discord turn unattended, without Memory, automations or the user's message limits, with its note", () => {
    expect(connectorTurnRules("discord")).toEqual({
      automations: false, memory: false, messageLimits: false, note: DISCORD_CONNECTOR_NOTE, unattendedMcp: true
    });
  });

  it("apply to no run a connector did not admit, and read back only a connector the server wrote down", () => {
    expect(connectorTurnRules(undefined)).toBeNull();
    expect(decodeConnectorTurn("discord")).toBe("discord");
    expect(decodeConnectorTurn("telegram")).toBe("telegram");
    for (const value of [undefined, null, true, "slack", "Discord"]) expect(decodeConnectorTurn(value)).toBeUndefined();
  });
});

describe("a connector turn's Workspace request", () => {
  it("asks for the Workspace whenever the installation offers it and the model calls tools", () => {
    expect(connectorWorkspaceRequest(true, true)).toEqual({ enabled: true });
  });

  it("names why it asks for none: the installation first, then a model without tool calling", () => {
    expect(connectorWorkspaceRequest(false, true)).toEqual({ enabled: false, reason: "installation_disabled" });
    expect(connectorWorkspaceRequest(false, false)).toEqual({ enabled: false, reason: "installation_disabled" });
    expect(connectorWorkspaceRequest(true, false)).toEqual({ enabled: false, reason: "model_no_tools" });
  });
});
