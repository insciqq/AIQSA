import { describe, expect, it } from "vitest";
import { ProviderConfigurationError } from "../../providers/providerConfiguration";
import {
  adminProviderConnectionConfiguration,
  adminProviderModelConfiguration,
  normalizeAdminProviderConnectionConfiguration,
  normalizeAdminProviderModelConfiguration
} from "./adminConfiguration";

const capabilities = {
  nativePdfInput: false,
  nativeSearch: false,
  pdf: false,
  reasoning: false,
  vision: false
};

describe("administrator provider configuration units", () => {
  it("converts whole seconds to persisted milliseconds and back", () => {
    const connection = normalizeAdminProviderConnectionConfiguration({
      allowPrivateNetwork: false,
      apiRoot: "https://provider.example.test/v1",
      authenticationMode: "bearer",
      responseTimeoutSeconds: 500
    });
    const model = normalizeAdminProviderModelConfiguration({
      adapterKind: "openai_responses_native",
      answerSelectable: true,
      capabilities,
      defaultParams: {},
      modelClass: "answer",
      responseTimeoutSeconds: 800,
      upstreamModelId: "model"
    });

    expect(connection.responseTimeoutMs).toBe(500_000);
    expect(model.responseTimeoutMs).toBe(800_000);
    expect(adminProviderConnectionConfiguration(connection).responseTimeoutSeconds).toBe(500);
    expect(adminProviderModelConfiguration(model).responseTimeoutSeconds).toBe(800);
  });

  it("requires current connection fields while preserving explicit model inheritance", () => {
    const model = normalizeAdminProviderModelConfiguration({
      adapterKind: "openai_responses_native",
      answerSelectable: true,
      capabilities,
      defaultParams: {},
      modelClass: "answer",
      upstreamModelId: "model"
    });

    expect(model.responseTimeoutMs).toBeUndefined();
    expect(() => normalizeAdminProviderConnectionConfiguration({
      allowPrivateNetwork: false,
      apiRoot: "https://provider.example.test/v1",
      authenticationMode: "bearer"
    })).toThrow(ProviderConfigurationError);
  });

  it.each([4, 901, 5.5, "300", null, {}])(
    "rejects invalid administrator timeout value %#",
    (responseTimeoutSeconds) => {
      expect(() => normalizeAdminProviderConnectionConfiguration({
        allowPrivateNetwork: false,
        apiRoot: "https://provider.example.test/v1",
        authenticationMode: "bearer",
        responseTimeoutSeconds
      })).toThrow(ProviderConfigurationError);
      expect(() => normalizeAdminProviderModelConfiguration({
        adapterKind: "openai_responses_native",
        answerSelectable: true,
        capabilities,
        defaultParams: {},
        modelClass: "answer",
        responseTimeoutSeconds,
        upstreamModelId: "model"
      })).toThrow(ProviderConfigurationError);
    }
  );
});
