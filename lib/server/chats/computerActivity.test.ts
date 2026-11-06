// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decodeThreadToolActivity } from "../../contracts/chats";
import { decodeSubagentCurrentStep } from "../../contracts/subagentViews";
import { freezeComputerBinding } from "../tools/computerBinding";
import { serializeChatSummary } from "./handlers";
import { summarizeMessageRunToolActivity } from "./prismaRepository";

const at = new Date("2026-11-07T10:00:00.000Z");
const DEVICE = "0b6f1c2e-6a49-4c3e-9a51-3f1f0d2b7c11";
const computer = freezeComputerBinding({ cwd: "~/work", deviceId: DEVICE }, { arch: "arm64", name: "MacBook", online: true, os: "darwin" });
const call = (toolName: string, extra: Record<string, unknown> = {}) => ({ completedAt: at, ordinal: 0, providerCallId: `p-${toolName}`,
  roundIndex: 1, startedAt: at, state: "complete", toolName, ...extra });

describe("an answer's steps on the user's computer", () => {
  it("shows each as a computer step named after the computer, with its command's first line, a path and an exit code", () => {
    const activity = summarizeMessageRunToolActivity({ errorPayload: null, normalizedRequest: { computer }, status: "complete", userId: "user",
      toolCalls: [
        call("computer_shell", { arguments: { command: "npm test\n--watch" }, result: { callId: "p", content: [{ text: "Exit code: 1", type: "text" }],
          name: "computer_shell", rawPreview: { computer: { exitCode: 1 } }, status: "complete" } }),
        call("computer_edit", { arguments: { newString: "b", oldString: "a", path: "~/work/summary.md" }, ordinal: 1 })
      ] }, "user");
    expect(activity?.calls).toEqual([
      expect.objectContaining({ exitCode: 1, origin: "computer", serverName: "MacBook", status: "complete", summary: "npm test",
        toolName: "computer_shell" }),
      expect.objectContaining({ origin: "computer", summary: "~/work/summary.md", toolName: "computer_edit" })
    ]);
    // The browser contract keeps the step's line and exit code.
    expect(decodeThreadToolActivity(JSON.parse(JSON.stringify(activity)))?.calls[0]).toMatchObject({ exitCode: 1, summary: "npm test" });
  });

  it("projects nothing of the computer for a run without one", () => {
    const activity = summarizeMessageRunToolActivity({ errorPayload: null, normalizedRequest: {}, status: "complete", userId: "user",
      toolCalls: [call("computer_shell", { arguments: { command: "ls" } })] }, "user");
    expect(activity?.calls[0]).not.toHaveProperty("summary");
    expect(activity?.calls[0]).not.toHaveProperty("serverName");
  });

  it("names a running sub-agent step's line only for a computer step", () => {
    expect(decodeSubagentCurrentStep({ origin: "computer", summary: "make build", toolName: "computer_shell" }))
      .toEqual({ origin: "computer", summary: "make build", toolName: "computer_shell" });
    expect(decodeSubagentCurrentStep({ origin: "workspace", summary: "make build", toolName: "sandbox_exec" })).toBeNull();
  });
});

describe("the chat's computer choice", () => {
  it("goes to the owner's chat wire as computer, null for none, and is absent where the record has none", () => {
    const base = { activeLeafMessageId: null, createdAt: at, defaultModelId: null, defaultProvider: null, folderId: null, id: "chat-1",
      messageCount: 0, pinned: false, title: "Chat", updatedAt: at };
    expect(serializeChatSummary({ ...base, computer: { cwd: "~/work", deviceId: DEVICE } }).computer).toEqual({ cwd: "~/work", deviceId: DEVICE });
    expect(serializeChatSummary({ ...base, computer: null }).computer).toBeNull();
    expect(serializeChatSummary(base)).not.toHaveProperty("computer");
  });
});
