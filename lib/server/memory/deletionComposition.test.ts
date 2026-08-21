import { describe, expect, it, vi } from "vitest";
import {
  createPermanentChatDeleteConsumerHandler,
  type PermanentChatDeletionHandlerDeps
} from "../chats/permanentDeletion/handlers";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "../../contracts/memoryClient";
import { MemoryCoordinatorRegistry } from "./coordinator/registry";
import type { MemoryDeletionHandler } from "./coordinator/types";
import { createMemoryDeletionComposition } from "./deletionComposition";

function handler(
  operation: "ACCOUNT_MEMORY_DELETE" | "SOURCE_PURGE"
): MemoryDeletionHandler {
  return Object.freeze({
    execute: vi.fn(async () => ({})),
    operation
  });
}

function composition(
  policy: Readonly<{ account: boolean; permanent: boolean }> = {
    account: true,
    permanent: true
  }
) {
  const coordinatorRegistry = new MemoryCoordinatorRegistry();
  const accountDeletionHandler = handler("ACCOUNT_MEMORY_DELETE");
  const sourcePurgeHandler = handler("SOURCE_PURGE");
  const created = createMemoryDeletionComposition({
    accountDeletionHandler,
    coordinatorRegistry,
    createAccountHook: ({ admissionEnabled, kick }) => ({
      advance: vi.fn(async () => ({
        admitted: admissionEnabled(),
        deletionPending: admissionEnabled(),
        readyForUserDeletion: false
      })),
      kick
    }),
    kick: vi.fn(),
    policy: {
      accountMemoryDeletion: {
        get enabled() { return policy.account; }
      },
      permanentChatDeletion: {
        get enabled() { return policy.permanent; }
      }
    },
    sourcePurgeHandler
  });
  return {
    accountDeletionHandler,
    coordinatorRegistry,
    created,
    sourcePurgeHandler
  };
}

describe("Memory deletion composition", () => {
  it("is feature-dark before composition and atomically exposes each owner once", () => {
    const fixture = composition();
    expect(fixture.created.status()).toEqual({
      accountAdmissionEnabled: false,
      accountHandlerReachable: false,
      accountHookReachable: false,
      composed: false,
      permanentChatAdmissionEnabled: false,
      sourcePurgeHandlerReachable: false
    });
    expect(fixture.created.permanentChatDeletionCapability.enabled).toBe(false);

    expect(fixture.created.ensure()).toMatchObject({
      accountAdmissionEnabled: true,
      composed: true,
      permanentChatAdmissionEnabled: true
    });
    expect(fixture.created.ensure()).toMatchObject({ composed: true });
    expect(fixture.coordinatorRegistry.deletionOperations()).toEqual([
      "SOURCE_PURGE",
      "ACCOUNT_MEMORY_DELETE"
    ]);
    expect(fixture.created.permanentChatDeletionCapability.enabled).toBe(true);
  });

  it("fails closed on a conflicting leaf without partially registering owners", () => {
    const fixture = composition();
    fixture.coordinatorRegistry.registerDeletion(handler("SOURCE_PURGE"));

    expect(() => fixture.created.ensure()).toThrow(
      "memory_deletion_composition_source_handler_conflict"
    );
    expect(fixture.coordinatorRegistry.deletionHandler("ACCOUNT_MEMORY_DELETE"))
      .toBeNull();
    expect(fixture.created.accountDeletionHook()).toBeNull();
    expect(fixture.created.permanentChatDeletionCapability.enabled).toBe(false);
  });

  it("allows accepted obligations to remain reachable when new admission rolls back", async () => {
    const policy = { account: true, permanent: true };
    const fixture = composition(policy);
    fixture.created.ensure();
    policy.account = false;
    policy.permanent = false;

    expect(fixture.created.status()).toMatchObject({
      accountAdmissionEnabled: false,
      accountHandlerReachable: true,
      accountHookReachable: true,
      permanentChatAdmissionEnabled: false,
      sourcePurgeHandlerReachable: true
    });
    expect(fixture.coordinatorRegistry.deletionHandler("SOURCE_PURGE"))
      .toBe(fixture.sourcePurgeHandler);
    expect(fixture.coordinatorRegistry.deletionHandler("ACCOUNT_MEMORY_DELETE"))
      .toBe(fixture.accountDeletionHandler);
    await expect(fixture.created.accountDeletionHook()!.advance({} as never, {
      now: new Date("2026-08-12T12:00:00.000Z"),
      userId: "owner-1"
    })).resolves.toEqual({
      admitted: false,
      deletionPending: false,
      readyForUserDeletion: false
    });
  });

  it("keeps the direct permanent-delete API zero-mutation until composition", async () => {
    const policy = { account: true, permanent: true };
    const fixture = composition(policy);
    const confirm = vi.fn(async () => ({ status: "IN_PROGRESS" as const }));
    const handler = createPermanentChatDeleteConsumerHandler({
      capability: fixture.created.permanentChatDeletionCapability,
      mutationRateLimiter: {
        check: vi.fn(async () => ({ allowed: true as const, retryAfterSeconds: 0 }))
      },
      resolveAuth: vi.fn(async () => ({ userId: "owner-1" })),
      service: { confirm }
    } as unknown as PermanentChatDeletionHandlerDeps);
    const request = () => new Request(
      "https://example.test/api/chats/chat-1/delete-permanently",
      {
        body: JSON.stringify({
          alsoForgetOriginMemories: false,
          confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
          requestId: "request-1"
        }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }
    );
    const context = { params: { chatId: "chat-1" } };

    expect((await handler(request(), context)).status).toBe(503);
    expect(confirm).not.toHaveBeenCalled();

    fixture.created.ensure();
    expect((await handler(request(), context)).status).toBe(202);
    expect(confirm).toHaveBeenCalledOnce();

    policy.permanent = false;
    expect((await handler(request(), context)).status).toBe(503);
    expect(confirm).toHaveBeenCalledOnce();
  });
});
