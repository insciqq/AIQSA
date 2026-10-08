import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxyWithEnv } from "../../../../proxy";

const env = { AIQSA_APP_BASE_URL: "https://aiqsa.example" };

describe("SCIM proxy boundary", () => {
  it.each(["GET", "POST", "PUT", "PATCH", "DELETE"])(
    "passes %s /scim/v2 to the bearer check without a session or a browser origin check",
    (method) => {
      const response = proxyWithEnv(new NextRequest("https://aiqsa.example/scim/v2/Users", {
        headers: { origin: "https://idp.example.test" },
        method
      }), env);

      expect(response.headers.get("x-middleware-next")).toBe("1");
      expect(response.headers.get("location")).toBeNull();
    }
  );

  it.each(["/scim", "/scim/v1/Users", "/scim/v2-private"])("keeps %s behind sign-in", (path) => {
    const response = proxyWithEnv(new NextRequest(`https://aiqsa.example${path}`), env);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/login");
  });
});
