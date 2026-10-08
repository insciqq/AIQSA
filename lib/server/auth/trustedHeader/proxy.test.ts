import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxyWithEnv } from "../../../../proxy";

const env = { AIQSA_APP_BASE_URL: "https://aiqsa.example" };

describe("trusted-header proxy boundary", () => {
  it("lets a visitor without a session reach the sign-in route", () => {
    const response = proxyWithEnv(new NextRequest("https://aiqsa.example/api/auth/trusted-header?next=%2Fadmin"), env);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("keeps the admin probe behind a session", () => {
    const response = proxyWithEnv(new NextRequest("https://aiqsa.example/api/admin/sign-in/trusted-header"), env);
    expect(response.status).toBe(401);
  });
});
