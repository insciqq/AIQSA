import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminPage from "./page";

const adminPageMocks = vi.hoisted(() => ({
  adminPanel: vi.fn(),
  authSessionStore: {},
  cookieGet: vi.fn(),
  cookies: vi.fn(),
  fetch: vi.fn(),
  findUnique: vi.fn(),
  getAuthConfig: vi.fn(),
  redirect: vi.fn(),
  resolveAuthToken: vi.fn()
}));

vi.mock("@/components/admin/AdminPanel", () => ({
  AdminPanel: adminPageMocks.adminPanel
}));

vi.mock("@/lib/server/auth/config", () => ({
  getAuthConfig: adminPageMocks.getAuthConfig
}));

vi.mock("@/lib/server/auth/defaultAuth", () => ({
  authSessionStore: adminPageMocks.authSessionStore
}));

vi.mock("@/lib/server/auth/requestAuth", () => ({
  resolveAuthToken: adminPageMocks.resolveAuthToken
}));

vi.mock("@/lib/server/auth/session", () => ({
  SESSION_COOKIE_NAME: "aiqsa-session"
}));

vi.mock("@/lib/server/prisma", () => ({
  prisma: {
    user: {
      findUnique: adminPageMocks.findUnique
    }
  }
}));

vi.mock("next/headers", () => ({
  cookies: adminPageMocks.cookies
}));

vi.mock("next/navigation", () => ({
  redirect: adminPageMocks.redirect
}));

const redirectSignal = new Error("NEXT_REDIRECT");

describe("AdminPage", () => {
  beforeEach(() => {
    adminPageMocks.adminPanel.mockReset();
    adminPageMocks.cookieGet.mockReset();
    adminPageMocks.cookies.mockReset();
    adminPageMocks.fetch.mockReset();
    adminPageMocks.findUnique.mockReset();
    adminPageMocks.getAuthConfig.mockReset();
    adminPageMocks.redirect.mockReset();
    adminPageMocks.resolveAuthToken.mockReset();

    adminPageMocks.adminPanel.mockImplementation(() => null);
    adminPageMocks.cookieGet.mockReturnValue({ value: "opaque-session-cookie" });
    adminPageMocks.cookies.mockResolvedValue({ get: adminPageMocks.cookieGet });
    adminPageMocks.getAuthConfig.mockReturnValue({ configured: true });
    adminPageMocks.redirect.mockImplementation(() => {
      throw redirectSignal;
    });
    adminPageMocks.resolveAuthToken.mockResolvedValue({ userId: "user-1" });
    vi.stubGlobal("fetch", adminPageMocks.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("redirects before reading cookies when auth is not configured", async () => {
    adminPageMocks.getAuthConfig.mockReturnValue({ configured: false });

    await expect(AdminPage()).rejects.toBe(redirectSignal);

    expect(adminPageMocks.redirect).toHaveBeenCalledWith("/login?next=/admin");
    expect(adminPageMocks.cookies).not.toHaveBeenCalled();
    expect(adminPageMocks.resolveAuthToken).not.toHaveBeenCalled();
    expect(adminPageMocks.findUnique).not.toHaveBeenCalled();
    expect(adminPageMocks.adminPanel).not.toHaveBeenCalled();
  });

  it("redirects a request without an authenticated session", async () => {
    adminPageMocks.cookieGet.mockReturnValue(undefined);
    adminPageMocks.resolveAuthToken.mockResolvedValue(null);

    await expect(AdminPage()).rejects.toBe(redirectSignal);

    expect(adminPageMocks.cookieGet).toHaveBeenCalledWith("aiqsa-session");
    expect(adminPageMocks.resolveAuthToken).toHaveBeenCalledWith(undefined, {
      sessions: adminPageMocks.authSessionStore
    });
    expect(adminPageMocks.redirect).toHaveBeenCalledWith("/login?next=/admin");
    expect(adminPageMocks.findUnique).not.toHaveBeenCalled();
    expect(adminPageMocks.adminPanel).not.toHaveBeenCalled();
  });

  it("redirects an authenticated user whose account is inactive", async () => {
    adminPageMocks.findUnique.mockResolvedValue({
      displayName: "Disabled User",
      email: "disabled@example.com",
      role: "user",
      status: "disabled"
    });

    await expect(AdminPage()).rejects.toBe(redirectSignal);

    expect(adminPageMocks.findUnique).toHaveBeenCalledWith({
      select: {
        displayName: true,
        email: true,
        role: true,
        status: true
      },
      where: {
        id: "user-1"
      }
    });
    expect(adminPageMocks.redirect).toHaveBeenCalledWith("/login?next=/admin");
    expect(adminPageMocks.adminPanel).not.toHaveBeenCalled();
  });

  it("redirects when the authenticated session no longer has a user", async () => {
    adminPageMocks.findUnique.mockResolvedValue(null);

    await expect(AdminPage()).rejects.toBe(redirectSignal);

    expect(adminPageMocks.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "user-1"
        }
      })
    );
    expect(adminPageMocks.redirect).toHaveBeenCalledWith("/login?next=/admin");
    expect(adminPageMocks.adminPanel).not.toHaveBeenCalled();
  });

  it("renders denial for a non-admin without mounting the admin client", async () => {
    adminPageMocks.findUnique.mockResolvedValue({
      displayName: "Active User",
      email: "user@example.com",
      role: "user",
      status: "active"
    });

    render(await AdminPage());

    expect(screen.getByRole("main")).toHaveClass("flex", "items-center", "justify-center");
    expect(screen.getByTestId("admin-denied")).toBeVisible();
    expect(screen.getByTestId("admin-denied")).toHaveClass("w-full", "max-w-[720px]");
    expect(screen.getByRole("heading", { level: 1, name: "Admin access required" })).toBeVisible();
    expect(screen.getByText(/open the Control Center and manage access, providers, tools, email delivery/)).toBeVisible();
    expect(screen.queryByText(/user-management data/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Return to workspace" })).toHaveAttribute("href", "/");
    expect(adminPageMocks.redirect).not.toHaveBeenCalled();
    expect(adminPageMocks.adminPanel).not.toHaveBeenCalled();
    expect(adminPageMocks.fetch).not.toHaveBeenCalled();
  });

  it("mounts the admin client with the active admin identity", async () => {
    adminPageMocks.resolveAuthToken.mockResolvedValue({ userId: "admin-1" });
    adminPageMocks.findUnique.mockResolvedValue({
      displayName: "Admin User",
      email: "admin@example.com",
      role: "admin",
      status: "active"
    });

    render(await AdminPage());

    expect(adminPageMocks.adminPanel).toHaveBeenCalledTimes(1);
    expect(adminPageMocks.adminPanel.mock.calls[0]?.[0]).toEqual({
      adminEmail: "admin@example.com",
      adminUserId: "admin-1"
    });
    expect(adminPageMocks.fetch).not.toHaveBeenCalled();
  });
});
