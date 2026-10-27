import type { WorkspaceSecretRevealedValue, WorkspaceSecretValue } from "@/lib/contracts/workspaceSecrets";
import { WorkspaceSecretError } from "./validation";

function utf8Text(bytes: Buffer): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  }
}

/**
 * What the owner sees of a saved value in Studio › Secrets (operator decision
 * 2026-10-27): a file as UTF-8 text when it decodes, otherwise only its size.
 * A browser session's cookies are never shown.
 */
export function revealedWorkspaceSecretValue(value: WorkspaceSecretValue): WorkspaceSecretRevealedValue {
  switch (value.kind) {
    case "text": return { kind: "text", text: value.text };
    case "env": return { kind: "env", entries: value.entries.map((entry) => ({ name: entry.name, value: entry.value })) };
    case "ssh_key": return { kind: "ssh_key", privateKey: value.privateKey, passphrase: value.passphrase || null };
    case "file": {
      const bytes = Buffer.from(value.base64, "base64");
      return { kind: "file", originalName: value.originalName, byteSize: bytes.byteLength, text: utf8Text(bytes) };
    }
    case "browser_session": throw new WorkspaceSecretError("workspace_secret_not_revealable");
  }
}
