import { describe, expect, it } from "vitest";
import { scheduledTaskWebhookUrl } from "./webhookUrl";

describe("scheduledTaskWebhookUrl", () => {
  it("joins the installation's public origin and the webhook path", () => {
    expect(scheduledTaskWebhookUrl("AbCdEfGhIjKlMnOpQrStUv", { AIQSA_APP_BASE_URL: "https://ai.example.test" }))
      .toBe("https://ai.example.test/api/automations/hooks/AbCdEfGhIjKlMnOpQrStUv");
  });

  it("ignores a trailing slash on the origin", () => {
    expect(scheduledTaskWebhookUrl("AbCdEfGhIjKlMnOpQrStUv", { AIQSA_APP_BASE_URL: "https://ai.example.test/" }))
      .toBe("https://ai.example.test/api/automations/hooks/AbCdEfGhIjKlMnOpQrStUv");
  });
});
