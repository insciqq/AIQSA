// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  COMPUTER_TURN_GUIDANCE_PREFIX,
  computerTurnGuidance,
  computerUnavailableNote,
  decodeFrozenComputerBinding,
  freezeComputerBinding
} from "./computerBinding";

const DEVICE = "0b6f1c2e-6a49-4c3e-9a51-3f1f0d2b7c11";
const choice = { cwd: "C:\\Users\\ivan\\Documents\\Reports", deviceId: DEVICE };
const online = { arch: "amd64", info: { home: "C:\\Users\\ivan", osVersion: "Windows 11 Pro 23H2",
  shell: { kind: "powershell", name: "Windows PowerShell", version: "5.1" } }, name: "DESKTOP-7Q2", online: true, os: "windows" } as const;

describe("a run's computer binding", () => {
  it("freezes the choice with what the connected device reported, and decodes back what it froze", () => {
    const frozen = freezeComputerBinding(choice, online);
    expect(frozen).toEqual({ arch: "amd64", cwd: choice.cwd, deviceId: DEVICE, home: "C:\\Users\\ivan", name: "DESKTOP-7Q2", online: true,
      os: "windows", osVersion: "Windows 11 Pro 23H2", shell: { kind: "powershell", name: "Windows PowerShell", version: "5.1" } });
    expect(decodeFrozenComputerBinding(JSON.parse(JSON.stringify(frozen)))).toEqual(frozen);
  });

  it("keeps an offline computer's last known name and OS only, and drops a report the contract refuses", () => {
    expect(freezeComputerBinding(choice, { ...online, online: false })).toEqual({ arch: "amd64", cwd: choice.cwd, deviceId: DEVICE,
      name: "DESKTOP-7Q2", online: false, os: "windows" });
    expect(freezeComputerBinding(choice, { ...online, info: { ...online.info, home: "relative\\home" } })).not.toHaveProperty("home");
    expect(freezeComputerBinding({ cwd: "bad\nfolder", deviceId: DEVICE }, online)).toBeNull();
  });

  it("offers no computer for a malformed record", () => {
    expect(decodeFrozenComputerBinding(undefined)).toBeNull();
    expect(decodeFrozenComputerBinding({ ...freezeComputerBinding(choice, online), os: "plan9" })).toBeNull();
    expect(decodeFrozenComputerBinding({ ...freezeComputerBinding(choice, online), extra: true })).toBeNull();
    expect(decodeFrozenComputerBinding({ ...freezeComputerBinding(choice, online), deviceId: "device-1" })).toBeNull();
  });

  it("tells the model about the computer in one turn line that starts with the prefix sub-agents keep", () => {
    const line = computerTurnGuidance(freezeComputerBinding(choice, online)!);
    expect(line).toBe("The user's computer \"DESKTOP-7Q2\" is connected for this chat (Windows 11 Pro 23H2, x64; shell: Windows " +
      "PowerShell 5.1). Working folder: C:\\Users\\ivan\\Documents\\Reports. Home: C:\\Users\\ivan. Use the computer_* tools for the user's " +
      "files and commands there; the Workspace is a separate cloud sandbox and cannot see these files. Before you work on a project " +
      "there, read its instructions for agents (AGENTS.md or CLAUDE.md in the project's root and in the folder you work in) when this " +
      "conversation has not read them yet, and follow them; after changing a project, run its own checks (tests, linters, build) when " +
      "it has them.");
    const offline = computerTurnGuidance(freezeComputerBinding(choice, { ...online, online: false })!);
    expect(offline).toContain("was offline when this message was sent (Windows, x64)");
    expect(offline).toContain("never use the Workspace in its place");
    for (const text of [line, offline]) {
      expect(text.startsWith(COMPUTER_TURN_GUIDANCE_PREFIX)).toBe(true);
      expect(text).not.toContain("\n");
    }
  });

  it("says where a chat's chosen computer is not available", () => {
    expect(computerUnavailableNote("telegram")).toContain("Computer access is not available from Telegram");
    expect(computerUnavailableNote("scheduled")).toContain("not available in automations");
    expect(computerUnavailableNote("wake_up")).toContain("sub-agent reports started");
    expect(computerUnavailableNote("telegram").startsWith(COMPUTER_TURN_GUIDANCE_PREFIX)).toBe(false);
  });
});
