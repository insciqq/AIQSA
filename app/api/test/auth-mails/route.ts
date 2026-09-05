import { isTestAuthEnabled } from "@/lib/server/auth/config";
import { createTestAuthMailHandlers } from "@/lib/server/auth/testMailHandlers";

export const runtime = "nodejs";

const handlers = createTestAuthMailHandlers({
  enabled: () => isTestAuthEnabled(),
  async load() {
    const { clearTestAuthEmails, listTestAuthEmails } = await import(
      "@/lib/server/auth/testMailer"
    );
    return {
      clear: clearTestAuthEmails,
      list: listTestAuthEmails
    };
  }
});

export const DELETE = handlers.DELETE;
export const GET = handlers.GET;
