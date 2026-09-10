import type { AcceptedImageGenerationPlan } from "@/lib/server/providerRuntime/imageModelRole";
import { mcpFindToolsTool } from "@/lib/server/mcp/discovery";
import { imageGenerationTool } from "@/lib/server/tools/imageGeneration";
import { sessionStatusTool } from "@/lib/server/tools/sessionStatus";

export const mixedToolsImagePlan: AcceptedImageGenerationPlan = {
  authority: { connectionId: "image-connection", connectionVersion: 1, credentialId: "image-key",
    credentialVersionId: "image-key-v1", modelVersion: 1, providerModelId: "image-model" },
  parameters: {},
  policyVersion: 1,
  snapshot: {
    connection: { allowPrivateNetwork: false, apiRoot: "https://images.example.test/v1", authenticationMode: "bearer", responseTimeoutMs: 60_000 },
    connectionDisplayName: "Images", connectionId: "image-connection", credentialId: "image-key", credentialVersionId: "image-key-v1",
    model: {
      adapterKind: "openai_images_native", answerSelectable: false, modelClass: "image", upstreamModelId: "image-fixture",
      capabilities: { imageGeneration: true, imageEditing: true, nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
      defaultParams: {}, image: { profile: "openai" }
    },
    modelDisplayName: "Image fixture", providerFamily: "openai", providerModelId: "image-model", version: 1
  },
  version: 1
};

/** Real application declarations; no model/tool execution authority is mocked here. */
export function openRouterMixedTools() {
  return [imageGenerationTool(mixedToolsImagePlan), sessionStatusTool, mcpFindToolsTool];
}
