import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestAuth } from "@/tests/support/auth";
import { loadProviderAdmissionPlan } from "../providerRuntime/admission";
import { resolveProjectAccess } from "../projects/access";
import { createChatPdfPreviewHandler } from "./chatPdfPreviewHandler";

vi.mock("../providerRuntime/admission", async (original) => ({
  ...await original<typeof import("../providerRuntime/admission")>(), loadProviderAdmissionPlan: vi.fn()
}));
vi.mock("../projects/access", () => ({ resolveProjectAccess: vi.fn() }));

function fixture() {
  const tx = { systemModelPolicy: { findUnique: vi.fn(async () => ({
    version: 1, chatPdfProcessingMode: "PREFER_CHAT_MODEL", chatPdfFallbackMethod: "PAGE_IMAGES"
  })) },
    projectModelBinding: { findUnique: vi.fn(async () => null) } };
  const db = { $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)) };
  const auth = createTestAuth({ user: { id: "owner", role: "user" } });
  const resolveAuth = vi.fn(auth.resolveAuth);
  const handler = createChatPdfPreviewHandler({ prisma: db as unknown as PrismaClient, resolveAuth });
  const request = (extra = {}) => new Request("http://app.local/api/uploads/pdf-route", { method: "POST",
    headers: { cookie: auth.cookie },
    body: JSON.stringify({ providerConnectionId: "connection", providerModelId: "model", ...extra }) });
  return { db, handler, request, resolveAuth, tx };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(loadProviderAdmissionPlan).mockResolvedValue({ answer: { snapshot: {
    model: { capabilities: { nativePdfInput: true } }
  } } } as Awaited<ReturnType<typeof loadProviderAdmissionPlan>>);
});

describe("private PDF route preview", () => {
  it("returns only a current high-level route and prohibits caching", async () => {
    const h = fixture(); const response = await h.handler(h.request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ version: 1, route: "direct_pdf" });
    expect(loadProviderAdmissionPlan).toHaveBeenCalledWith(h.tx, {
      userId: "owner", providerConnectionId: "connection", providerModelId: "model",
      searchPlan: { mode: "all_selected", optionIds: [] }
    });
  });

  it("reports missing fallback configuration without selecting local extraction", async () => {
    const h = fixture();
    vi.mocked(loadProviderAdmissionPlan).mockResolvedValueOnce({ answer: { snapshot: {
      model: { capabilities: { nativePdfInput: false } }
    } } } as Awaited<ReturnType<typeof loadProviderAdmissionPlan>>);
    const response = await h.handler(h.request());
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "pdf_processing_configuration_incomplete" });
  });

  it("rejects unauthenticated and oversized identifiers before catalog access", async () => {
    const h = fixture();
    h.resolveAuth.mockResolvedValueOnce(null);
    expect((await h.handler(h.request())).status).toBe(401);
    expect((await h.handler(h.request({ providerModelId: "x".repeat(129) }))).status).toBe(400);
    expect(h.db.$transaction).not.toHaveBeenCalled();
    expect(loadProviderAdmissionPlan).not.toHaveBeenCalled();
  });

  it("requires current Project contribution and a Project model binding", async () => {
    const h = fixture();
    vi.mocked(resolveProjectAccess).mockResolvedValueOnce(null);
    const denied = await h.handler(h.request({ projectId: "project" }));
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ error: "model_not_available" });
    expect(h.tx.projectModelBinding.findUnique).not.toHaveBeenCalled();
    expect(loadProviderAdmissionPlan).not.toHaveBeenCalled();
    vi.mocked(resolveProjectAccess).mockResolvedValueOnce({ projectId: "project" } as never);
    expect((await h.handler(h.request({ projectId: "project" }))).status).toBe(404);
    expect(loadProviderAdmissionPlan).not.toHaveBeenCalled();
  });

  it("does not reveal provider failures or stale route details", async () => {
    const h = fixture();
    vi.mocked(loadProviderAdmissionPlan).mockRejectedValueOnce(new Error("private provider credential and endpoint"));
    const response = await h.handler(h.request());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "model_not_available" });
  });
});
