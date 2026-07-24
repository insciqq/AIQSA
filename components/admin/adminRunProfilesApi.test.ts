import { describe, expect, it, vi } from "vitest";
import {
  getAdminRunProfiles,
  updateAdminRunProfiles
} from "./adminRunProfilesApi";

const model = {
  connectionEnabled: true,
  defaultReasoningEffort: "medium",
  defaultReasoningMode: "standard",
  displayName: "GPT-5.6 Sol",
  id: "deployment-sol",
  modelEnabled: true,
  providerDisplayName: "OpenAI",
  reasoningEfforts: ["none", "medium", "max"],
  reasoningModes: ["standard", "pro"],
  selectable: true
};

const profiles = [
  { description: "Fast questions", enabled: true, id: "fast", label: "Fast", providerModelId: "deployment-sol", reasoningEffort: "medium", reasoningMode: "standard", updatedAt: "2026-07-24T00:00:00.000Z", version: 2 },
  { description: "Everyday questions", enabled: true, id: "balanced", label: "Balanced", providerModelId: "deployment-sol", reasoningEffort: "medium", reasoningMode: "standard", updatedAt: "2026-07-24T00:00:00.000Z", version: 3 },
  { description: "Deep questions", enabled: true, id: "deep", label: "Deep", providerModelId: "deployment-sol", reasoningEffort: "max", reasoningMode: "pro", updatedAt: "2026-07-24T00:00:00.000Z", version: 4 }
];

describe("admin run profile browser API", () => {
  it("decodes an exact three-slot catalog and projects away unexpected fields", async () => {
    const fetcher = vi.fn(async () => Response.json({
      models: [{ ...model, secretEnvelope: "must-not-reach-browser-state" }],
      profiles: profiles.map((profile) => ({ ...profile, internalNote: "private" }))
    }));

    const result = await getAdminRunProfiles(fetcher);

    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(result)).not.toContain("secretEnvelope");
    expect(JSON.stringify(result)).not.toContain("internalNote");
    expect(fetcher).toHaveBeenCalledWith("/api/admin/run-profiles", {
      credentials: "same-origin",
      method: "GET"
    });
  });

  it.each([
    {
      label: "duplicate profile ids",
      value: { models: [model], profiles: [profiles[0], profiles[0], profiles[2]] }
    },
    {
      label: "enabled profile without a target",
      value: { models: [model], profiles: profiles.map((profile, index) => index === 0 ? { ...profile, providerModelId: null } : profile) }
    },
    {
      label: "invalid model options",
      value: { models: [{ ...model, reasoningModes: ["standard", 7] }], profiles }
    }
  ])("fails closed for $label", async ({ value }) => {
    const result = await getAdminRunProfiles(async () => Response.json(value));
    expect(result).toEqual({ error: "run_profile_admin_response_invalid", ok: false });
  });

  it("sends all writes in one same-origin JSON request", async () => {
    const fetcher = vi.fn(async () => Response.json({ models: [model], profiles }));
    const writes = profiles.map((profile) => ({
      description: profile.description,
      enabled: profile.enabled,
      expectedVersion: profile.version,
      id: profile.id,
      providerModelId: profile.providerModelId,
      reasoningEffort: profile.reasoningEffort,
      reasoningMode: profile.reasoningMode
    }));

    await expect(updateAdminRunProfiles(writes, fetcher)).resolves.toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledWith("/api/admin/run-profiles", {
      body: JSON.stringify({ profiles: writes }),
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      method: "PUT"
    });
  });
});
