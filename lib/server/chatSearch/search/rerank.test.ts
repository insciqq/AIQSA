import { describe, expect, it } from "vitest";
import { ProviderAdmissionError } from "../../providerRuntime/admission";
import type { RerankerModelRoleResolution } from "../../providerRuntime/rerankerModelRole";
import type { RerankerRuntimeBinding } from "../../providerRuntime/rerankerRuntime";
import { createPrismaPastChatReranker } from "./rerank";

type Dependencies = NonNullable<Parameters<typeof createPrismaPastChatReranker>[1]>;
type Resolver = NonNullable<Dependencies["resolver"]>;
type Runtime = NonNullable<Dependencies["runtime"]>;

const role = {} as never;
const binding = { adapter: { rerank: async () => ({ model: "m", provider: "p", requestId: null, scores: [], usage: { inputTokens: null,
  searchUnits: null, totalTokens: null } }) }, connectionId: "conn", credentialId: "cred", credentialSource: "default",
  credentialVersionId: "credv", provider: "openrouter", providerModelId: "selected" } as unknown as RerankerRuntimeBinding;

function reranker(resolution: RerankerModelRoleResolution, runtime: Runtime["resolveForInstallation"] = async () => binding) {
  const asked: string[] = [];
  const resolver: Resolver = { resolve: async () => resolution };
  return { asked, fake: createPrismaPastChatReranker({} as never, { resolver, runtime: { resolveForInstallation: async (input) => {
    asked.push(input.providerModelId);
    return runtime(input);
  } } }) };
}

describe("past-chat reranker role", () => {
  it("is not set without an administrator's choice", async () => {
    expect(await reranker({ code: "reranker_model_absent", ok: false, selectedProviderModelId: null }).fake.resolve()).toEqual({ kind: "unset" });
  });

  it("uses the selected model and names only its route's identity", async () => {
    const { asked, fake } = reranker({ credentialScope: "installation", ok: true, policyVersion: 1, providerModelId: "selected", role,
      selectedProviderModelId: "selected" });
    const resolved = await fake.resolve();
    expect(asked).toEqual(["selected"]);
    expect(resolved).toMatchObject({ kind: "ready", route: { binding: { connectionId: "conn", credentialId: "cred", credentialSource: "default",
      credentialVersionId: "credv", provider: "openrouter", providerModelId: "selected" } } });
  });

  it("never falls through to another approved reranker when the selected one is broken", async () => {
    const fallback = reranker({ credentialScope: "installation", ok: true, policyVersion: 1, providerModelId: "approved-fallback", role,
      selectedProviderModelId: "selected" });
    expect(await fallback.fake.resolve()).toEqual({ kind: "unavailable", providerModelId: "selected" });
    expect(fallback.asked).toEqual([]);
    expect(await reranker({ code: "reranker_model_unavailable", ok: false, selectedProviderModelId: "selected" }).fake.resolve())
      .toEqual({ kind: "unavailable", providerModelId: "selected" });
    const refused = reranker({ credentialScope: "installation", ok: true, policyVersion: 1, providerModelId: "selected", role,
      selectedProviderModelId: "selected" }, async () => {
      throw new ProviderAdmissionError("credential_revoked");
    });
    expect(await refused.fake.resolve()).toEqual({ kind: "unavailable", providerModelId: "selected" });
  });
});
