import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adminKnowledgeProfileFixture, adminKnowledgeSettingsFixture } from "@/tests/support/knowledgeProfile";
import type { AdminKnowledgeProfileSettings } from "@/lib/contracts/adminKnowledge";
import { AdminKnowledgeModelAssignments } from "./AdminKnowledgeModelAssignments";

function profile(): AdminKnowledgeProfileSettings {
  return adminKnowledgeProfileFixture({ availablePdfDestinations: [
    { deploymentId: "vision", connectionDisplayName: "Documents", modelDisplayName: "Image model", provider: "openai_compatible", upstreamModelId: "image", directPdf: false, vision: true },
    { deploymentId: "pdf", connectionDisplayName: "Documents", modelDisplayName: "Native PDF model", provider: "openai_compatible", upstreamModelId: "pdf", directPdf: true, vision: false }
  ] });
}
function server(value = profile(), error?: string) {
  const writes: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      writes.push(JSON.parse(String(init.body)));
      if (error) return Response.json({ error }, { status: 409 });
    }
    return Response.json({ knowledge: adminKnowledgeSettingsFixture({ profile: value }) });
  }));
  return writes;
}
afterEach(() => vi.unstubAllGlobals());

describe("Knowledge model assignments", () => {
  it("filters document roles independently and activates the complete draft only after explicit impact confirmation", async () => {
    const writes = server();
    render(<AdminKnowledgeModelAssignments active />);
    fireEvent.change(await screen.findByLabelText("Knowledge PDF processing"), { target: { value: "system_model_vision" } });
    const documents = screen.getByRole("combobox", { name: /Knowledge document model/ });
    expect(within(documents).queryByRole("option", { name: /Native PDF/ })).not.toBeInTheDocument();
    fireEvent.change(documents, { target: { value: "vision" } });
    const activate = screen.getByRole("button", { name: "Activate Knowledge profile" });
    expect(activate).toBeDisabled();
    expect(writes).toEqual([]);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(activate);
    await waitFor(() => expect(writes).toEqual([{ action: "activate_profile", expectedVersion: 1,
      deploymentId: "embedding-model-1", documentDeploymentId: "vision", pdfProcessingMode: "system_model_vision" }]));
  });

  it("requires a new confirmation when the route changes and sends no model for Local", async () => {
    const initial = profile();
    const value: AdminKnowledgeProfileSettings = { ...initial, activeRevision: { ...initial.activeRevision!,
      pdfProcessing: { mode: "system_model_vision", parserProfileVersion: 1,
        destination: { connectionDisplayName: "Documents", deploymentId: "vision", modelDisplayName: "Image model", provider: "openai_compatible", upstreamModelId: "image" } } },
      egress: { ...initial.egress, pdfDestination: "Documents / Image model", representations: ["document_text_chunks", "search_queries", "rendered_pdf_page_images", "native_pdf_page_text"] }
    };
    const writes = server(value);
    render(<AdminKnowledgeModelAssignments active />);
    const mode = await screen.findByLabelText("Knowledge PDF processing");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(mode, { target: { value: "local" } });
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.queryByRole("combobox", { name: /Knowledge document model/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Activate Knowledge profile" }));
    await waitFor(() => expect(writes[0]).toMatchObject({ documentDeploymentId: null, pdfProcessingMode: "local" }));
  });

  it("keeps stale drafts and rejects unavailable embedding assignments", async () => {
    server(profile(), "knowledge_profile_stale");
    const { unmount } = render(<AdminKnowledgeModelAssignments active />);
    fireEvent.change(await screen.findByLabelText("Knowledge PDF processing"), { target: { value: "system_model_direct_pdf" } });
    fireEvent.change(screen.getByRole("combobox", { name: /Knowledge document model/ }), { target: { value: "pdf" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Activate Knowledge profile" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/changed|Refresh/);
    expect(screen.getByRole("combobox", { name: /Knowledge document model/ })).toHaveValue("pdf");
    unmount();
    server({ ...profile(), availableDestinations: [] });
    render(<AdminKnowledgeModelAssignments active />);
    const embedding = await screen.findByRole("combobox", { name: /Knowledge embedding model/ });
    expect(within(embedding).getByRole("option", { name: /Unavailable/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Activate Knowledge profile" })).toBeDisabled();
  });
});
