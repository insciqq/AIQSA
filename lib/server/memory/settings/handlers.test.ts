import { describe, expect, it, vi } from "vitest";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  type MemorySettingsResponse
} from "../../../contracts/memory";
import type { AuthenticatedSession } from "../../auth/requestAuth";
import {
  createGetMemorySettingsHandler,
  createPatchMemorySettingsHandler,
  type MemorySettingsHandlerDeps
} from "./handlers";
import {
  MemorySettingsServiceError,
  type MemorySettingsService
} from "./service";

const response: MemorySettingsResponse = {
  capabilities: {
  automaticLearning: false,
  explicitMemory: false,
  historyRecall: false,
  permanentChatDeletion: false,
  temporaryChats: false
  },
  egress: {
    acceptedAt: null,
    acceptedUtilityEgressFingerprint: null,
    acceptedUtilityPolicyVersion: null,
    consentMode: "PER_USER",
    currentUtilityEgressFingerprint: "a".repeat(64),
    currentUtilityPolicyVersion: "memory-utility-egress-v1",
    embeddingDestination: null,
    remoteRerankerDestination: null,
    reviewRequired: true,
    systemModelDestination: null
  },
  historyIndexing: {
    completedChats: 0,
    state: "DISABLED",
    totalChats: 0
  },
  settings: {
    embeddingDeployment: null,
    learnAutomatically: false,
    memoryConsentRevision: 0,
    memoryGeneration: 0,
    memoryRevision: 0,
    referenceChatHistory: false,
    sensitiveAutomaticPolicy: "EXPLICIT_ONLY",
    settingsRevision: 0,
    updatedAt: "2026-08-10T12:00:00.000Z",
    useMemoryFacts: false
  }
};

function session(): AuthenticatedSession {
  return {
    expiresAt: new Date("2026-08-10T13:00:00.000Z"),
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

function service(overrides: Partial<MemorySettingsService> = {}): MemorySettingsService {
  return {
    acceptUtilityEgress: vi.fn(async () => response),
    get: vi.fn(async () => response),
    patch: vi.fn(async () => response),
    ...overrides
  };
}

function deps(
  settingsService = service(),
  authenticated: AuthenticatedSession | null = session()
): MemorySettingsHandlerDeps {
  return {
    resolveAuth: vi.fn(async () => authenticated),
    service: settingsService
  };
}

function patchRequest(body: unknown, contentType = "application/json"): Request {
  return new Request("http://localhost/api/me/memory/settings", {
    body: JSON.stringify(body),
    headers: { "content-type": contentType },
    method: "PATCH"
  });
}

function expectPrivate(responseValue: Response): void {
  expect(responseValue.headers.get("cache-control")).toBe(
    "private, no-store, max-age=0"
  );
  expect(responseValue.headers.get("vary")).toBe("Cookie");
}

describe("Memory settings handlers", () => {
  it("authenticates before reads and makes every outcome private and uncached", async () => {
    const settingsService = service();
    const unauthorized = await createGetMemorySettingsHandler(
      deps(settingsService, null)
    )(new Request("http://localhost/api/me/memory/settings"));
    expect(unauthorized.status).toBe(401);
    expectPrivate(unauthorized);
    expect(settingsService.get).not.toHaveBeenCalled();

    const success = await createGetMemorySettingsHandler(deps(settingsService))(
      new Request("http://localhost/api/me/memory/settings")
    );
    expect(success.status).toBe(200);
    expectPrivate(success);
    await expect(success.json()).resolves.toEqual(response);
  });

  it("dispatches exactly one strict settings or consent mutation shape", async () => {
    const settingsService = service();
    const handler = createPatchMemorySettingsHandler(deps(settingsService));
    const patched = await handler(patchRequest({
      expectedMemoryRevision: 0,
      expectedSettingsRevision: 0,
      useMemoryFacts: true
    }));
    expect(patched.status).toBe(200);
    expect(settingsService.patch).toHaveBeenCalledWith("user-1", {
      expectedMemoryRevision: 0,
      expectedSettingsRevision: 0,
      useMemoryFacts: true
    });

    const consent = {
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      currentUtilityEgressFingerprint: "a".repeat(64),
      currentUtilityPolicyVersion: "memory-utility-egress-v1",
      expectedMemoryConsentRevision: 0,
      expectedMemoryRevision: 0,
      expectedSettingsRevision: 0
    } as const;
    const accepted = await handler(patchRequest(consent));
    expect(accepted.status).toBe(200);
    expect(settingsService.acceptUtilityEgress).toHaveBeenCalledWith("user-1", consent);

    const invalid = await handler(patchRequest({
      expectedSettingsRevision: 0,
      userId: "other-user"
    }));
    expect(invalid.status).toBe(400);
    expectPrivate(invalid);
    await expect(invalid.json()).resolves.toEqual({
      error: "memory_contract_invalid"
    });
  });

  it("rejects non-JSON input and maps only privacy-neutral stable failures", async () => {
    const wrongContentType = await createPatchMemorySettingsHandler(deps())(
      patchRequest({ expectedSettingsRevision: 0 }, "text/plain")
    );
    expect(wrongContentType.status).toBe(400);
    expectPrivate(wrongContentType);

    const conflict = await createPatchMemorySettingsHandler(deps(service({
      patch: vi.fn(async () => {
        throw new MemorySettingsServiceError("memory_version_stale");
      })
    })))(patchRequest({
      expectedMemoryRevision: 0,
      expectedSettingsRevision: 0,
      useMemoryFacts: true
    }));
    expect(conflict.status).toBe(409);
    expectPrivate(conflict);
    await expect(conflict.json()).resolves.toEqual({ error: "memory_version_stale" });

    const adminOwned = await createPatchMemorySettingsHandler(deps(service({
      acceptUtilityEgress: vi.fn(async () => {
        throw new MemorySettingsServiceError("memory_egress_admin_owned");
      })
    })))(patchRequest({
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      currentUtilityEgressFingerprint: "a".repeat(64),
      currentUtilityPolicyVersion: "memory-utility-egress-v1",
      expectedMemoryConsentRevision: 0,
      expectedMemoryRevision: 0,
      expectedSettingsRevision: 0
    }));
    expect(adminOwned.status).toBe(403);
    expectPrivate(adminOwned);
    await expect(adminOwned.json()).resolves.toEqual({ error: "memory_egress_admin_owned" });

    const failed = await createGetMemorySettingsHandler(deps(service({
      get: vi.fn(async () => {
        throw new Error("private provider or database details");
      })
    })))(new Request("http://localhost/api/me/memory/settings"));
    expect(failed.status).toBe(500);
    expectPrivate(failed);
    await expect(failed.json()).resolves.toEqual({ error: "memory_action_failed" });
  });
});
