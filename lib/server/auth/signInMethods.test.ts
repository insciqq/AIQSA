import { describe, expect, it } from "vitest";
import { getAuthConfig } from "./config";
import type { ActiveSignInSetting } from "./signInSettings/activeSettings";
import { resolveSignInMethods } from "./signInMethods";

const noAdminSettings = async (): Promise<readonly ActiveSignInSetting[]> => [];

const env = {
  AIQSA_GOOGLE_OAUTH_CLIENT_ID: " google-client ",
  AIQSA_GOOGLE_OAUTH_CLIENT_SECRET: "google-secret",
  AIQSA_YANDEX_OAUTH_CLIENT_ID: "yandex-client",
  AIQSA_YANDEX_OAUTH_CLIENT_SECRET: "yandex-secret"
};

describe("sign-in method resolution", () => {
  it("resolves Google and Yandex from the environment exactly as the auth config reads them", async () => {
    await expect(resolveSignInMethods({ env, loadActiveSettings: noAdminSettings })).resolves.toEqual({
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
    await expect(resolveSignInMethods({ env: {}, loadActiveSettings: noAdminSettings })).resolves.toEqual({});
    await expect(resolveSignInMethods({
      env: {
        AIQSA_GOOGLE_OAUTH_CLIENT_ID: "google-client",
        AIQSA_GOOGLE_OAUTH_CLIENT_SECRET: "replace-with-google-secret",
        AIQSA_YANDEX_OAUTH_CLIENT_ID: "yandex-client"
      },
      loadActiveSettings: noAdminSettings
    })).resolves.toEqual({});
  });

  it("lets an active admin configuration win over the environment and keeps the other provider's fallback", async () => {
    const resolved = await resolveSignInMethods({
      env,
      loadActiveSettings: async () => [{
        activeVersion: 3,
        method: "google",
        resolved: { config: { clientId: "admin-client" }, secrets: { clientSecret: "admin-secret" } }
      }]
    });

    expect(resolved.google).toEqual({
      activeVersion: 3,
      config: { clientId: "admin-client" },
      method: "google",
      secrets: { clientSecret: "admin-secret" },
      source: "admin"
    });
    expect(resolved.yandex?.source).toBe("environment");
  });

  it("keeps a method off when its enabled admin configuration cannot be read, without falling back", async () => {
    const resolved = await resolveSignInMethods({
      env,
      loadActiveSettings: async () => [{ activeVersion: 2, method: "google", resolved: null }]
    });

    expect(resolved.google).toBeUndefined();
    expect(resolved.yandex?.source).toBe("environment");
  });

  it("resolves methods without an environment fallback only from the admin panel", async () => {
    const resolved = await resolveSignInMethods({
      env: {},
      loadActiveSettings: async () => [{
        activeVersion: 1,
        method: "trusted_header",
        resolved: {
          config: {
            adminGroups: [],
            allowedGroups: [],
            autoCreateUsers: true,
            emailHeader: "X-Email",
            groupsHeader: null,
            groupsSeparator: ",",
            nameHeader: null,
            syncGroups: false
          },
          secrets: {}
        }
      }]
    });

    expect(Object.keys(resolved)).toEqual(["trusted_header"]);
    expect(resolved.trusted_header?.source).toBe("admin");
  });
});
