import { describe, expect, it } from "vitest";
import { createDiscordUploads, type DiscordUploadServices } from "./uploads";

function services(): DiscordUploadServices & { scopes: Array<string | null> } {
  const scopes: Array<string | null> = [];
  return {
    scopes,
    async attachmentStatus() {
      return "ready";
    },
    async upload({ request }) {
      const scope = (await request.formData()).get("scope");
      scopes.push(typeof scope === "string" ? scope : null);
      return Response.json({ attachment: { fileName: "numbers.dat", id: "att_1", kind: "file", status: "ready" } });
    }
  };
}

describe("a Discord upload", () => {
  it("asks for the Workspace scope only for a turn with the Workspace, and the chat upload scope otherwise", async () => {
    const fake = services();
    const uploads = createDiscordUploads({ services: async () => fake });
    const file = { data: Buffer.from("1\n2\n"), fileName: "numbers.dat", mimeType: "application/octet-stream", userId: "svc_1" };

    await expect(uploads.uploadFile({ ...file, scope: "workspace" })).resolves.toEqual({
      block: { attachmentId: "att_1", fileName: "numbers.dat", type: "file" }, ok: true
    });
    await uploads.uploadFile({ ...file, scope: "attachment" });
    await uploads.uploadFile(file);
    expect(fake.scopes).toEqual(["workspace", null, null]);
  });
});
