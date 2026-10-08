import { describe, expect, it, vi } from "vitest";
import { createSignInHealthRecorder } from "./health";

const at = new Date("2026-10-08T12:00:00.000Z");

describe("sign-in health recorder", () => {
  it("records admin-configured outcomes for their active version only, as content-free codes", async () => {
    const recordHealth = vi.fn(async () => true);
    const record = createSignInHealthRecorder({ now: () => at, repository: { recordHealth } });

    await record({ method: "google", source: "environment" }, "accepted");
    expect(recordHealth).not.toHaveBeenCalled();

    await record({ activeVersion: 4, method: "google", source: "admin" }, "exchange_failed");
    expect(recordHealth).toHaveBeenLastCalledWith({ activeVersion: 4, at, code: "exchange_failed", method: "google" });

    await record({ activeVersion: 4, method: "google", source: "admin" }, "invalid_client: user@example.com");
    expect(recordHealth).toHaveBeenLastCalledWith({ activeVersion: 4, at, code: "sign_in_failed", method: "google" });
  });

  it("never fails the sign-in when the health write fails", async () => {
    const record = createSignInHealthRecorder({
      repository: { recordHealth: vi.fn(async () => { throw new Error("database unavailable"); }) }
    });

    await expect(record({ activeVersion: 1, method: "yandex", source: "admin" }, "accepted")).resolves.toBeUndefined();
  });
});
