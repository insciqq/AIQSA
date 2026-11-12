import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { AdminMcpServer, McpDraftConfiguration } from "@/lib/contracts/mcp";
import { AdminMcpDraftEditor } from "./AdminMcpDraftEditor";
import { defaultMcpDraft, requestMcpClientSecret, type AdminMcpServerForm } from "./adminMcpDraft";

function harness(input: Readonly<{
  draft?: McpDraftConfiguration;
  stored?: AdminMcpServer["clientCredentials"];
}> = {}) {
  const seen: { form?: AdminMcpServerForm } = {};
  function Harness() {
    const [form, setForm] = useState<AdminMcpServerForm>({
      description: "",
      draft: input.draft ?? { ...defaultMcpDraft(), source: { kind: "remote", url: "https://mcp.example.com/mcp" } },
      name: "Gateway",
      sharedValues: {}
    });
    seen.form = form;
    return (
      <AdminMcpDraftEditor
        clientSecretDraft={form.clientSecret ?? ""}
        disabled={false}
        draft={form.draft}
        onChange={(draft) => setForm({ ...form, draft })}
        onClientSecretChange={(value) => setForm({ ...form, clientSecret: value || undefined })}
        onSharedValueChange={() => undefined}
        sharedValueDraft={form.sharedValues}
        storedClientCredentials={input.stored}
      />
    );
  }
  render(<Harness />);
  return seen;
}

describe("MCP draft editor client credentials", () => {
  it("offers OAuth client credentials with its fields, the shared-identity note and a write-only secret", () => {
    const seen = harness();
    fireEvent.change(screen.getByRole("combobox", { name: "Mode" }), { target: { value: "client_credentials" } });

    expect(screen.getByText("Every user with access to this server acts as this client.")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: /Token endpoint URL/u }), {
      target: { value: "https://auth.example.com/oauth/token" }
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Client ID" }), { target: { value: "agent" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Scopes" }), { target: { value: "agent\nread" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Client authentication" }), {
      target: { value: "client_secret_post" }
    });
    const secret = screen.getByRole("textbox", { name: /Client secret/u });
    expect(secret).toHaveValue("");
    expect(secret).toHaveAttribute("placeholder", "Enter the client secret");
    expect(secret).toHaveAttribute("autocomplete", "off");
    fireEvent.change(secret, { target: { value: "  pasted-secret \n" } });

    expect(seen.form?.draft.auth).toEqual({
      authMethod: "client_secret_post",
      clientId: "agent",
      mode: "client_credentials",
      scopes: ["agent", "read"],
      tokenEndpoint: "https://auth.example.com/oauth/token"
    });
    expect(seen.form && requestMcpClientSecret(seen.form)).toBe("pasted-secret");

    // Another mode never sends the typed secret.
    fireEvent.change(screen.getByRole("combobox", { name: "Mode" }), { target: { value: "none" } });
    expect(seen.form?.draft.auth).toEqual({ mode: "none" });
    expect(seen.form && requestMcpClientSecret(seen.form)).toBeUndefined();
  });

  it("shows a stored secret only as configured and keeps the resource optional", () => {
    const seen = harness({
      draft: {
        ...defaultMcpDraft(),
        auth: {
          authMethod: "client_secret_basic", clientId: "agent", mode: "client_credentials",
          resource: "https://mcp.example.com/", scopes: [], tokenEndpoint: "https://auth.example.com/token"
        },
        source: { kind: "remote", url: "https://mcp.example.com/mcp" }
      },
      stored: { secretConfigured: true }
    });

    const secret = screen.getByRole("textbox", { name: /Client secret/u });
    expect(secret).toHaveValue("");
    expect(secret).toHaveAttribute("placeholder", "Configured — leave blank to keep");
    expect(seen.form && requestMcpClientSecret(seen.form)).toBeUndefined();
    fireEvent.change(screen.getByRole("textbox", { name: /Resource/u }), { target: { value: "" } });
    expect(seen.form?.draft.auth).not.toHaveProperty("resource");
  });
});
