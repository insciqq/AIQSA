import { describe, expect, it, vi } from "vitest";
import { createSpeechToTextAdminService, SpeechToTextAdminError } from "./adminService";
import { speechToTextProbeSample } from "./probeSample";
import { catalogDictation, resolveSpeechToTextRole } from "./role";
import { createSpeechToTextTestDb, TEST_ENCRYPTION_KEY } from "./speechToTextTestFixtures";

const at = new Date("2026-10-08T10:00:00.000Z");

function setup(fetchFn: typeof fetch = vi.fn<typeof fetch>(async () => Response.json({ text: "ah", usage: { seconds: 1.2, cost: 0.0001 } }))) {
  const store = createSpeechToTextTestDb();
  const service = createSpeechToTextAdminService({ db: store.db, encryptionKey: () => TEST_ENCRYPTION_KEY, fetchFn, now: () => at });
  return { ...store, fetchFn, service };
}

describe("speech to text role", () => {
  it("is not configured until a passing Test saves the connection, model and tested key", async () => {
    const { addConnection, db, fetchFn, policy, service, usage } = setup();
    addConnection({ id: "c1", family: "openrouter", secret: "or-key" });
    expect(catalogDictation(await resolveSpeechToTextRole(db, { encryptionKey: () => TEST_ENCRYPTION_KEY })))
      .toEqual({ available: false, unavailableReason: "not_configured" });
    expect((await service.read()).connections).toEqual([{ displayName: "Connection c1", family: "openrouter", id: "c1", ready: true }]);

    await service.testAndSave({ connectionId: "c1", expectedConfiguredAt: null, modelId: "openai/whisper-1", userId: "admin" });
    expect(policy).toMatchObject({ speechToTextConnectionId: "c1", speechToTextConfiguredAt: at,
      speechToTextCredentialVersionId: "c1-key-v1", speechToTextModelId: "openai/whisper-1", updatedByUserId: "admin" });
    // The probe is the bundled synthetic WAV, sent with the connection's own key.
    const [url, init] = vi.mocked(fetchFn).mock.calls[0]!;
    expect(url).toBe("https://stt.example.test/v1/audio/transcriptions");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer or-key");
    expect(JSON.parse(String(init?.body)).input_audio).toEqual({ data: Buffer.from(speechToTextProbeSample()).toString("base64"), format: "wav" });
    // One model_check row for the administrator with the reported cost.
    expect(usage).toEqual([expect.objectContaining({ purpose: "model_check", userId: "admin", provider: "openrouter",
      modelId: "openai/whisper-1", providerModelId: null, estimatedCostMicros: 100 })]);
    const role = await service.read();
    expect(role).toMatchObject({ configuredAt: at.toISOString(), assignment: { available: true, connectionDisplayName: "Connection c1",
      connectionId: "c1", modelId: "openai/whisper-1", unavailableReason: null } });
    expect(catalogDictation(await resolveSpeechToTextRole(db, { encryptionKey: () => TEST_ENCRYPTION_KEY })))
      .toEqual({ available: true, unavailableReason: null });
  });

  it("saves nothing when the Test fails and names a content-free reason", async () => {
    const cases: Array<[Response | Error, string]> = [
      [new Response("{}", { status: 401 }), "unauthorized"],
      [new Response("{}", { status: 400 }), "rejected"],
      [new Response("{}", { status: 503 }), "unreachable"],
      [new Response("{\"nope\":1}"), "invalid_response"],
      [new TypeError("offline"), "unreachable"]
    ];
    for (const [outcome, reason] of cases) {
      const { addConnection, policy, service } = setup(async () => {
        if (outcome instanceof Error) throw outcome;
        return outcome.clone();
      });
      addConnection({ id: "c1" });
      const error = await service.testAndSave({ connectionId: "c1", expectedConfiguredAt: null, modelId: "whisper-1", userId: "admin" })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SpeechToTextAdminError);
      expect(error).toMatchObject({ code: "speech_to_text_test_failed", reason });
      expect(policy.speechToTextConnectionId).toBeNull();
    }
  });

  it("refuses a stale fence before paying for a Test, an unusable connection and an invalid model id", async () => {
    const { addConnection, connections, fetchFn, service } = setup();
    addConnection({ id: "c1" });
    await expect(service.testAndSave({ connectionId: "c1", expectedConfiguredAt: "2026-01-01T00:00:00.000Z", modelId: "whisper-1", userId: "a" }))
      .rejects.toMatchObject({ code: "speech_to_text_stale" });
    connections.get("c1")!.enabled = false;
    await expect(service.testAndSave({ connectionId: "c1", expectedConfiguredAt: null, modelId: "whisper-1", userId: "a" }))
      .rejects.toMatchObject({ code: "speech_to_text_connection_unavailable" });
    await expect(service.testAndSave({ connectionId: "c1", expectedConfiguredAt: null, modelId: " bad", userId: "a" }))
      .rejects.toMatchObject({ code: "speech_to_text_model_invalid" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("marks the role for a new Test after a key replacement and unavailable when the key or connection goes", async () => {
    const { addConnection, connections, credentials, db, rotateKey, service, versions } = setup();
    addConnection({ id: "c1" });
    await service.testAndSave({ connectionId: "c1", expectedConfiguredAt: null, modelId: "whisper-1", userId: "admin" });
    const resolve = () => resolveSpeechToTextRole(db, { encryptionKey: () => TEST_ENCRYPTION_KEY });

    versions.get("c1-key-v1")!.revokedAt = new Date();
    expect(await resolve()).toEqual({ ok: false, reason: "credential_unavailable" });
    versions.get("c1-key-v1")!.revokedAt = null;
    rotateKey("c1");
    expect(await resolve()).toEqual({ ok: false, reason: "verification_required" });
    expect((await service.read()).assignment).toMatchObject({ available: false, unavailableReason: "verification_required" });
    credentials.get("c1-key")!.enabled = false;
    expect(await resolve()).toEqual({ ok: false, reason: "credential_unavailable" });
    connections.delete("c1");
    expect(catalogDictation(await resolve())).toEqual({ available: false, unavailableReason: "unavailable" });
    expect((await service.read()).assignment).toMatchObject({ connectionDisplayName: null, unavailableReason: "connection_unavailable" });
  });

  it("rechecks revocation right before each provider request", async () => {
    const { addConnection, db, service, versions } = setup();
    addConnection({ id: "c1" });
    await service.testAndSave({ connectionId: "c1", expectedConfiguredAt: null, modelId: "whisper-1", userId: "admin" });
    const role = await resolveSpeechToTextRole(db, { encryptionKey: () => TEST_ENCRYPTION_KEY });
    if (!role.ok) throw new Error("expected a usable role");
    await expect(role.binding.secret!()).resolves.toBe("secret-key");
    versions.get("c1-key-v1")!.revokedAt = new Date();
    await expect(role.binding.secret!()).rejects.toMatchObject({ code: "credential_revoked" });
  });

  it("supports a no-authentication local server and clears under the fence", async () => {
    const { addConnection, fetchFn, policy, service } = setup();
    addConnection({ id: "local", secret: null });
    await service.testAndSave({ connectionId: "local", expectedConfiguredAt: null, modelId: "whisper-large-v3", userId: "admin" });
    const init = vi.mocked(fetchFn).mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
    await expect(service.clear({ expectedConfiguredAt: null, userId: "admin" })).rejects.toMatchObject({ code: "speech_to_text_stale" });
    await service.clear({ expectedConfiguredAt: at.toISOString(), userId: "admin" });
    expect(policy).toMatchObject({ speechToTextConnectionId: null, speechToTextModelId: null, speechToTextCredentialVersionId: null });
  });

  it("discovers candidates with the connection's key and separates a refused key", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: "whisper-1" }, { id: "gpt-4o" }] }));
    const { addConnection, service } = setup(fetchFn);
    addConnection({ id: "c1" });
    await expect(service.discover({ connectionId: "c1" })).resolves.toEqual(["whisper-1"]);
    fetchFn.mockImplementation(async () => new Response("{}", { status: 403 }));
    await expect(service.discover({ connectionId: "c1" })).rejects.toMatchObject({ code: "speech_to_text_discovery_unauthorized" });
    await expect(service.discover({ connectionId: "missing" })).rejects.toMatchObject({ code: "speech_to_text_connection_unavailable" });
  });

  it("generates a small deterministic WAV probe", () => {
    const sample = speechToTextProbeSample();
    expect(Buffer.from(sample.subarray(0, 4)).toString("ascii")).toBe("RIFF");
    expect(Buffer.from(sample.subarray(8, 12)).toString("ascii")).toBe("WAVE");
    expect(sample.byteLength).toBeLessThan(64 * 1024);
    expect(speechToTextProbeSample()).toBe(sample);
  });
});
