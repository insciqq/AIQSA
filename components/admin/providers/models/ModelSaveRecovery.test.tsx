import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAdminProvidersController } from "../../useAdminProvidersController";
import { fixtureConnection, fixtureModel } from "../providerFixtures";
import { AdminProviderModelSheet } from "./AdminProviderModelSheet";
import type { AdminOpenRouterDiscoverySession } from "./useAdminOpenRouterDiscovery";
import type { AdminProviderModelConfiguration } from "@/lib/contracts/adminProviders";

const session: AdminOpenRouterDiscoverySession = Object.fromEntries(["models", "compatibleModels", "endpoints"].map((key) => [key, {
  get: () => ({ error: null, items: [], status: "idle" }), load: async () => [], refresh: async () => [], retry: async () => []
}])) as unknown as AdminOpenRouterDiscoverySession;

function setup(mode: "name_bad_ack" | "saved_bad_refresh" | "partial" | "config_bad_ack" | "draft_failure" | "mismatched" | "pending") {
  const original = fixtureModel({ connectionId: "provider", displayName: "Original", id: "model" });
  let model = original;
  const calls: string[] = [];
  let resolvePending!: (value: Response) => void;
  const onSaved = vi.fn();
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    calls.push(method);
    if (method === "GET") {
      if (mode === "saved_bad_refresh" && calls.includes("PATCH")) throw new TypeError("synthetic network interruption");
      return Response.json({ connections: [fixtureConnection({ id: "provider", displayName: "Provider", models: [model] })] });
    }
    const body = JSON.parse(String(init!.body));
    if (mode === "pending") return new Promise((resolve) => { resolvePending = resolve; });
    model = { ...model, displayName: body.displayName, updatedAt: "2026-09-10T10:00:00.000Z",
      ...(body.configuration && mode !== "partial" ? { draftConfig: body.configuration as AdminProviderModelConfiguration,
        draftVersion: 2, ...(mode === "config_bad_ack" ? { activeConfig: body.configuration, activeVersion: 2 } : {}) } : {}) };
    if (["name_bad_ack", "partial", "config_bad_ack"].includes(mode)) return new Response("{broken", { headers: { "content-type": "application/json" } });
    const receipt = { connectionId: "provider", modelId: mode === "mismatched" ? "different-model" : "model", displayName: body.displayName,
      draftVersion: body.configuration ? 2 : 1, saved: body.configuration ? "configuration" : "name",
      publication: body.configuration ? "draft" : "not_requested", checks: "not_requested" };
    return Response.json(mode === "draft_failure" ? { error: "provider_refresh_failed", receipt } : { receipt },
      { status: mode === "draft_failure" ? 502 : 200 });
  });
  vi.stubGlobal("fetch", fetcher);
  function Harness() {
    const controller = useAdminProvidersController(true);
    const [open, setOpen] = useState(true);
    const connection = controller.state.connections[0];
    return connection && open ? <AdminProviderModelSheet connection={connection} model={connection.models[0]!}
      controller={controller} discovery={session} open onClose={() => setOpen(false)}
      onSaved={() => { onSaved(); setOpen(false); }} /> : null;
  }
  const view = render(<Harness />);
  return { calls, onSaved, view, original, finish: (response: Response) => resolvePending(response) };
}

afterEach(() => vi.unstubAllGlobals());

async function edit(configuration = false) {
  const sheet = await screen.findByRole("dialog", { name: "Edit model" });
  fireEvent.change(within(sheet).getByLabelText("Display name"), { target: { value: "Saved name" } });
  if (configuration) fireEvent.change(within(sheet).getByLabelText("Response timeout (seconds)"), { target: { value: "120" } });
  fireEvent.click(within(sheet).getByRole("button", { name: configuration ? "Test & Save" : "Save" }));
  return sheet;
}

describe("model controller and sheet recovery through the real client decoder", () => {
  it("reconciles a committed rename after malformed acknowledgement without replay", async () => {
    const f = setup("name_bad_ack");
    await edit();
    await waitFor(() => expect(f.onSaved).toHaveBeenCalledOnce());
    expect(screen.queryByTestId("provider-model-discard")).not.toBeInTheDocument();
    expect(f.calls).toEqual(["GET", "PATCH", "GET"]);
  });

  it("keeps an acknowledged rename clean when its canonical refresh fails", async () => {
    const f = setup("saved_bad_refresh");
    const sheet = await edit();
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("Display name saved.");
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("provider-model-discard")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Edit model" })).not.toBeInTheDocument();
    expect(f.calls).toEqual(["GET", "PATCH", "GET"]);
  });

  it("retains only unsaved settings after a partial write and does not adopt later background changes", async () => {
    const f = setup("partial");
    const sheet = await edit(true);
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("Some fields are saved; other changes are still unsaved.");
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    const discard = screen.getByTestId("provider-model-discard");
    fireEvent.click(within(discard).getByRole("button", { name: "Cancel" }));
    fireEvent.change(within(sheet).getByLabelText("Response timeout (seconds)"), { target: { value: "" } });
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(f.calls).toHaveLength(4));
    expect(within(sheet).getByLabelText("Display name")).toHaveValue("Saved name");
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("provider-model-discard")).not.toBeInTheDocument();
    expect(f.calls.filter((method) => method === "PATCH")).toHaveLength(1);
  });

  it.each(["config_bad_ack", "draft_failure"] as const)("cleans proven settings while reporting their actual remaining state: %s", async (mode) => {
    const f = setup(mode);
    const sheet = await edit(true);
    expect(await within(sheet).findByRole("alert")).toHaveTextContent(mode === "draft_failure"
      ? "The draft was saved, but these changes were not activated."
      : "Model settings saved.");
    expect(f.onSaved).not.toHaveBeenCalled();
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit model" })).not.toBeInTheDocument());
    expect(screen.queryByTestId("provider-model-discard")).not.toBeInTheDocument();
    expect(f.calls).toEqual(["GET", "PATCH", "GET"]);
  });

  it("does not clean a draft from a receipt for another model", async () => {
    const f = setup("mismatched");
    const sheet = await edit();
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("Save status could not be confirmed.");
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("provider-model-discard")).toBeVisible();
    expect(f.onSaved).not.toHaveBeenCalled();
  });

  it("does not call a stale sheet's success callback after unmount", async () => {
    const f = setup("pending");
    await edit();
    await waitFor(() => expect(f.calls).toContain("PATCH"));
    f.view.unmount();
    f.finish(Response.json({ receipt: { connectionId: "provider", modelId: "model", displayName: "Saved name",
      draftVersion: 1, saved: "name", publication: "not_requested", checks: "not_requested" } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.onSaved).not.toHaveBeenCalled();
    expect(f.calls).toEqual(["GET", "PATCH"]);
  });
});
