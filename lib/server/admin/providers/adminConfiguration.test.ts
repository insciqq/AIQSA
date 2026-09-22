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
  it.each([5, 300, 900, 3600, 86_400])("round trips whole seconds, including long requests (%s)", (seconds) => {
    const connection = normalizeAdminProviderConnectionConfiguration({
      allowPrivateNetwork: false,
      apiRoot: "https://provider.example.test/v1",
      authenticationMode: "bearer",
      responseTimeoutSeconds: seconds
    });
    const model = normalizeAdminProviderModelConfiguration({
      adapterKind: "openai_responses_native",
      answerSelectable: true,
      capabilities,
      defaultParams: {},
      modelClass: "answer",
      responseTimeoutSeconds: seconds,
      upstreamModelId: "model"
    });

    expect(connection.responseTimeoutMs).toBe(seconds * 1_000);
    expect(model.responseTimeoutMs).toBe(seconds * 1_000);
    expect(adminProviderConnectionConfiguration(connection).responseTimeoutSeconds).toBe(seconds);
    expect(adminProviderModelConfiguration(model).responseTimeoutSeconds).toBe(seconds);
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

  it.each([4, 86_401, 5.5, "300", null, {}, NaN, Infinity])(
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
