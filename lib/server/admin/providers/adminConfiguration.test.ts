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
      responseTimeoutSeconds: 500
    });
    const model = normalizeAdminProviderModelConfiguration({
      adapterKind: "openai_responses_native",
      answerSelectable: true,
      capabilities,
      defaultParams: {},
      responseTimeoutSeconds: 800,
      upstreamModelId: "model"
    });

    expect(connection.responseTimeoutMs).toBe(500_000);
    expect(model.responseTimeoutMs).toBe(800_000);
    expect(adminProviderConnectionConfiguration(connection).responseTimeoutSeconds).toBe(500);
    expect(adminProviderModelConfiguration(model).responseTimeoutSeconds).toBe(800);
  });

  it("normalizes missing legacy values to a 300-second connection default and model inheritance", () => {
    const connection = normalizeAdminProviderConnectionConfiguration({
      allowPrivateNetwork: false,
      apiRoot: "https://provider.example.test/v1"
    });
    const model = normalizeAdminProviderModelConfiguration({
      adapterKind: "openai_responses_native",
      capabilities,
      defaultParams: {},
      upstreamModelId: "model"
    });

    expect(connection.responseTimeoutMs).toBe(300_000);
    expect(model.responseTimeoutMs).toBeUndefined();
    expect(adminProviderConnectionConfiguration({
      allowPrivateNetwork: false,
      apiRoot: "https://provider.example.test/v1"
    }).responseTimeoutSeconds).toBe(300);
  });

  it.each([4, 901, 5.5, "300", null, {}])(
    "rejects invalid administrator timeout value %#",
    (responseTimeoutSeconds) => {
      expect(() => normalizeAdminProviderConnectionConfiguration({
        allowPrivateNetwork: false,
        apiRoot: "https://provider.example.test/v1",
        responseTimeoutSeconds
      })).toThrow(ProviderConfigurationError);
      expect(() => normalizeAdminProviderModelConfiguration({
        adapterKind: "openai_responses_native",
        capabilities,
        defaultParams: {},
        responseTimeoutSeconds,
        upstreamModelId: "model"
      })).toThrow(ProviderConfigurationError);
    }
  );
});
