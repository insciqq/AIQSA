// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { AcceptedWorkspaceSecret } from "./secrets/store";
import {
  plainWorkspaceActivityText,
  workspaceActivitySecretValues,
  WorkspaceActivityText
} from "./activityText";

describe("Workspace activity text publication", () => {
  it("strips terminal control strings without damaging Unicode or line breaks", () => {
    expect(plainWorkspaceActivityText("\x1b[31mОшибка🙂\x1b[0m\n\x1b]52;c;clipboard\x07ok\x1bPprivate\x1b\\\tend\x00"))
      .toBe("Ошибка🙂\nok\tend");
    expect(plainWorkspaceActivityText("\x9b31m中文\x9b0m\x9dtitle\x9c"))
      .toBe("中文");
  });

  it("normalizes before masking, and matches literal values including punctuation", () => {
    const text = new WorkspaceActivityText(["private-token", "a.*(b)$[]"]);
    expect(text.text("/workspace/private-\x1b[32mtoken/a.*(b)$[]/résultat"))
      .toBe("/workspace/•••/•••/résultat");
    expect(text.text("aZb is ordinary text")).toBe("aZb is ordinary text");
  });

  it("prefers a complete longer value at the same offset", () => {
    const text = new WorkspaceActivityText(["secret-1", "secret-1-long"]);
    expect(text.text("secret-1-long secret-1")).toBe("••• •••");
  });

  it("does not label short ordinary strings as secrets", () => {
    const text = new WorkspaceActivityText(["", "a", "1234567", "12345678"]);
    expect(text.text("a 1234567 12345678")).toBe("a 1234567 •••");
  });

  it.each(Array.from({ length: 12 }, (_, index) => index + 1))(
    "never releases the prefix of a secret split at character %i", (split) => {
      const secret = "private-token";
      const stream = new WorkspaceActivityText([secret]).stream();
      const first = stream.push("before " + secret.slice(0, split));
      expect(first).not.toContain(secret.slice(0, split));
      const second = stream.push(secret.slice(split) + " after");
      const last = stream.push("", true);
      expect(first + second + last).toBe("before ••• after");
    }
  );

  it("holds the longest value's tail even when another shorter secret already matched", () => {
    const stream = new WorkspaceActivityText(["short-key", "long-private-token-value"]).stream();
    const first = stream.push("short-key, long-private-");
    const second = stream.push("token-value.", true);
    expect(first + second).toBe("•••, •••.");
  });

  it("retains split ANSI state and never publishes OSC contents or partial CSI", () => {
    const stream = new WorkspaceActivityText(["private-token"]).stream();
    const chunks = ["hello \x1b[3", "1mprivate-", "token\x1b[0m\x1b]52;c;", "clipboard\x1b", "\\ world"];
    const outputs = chunks.map((chunk) => stream.push(chunk));
    outputs.push(stream.push("", true));
    expect(outputs.join("")).toBe("hello ••• world");
    expect(outputs.join("")).not.toContain("clipboard");
  });

  it("drops an unfinished escape on terminal flush", () => {
    const stream = new WorkspaceActivityText().stream();
    expect(stream.push("ok\x1b]52;c;unfinished", true)).toBe("ok");
    expect(() => stream.push("later")).toThrow("workspace_activity_stream_closed");
  });

  it("redacts long values before an output consumer can discard their leading bytes", () => {
    const secret = "s".repeat(130_000) + "-tail";
    const stream = new WorkspaceActivityText([secret]).stream();
    const first = stream.push(secret.slice(0, 65_536));
    const second = stream.push(secret.slice(65_536), true);
    expect(first).toBe("");
    expect(second).toBe("•••");
  });

  it("does not split Unicode at the withheld boundary", () => {
    const stream = new WorkspaceActivityText(["abcdefgh"]).stream();
    const first = stream.push("🙂123456");
    expect(first).toBe("");
    expect(first + stream.push("终", true)).toBe("🙂123456终");
  });

  it("collects accepted values without treating names and descriptions as credentials", () => {
    const fixture = (value: AcceptedWorkspaceSecret["value"]): AcceptedWorkspaceSecret => ({
      id: "fixture", versionId: "revision", name: "public name", description: "public description", value
    });
    const browser = JSON.stringify({ cookies: [{ value: "cookie-value" }], origins: [{ localStorage: [{ value: "storage-value" }] }] });
    const values = workspaceActivitySecretValues([
      fixture({ kind: "env", entries: [{ name: "TOKEN", value: "env-value" }] }),
      fixture({ kind: "text", text: "text-value" }),
      fixture({ kind: "ssh_key", privateKey: "key-value", passphrase: "pass-value" }),
      fixture({ kind: "file", originalName: "private.txt", base64: Buffer.from("file-value").toString("base64") }),
      fixture({ kind: "file", originalName: "private.bin", base64: Buffer.from([0xff, 0xfe]).toString("base64") }),
      fixture({ kind: "browser_session", originalName: "example.json", base64: Buffer.from(browser).toString("base64") })
    ]);
    expect(values).toEqual(["env-value", "text-value", "key-value", "pass-value", "file-value", browser, "cookie-value", "storage-value"]);
  });
});
