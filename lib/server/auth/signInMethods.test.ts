import { describe, expect, it } from "vitest";
import { getAuthConfig } from "./config";
import { resolveSignInMethods } from "./signInMethods";

describe("sign-in method resolution", () => {
  it("resolves Google and Yandex from the environment exactly as the auth config reads them", async () => {
    const env = {
      AIQSA_GOOGLE_OAUTH_CLIENT_ID: " google-client ",
      AIQSA_GOOGLE_OAUTH_CLIENT_SECRET: "google-secret",
      AIQSA_YANDEX_OAUTH_CLIENT_ID: "yandex-client",
      AIQSA_YANDEX_OAUTH_CLIENT_SECRET: "yandex-secret"
    };

    await expect(resolveSignInMethods({ env })).resolves.toEqual({
      google: {
        config: { clientId: "google-client" },
        method: "google",
        secrets: { clientSecret: "google-secret" },
        source: "environment"
      },
      yandex: {
        config: { clientId: "yandex-client" },
        method: "yandex",
        secrets: { clientSecret: "yandex-secret" },
        source: "environment"
      }
    });
    expect(getAuthConfig(env).oauthProviders.google?.clientId).toBe("google-client");
  });

  it("resolves no method without usable environment credentials", async () => {
    await expect(resolveSignInMethods({ env: {} })).resolves.toEqual({});
    await expect(resolveSignInMethods({
      env: {
        AIQSA_GOOGLE_OAUTH_CLIENT_ID: "google-client",
        AIQSA_GOOGLE_OAUTH_CLIENT_SECRET: "replace-with-google-secret",
        AIQSA_YANDEX_OAUTH_CLIENT_ID: "yandex-client"
      }
    })).resolves.toEqual({});
  });
});
