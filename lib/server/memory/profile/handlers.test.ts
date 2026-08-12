import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedSession } from "../../auth/requestAuth";
import {
  createGetMemoryProfileHandler,
  type MemoryProfileHandlerDependencies
} from "./handlers";
import { MemoryProfileServiceError, type MemoryProfileService } from "./service";

const response = {
  memoryRevision: 8,
  profile: null,
  state: "PENDING" as const
};

function session(): AuthenticatedSession {
  return {
    expiresAt: new Date("2026-08-11T13:00:00.000Z"),
    id: "session-1",
    user: {
      displayName: "Owner",
      email: "owner@example.test",
      id: "user-1",
      role: "user",
      status: "active"
    },
    userId: "user-1"
  };
}

function service(overrides: Partial<MemoryProfileService> = {}): MemoryProfileService {
  return { get: vi.fn(async () => response), ...overrides };
}

function deps(
  profileService = service(),
  authenticated: AuthenticatedSession | null = session()
): MemoryProfileHandlerDependencies {
  return {
    resolveAuth: vi.fn(async () => authenticated),
    service: profileService
  };
}

function expectPrivate(value: Response): void {
  expect(value.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  expect(value.headers.get("vary")).toBe("Cookie");
}

describe("Memory profile handler", () => {
  it("authenticates before reads and returns only private uncached state", async () => {
    const profileService = service();
    const unauthorized = await createGetMemoryProfileHandler(deps(profileService, null))(
      new Request("http://localhost/api/me/memory/profile")
    );
    expect(unauthorized.status).toBe(401);
    expectPrivate(unauthorized);
    expect(profileService.get).not.toHaveBeenCalled();

    const success = await createGetMemoryProfileHandler(deps(profileService))(
      new Request("http://localhost/api/me/memory/profile")
    );
    expect(success.status).toBe(200);
    expectPrivate(success);
    expect(profileService.get).toHaveBeenCalledWith("user-1");
    await expect(success.json()).resolves.toEqual(response);
  });

  it("rejects query controls and maps failures without private details", async () => {
    const profileService = service();
    const invalid = await createGetMemoryProfileHandler(deps(profileService))(
      new Request("http://localhost/api/me/memory/profile?scope=foreign")
    );
    expect(invalid.status).toBe(400);
    expectPrivate(invalid);
    expect(profileService.get).not.toHaveBeenCalled();
    await expect(invalid.json()).resolves.toEqual({ error: "memory_contract_invalid" });

    const expected = await createGetMemoryProfileHandler(deps(service({
      get: vi.fn(async () => {
        throw new MemoryProfileServiceError("memory_action_failed");
      })
    })))(new Request("http://localhost/api/me/memory/profile"));
    expect(expected.status).toBe(500);
    expectPrivate(expected);
    await expect(expected.json()).resolves.toEqual({ error: "memory_action_failed" });

    const unexpected = await createGetMemoryProfileHandler(deps(service({
      get: vi.fn(async () => {
        throw new Error("private database details");
      })
    })))(new Request("http://localhost/api/me/memory/profile"));
    expect(unexpected.status).toBe(500);
    expectPrivate(unexpected);
    await expect(unexpected.json()).resolves.toEqual({ error: "memory_action_failed" });
  });
});
