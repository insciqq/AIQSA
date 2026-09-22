import { imageModelConfiguration } from "../../lib/domain/imageModels";
import type { AcceptedImageGenerationPlan } from "../../lib/server/providerRuntime/imageModelRole";

export function syntheticImagePlan(): AcceptedImageGenerationPlan {
  const authority = { connectionId: "image-connection", connectionVersion: 1, providerModelId: "image-model", modelVersion: 1,
    credentialId: "image-credential", credentialVersionId: "image-key-version" };
  return { version: 1, policyVersion: 1, authority, parameters: { quality: "low" }, snapshot: {
    version: 1, providerFamily: "openai", connectionDisplayName: "Synthetic image provider", modelDisplayName: "Synthetic image model",
    connectionId: authority.connectionId, providerModelId: authority.providerModelId, credentialId: authority.credentialId,
    credentialVersionId: authority.credentialVersionId,
    connection: { apiRoot: "https://image.example/v1", allowPrivateNetwork: false, authenticationMode: "bearer", responseTimeoutMs: 300_000 },
    model: imageModelConfiguration("gpt-image-2", { profile: "openai" })
  } };
}
