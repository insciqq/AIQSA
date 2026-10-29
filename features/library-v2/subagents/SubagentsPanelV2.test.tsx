import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentDefinitionListResponse, SubagentDefinitionView } from "@/lib/contracts/subagentDefinitions";
import { SubagentsPanelV2 } from "./SubagentsPanelV2";

const MODELS = [{ defaultEffort: "medium", displayName: "Cheap Model", efforts: ["low", "medium"], modelId: "model-cheap" },
  { defaultEffort: null, displayName: "Big Model", efforts: [], modelId: "model-big" }];
const VIEW: SubagentDefinitionView = { description: "Long browsing on a cheap model.", effort: "low", id: "def_1", instructions: "Browse.",
  modelAvailable: true, modelDisplayName: "Cheap Model", modelId: "model-cheap", name: "browser", previousRevisionId: null, revisionId: "rev_1",
  revisionNumber: 1, tools: ["workspace"], updatedAt: "2026-10-30T10:00:00.000Z", version: 1 };
const summary = ({ instructions: _i, previousRevisionId: _p, revisionId: _r, ...rest }: SubagentDefinitionView) => rest;

let list: SubagentDefinitionListResponse;
let calls: Array<[string, string, unknown]>;
let next: Record<string, () => Response>;

beforeEach(() => {
  list = { definitions: [], limit: 50, models: MODELS };
  calls = [];
  next = {};
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = String(input);
    calls.push([method, url, init?.body ? JSON.parse(String(init.body)) : null]);
    const override = next[`${method} ${url}`];
    if (override) return override();
    if (method === "GET" && url === "/api/me/subagents") return Response.json(list);
    return Response.json({ error: "subagent_not_found" }, { status: 404 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const mutations = () => calls.filter(([method]) => method !== "GET");

describe("Studio > Sub-agents", () => {
  it("shows an empty state that explains sub-agents are optional", async () => {
    render(<SubagentsPanelV2 />);
    expect(await screen.findByText(/No custom sub-agents yet/u)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Sub-agents" })).toBeVisible();
    expect(screen.getByText(/Without them, sub-agents run on the chat's model/u)).toBeVisible();
  });

  it("creates a sub-agent with a model, an effort and chosen tools, then undoes it", async () => {
    const dirty = vi.fn();
    render(<SubagentsPanelV2 onDirtyChange={dirty} />);
    fireEvent.click(await screen.findByRole("button", { name: "New sub-agent" }));
    const form = screen.getByRole("form", { name: "New sub-agent" });
    expect(screen.getByLabelText(/^Name/u)).toHaveFocus();
    fireEvent.change(screen.getByLabelText(/^Name/u), { target: { value: "Browser" } });
    fireEvent.change(screen.getByLabelText(/^Description/u), { target: { value: "Long browsing." } });
    fireEvent.change(within(form).getByRole("textbox", { name: "Instructions" }), { target: { value: "Browse and report." } });
    expect(dirty).toHaveBeenLastCalledWith(true);
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "model-cheap" } });
    const effort = screen.getByLabelText("Reasoning effort");
    expect(within(effort).getAllByRole("option").map((option) => option.textContent)).toEqual(["Model default", "low", "medium"]);
    fireEvent.change(effort, { target: { value: "low" } });
    fireEvent.click(screen.getByRole("radio", { name: "Only the tools I choose" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Web search" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Workspace and browser" }));
    next["POST /api/me/subagents"] = () => { list = { ...list, definitions: [summary(VIEW)] }; return Response.json({ definition: VIEW }, { status: 201 }); };
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Created “browser”/u)).toBeVisible();
    expect(mutations()).toEqual([["POST", "/api/me/subagents", { description: "Long browsing.", effort: "low", instructions: "Browse and report.",
      modelId: "model-cheap", name: "browser", tools: ["workspace", "web_search"] }]]);
    expect(screen.getByText("Cheap Model · low effort · Workspace and browser")).toBeVisible();
    next["DELETE /api/me/subagents/def_1"] = () => { list = { ...list, definitions: [] }; return new Response(null, { status: 204 }); };
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText(/Undone: “browser” is deleted/u)).toBeVisible();
    expect(mutations().at(-1)).toEqual(["DELETE", "/api/me/subagents/def_1", { expectedVersion: 1 }]);
  });

  it("edits under the version it read and undoes the edit by restoring the previous revision", async () => {
    list = { ...list, definitions: [summary(VIEW)] };
    next["GET /api/me/subagents/def_1"] = () => Response.json({ definition: VIEW });
    render(<SubagentsPanelV2 />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit browser" }));
    await screen.findByRole("form", { name: "Edit sub-agent browser" });
    fireEvent.change(screen.getByLabelText(/^Description/u), { target: { value: "Browsing and shopping." } });
    const saved = { ...VIEW, description: "Browsing and shopping.", previousRevisionId: "rev_1", revisionId: "rev_2", revisionNumber: 2, version: 2 };
    next["PATCH /api/me/subagents/def_1"] = () => Response.json({ definition: saved });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Saved “browser”/u)).toBeVisible();
    expect(mutations()[0]).toEqual(["PATCH", "/api/me/subagents/def_1", { draft: { description: "Browsing and shopping.", effort: "low",
      instructions: "Browse.", modelId: "model-cheap", name: "browser", tools: ["workspace"] }, expectedVersion: 1 }]);
    next["POST /api/me/subagents/def_1/restore"] = () => Response.json({ definition: { ...VIEW, revisionId: "rev_3", revisionNumber: 3, version: 3 } });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText(/back to its previous version/u)).toBeVisible();
    expect(mutations().at(-1)).toEqual(["POST", "/api/me/subagents/def_1/restore", { expectedVersion: 2, revisionId: "rev_1" }]);
  });

  it("shows the server's refusal and keeps the draft", async () => {
    render(<SubagentsPanelV2 />);
    fireEvent.click(await screen.findByRole("button", { name: "New sub-agent" }));
    fireEvent.change(screen.getByLabelText(/^Name/u), { target: { value: "browser" } });
    fireEvent.change(screen.getByLabelText(/^Description/u), { target: { value: "Again." } });
    fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Go." } });
    next["POST /api/me/subagents"] = () => Response.json({ error: "subagent_definition_exists" }, { status: 409 });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You already have a sub-agent with this name");
    expect(screen.getByLabelText(/^Name/u)).toHaveValue("browser");
  });

  it("marks a sub-agent whose model is gone and asks before deleting, naming the consequences", async () => {
    list = { ...list, definitions: [{ ...summary(VIEW), modelAvailable: false, modelDisplayName: null }] };
    render(<SubagentsPanelV2 />);
    expect(await screen.findByText(/Its model is no longer available to you/u)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "More actions for browser" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const question = screen.getByRole("alert");
    expect(question).toHaveTextContent(/keep their work but cannot be continued/u);
    expect(mutations()).toEqual([]);
    next["DELETE /api/me/subagents/def_1"] = () => { list = { ...list, definitions: [] }; return new Response(null, { status: 204 }); };
    fireEvent.click(within(question).getByRole("button", { name: "Delete sub-agent" }));
    expect(await screen.findByText(/Deleted “browser”/u)).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Edit browser" })).toBeNull());
    expect(mutations()).toEqual([["DELETE", "/api/me/subagents/def_1", { expectedVersion: 1 }]]);
  });
});
