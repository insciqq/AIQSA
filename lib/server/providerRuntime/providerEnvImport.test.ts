import { describe, expect, it } from "vitest";
import {
  LegacyProviderImportError,
  parseLegacyProviderEnvironment
} from "../../../prisma/scripts/provider-env-import";

describe("legacy provider environment parser", () => {
  it("treats absent legacy values as an empty import", () => {
    expect(parseLegacyProviderEnvironment({})).toEqual([]);
  });

  it("maps official and custom OpenAI roots to explicit Responses adapters", () => {
    expect(parseLegacyProviderEnvironment({ OPENAI_API_KEY: "secret" })[0]).toMatchObject({
      adapterKind: "openai_responses_native",
      family: "openai"
    });
    expect(parseLegacyProviderEnvironment({
      OPENAI_API_KEY: "secret",
      OPENAI_BASE_URL: "https://llm.example.test/v1/"
    })[0]).toMatchObject({
      adapterKind: "openai_responses_compatible",
      configuration: {
        allowPrivateNetwork: false,
        apiRoot: "https://llm.example.test/v1"
      },
      family: "openai_compatible"
    });
  });

  it("imports reviewed provider roots without OpenRouter application metadata", () => {
    expect(parseLegacyProviderEnvironment({
      ANTHROPIC_API_KEY: "anthropic-secret",
      OPENROUTER_API_KEY: "openrouter-secret",
      OPENROUTER_APP_TITLE: "Legacy title",
      OPENROUTER_HTTP_REFERER: "https://legacy.example.test"
    })).toMatchObject([
      { adapterKind: "anthropic_messages", provider: "anthropic" },
      { adapterKind: "openrouter_chat_completions", provider: "openrouter" }
    ]);
  });

  it("allows an HTTP root only as a disabled private-network draft", () => {
    expect(parseLegacyProviderEnvironment({
      OPENAI_API_KEY: "secret",
      OPENAI_BASE_URL: "http://127.0.0.1:11434/v1"
    })[0]).toMatchObject({
      configuration: {
        allowPrivateNetwork: true,
        apiRoot: "http://127.0.0.1:11434/v1"
      }
    });
  });

  it("rejects partial and malformed input with value-free codes", () => {
    expect(() => parseLegacyProviderEnvironment({
      OPENAI_BASE_URL: "https://llm.example.test/v1"
    })).toThrowError(new LegacyProviderImportError("provider_env_partial_openai"));
    expect(() => parseLegacyProviderEnvironment({
      OPENROUTER_API_KEY: "secret",
      OPENROUTER_BASE_URL: "https://user:password@example.test/v1"
    })).toThrowError(new LegacyProviderImportError("provider_env_invalid_openrouter_endpoint"));
  });
});
