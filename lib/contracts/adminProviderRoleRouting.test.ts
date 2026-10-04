import { describe, expect, it } from "vitest";
import { decodeAdminProviderModelSaveReceipt } from "./adminProviderModelSave";
import { decodeAdminProviderRoleRoutingConflicts } from "./adminProviderRoleRouting";

describe("assigned role routing contracts", () => {
  it("accepts only known, distinct roles with bounded catalog parameter names", () => {
    expect(decodeAdminProviderRoleRoutingConflicts([{ role: "memory", missingParameters: ["structured_outputs"] },
      { role: "chat_titles", missingParameters: [] }])).toEqual([{ role: "memory", missingParameters: ["structured_outputs"] },
      { role: "chat_titles", missingParameters: [] }]);
    for (const value of [[], null, [{ role: "admin", missingParameters: [] }],
      [{ role: "memory", missingParameters: [] }, { role: "memory", missingParameters: [] }],
      [{ role: "memory", missingParameters: ["<script>"] }], [{ role: "memory" }]]) {
      expect(decodeAdminProviderRoleRoutingConflicts(value)).toBeNull();
    }
  });

  it("lets only a failed check of a published configuration name its paused roles", () => {
    const receipt = { connectionId: "connection", modelId: "model", displayName: "Model", draftVersion: 2,
      saved: "configuration", publication: "active", checks: "failed" };
    expect(decodeAdminProviderModelSaveReceipt({ ...receipt, affectedRoles: ["memory", "vision"] }))
      .toMatchObject({ affectedRoles: ["memory", "vision"] });
    expect(decodeAdminProviderModelSaveReceipt({ ...receipt, checks: "checked", affectedRoles: ["memory"] })).toBeNull();
    expect(decodeAdminProviderModelSaveReceipt({ ...receipt, affectedRoles: [] })).toBeNull();
    expect(decodeAdminProviderModelSaveReceipt({ ...receipt, affectedRoles: ["memory", "memory"] })).toBeNull();
  });
});
