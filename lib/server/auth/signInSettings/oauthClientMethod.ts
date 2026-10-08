import type { SignInMethodServerDefinition, SignInMethodTestResult } from "./registry";

const GOOGLE_CLIENT_ID = /^[0-9A-Za-z][0-9A-Za-z_-]*\.apps\.googleusercontent\.com$/u;
const CLIENT_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{7,255}$/u;
const CLIENT_SECRET = /^[\x21-\x7e]{8,1024}$/u;

type OAuthClientTester = NonNullable<SignInMethodServerDefinition<"google" | "yandex">["test"]>;

/**
 * Google and Yandex accept or reject a client only during a real authorization, so the test
 * checks the format of the stored values and the first sign-in proves the rest.
 */
function oauthClientTester(clientIdPattern: RegExp): OAuthClientTester {
  return async ({ config, secrets }): Promise<SignInMethodTestResult> => {
    if (!clientIdPattern.test(config.clientId)) return { code: "client_id_format_invalid", passed: false };
    if (!CLIENT_SECRET.test(secrets.clientSecret)) return { code: "client_secret_format_invalid", passed: false };
    return { code: "format_checked", passed: true };
  };
}

export const googleSignInMethod: SignInMethodServerDefinition<"google"> = {
  test: oauthClientTester(GOOGLE_CLIENT_ID)
};

export const yandexSignInMethod: SignInMethodServerDefinition<"yandex"> = {
  test: oauthClientTester(CLIENT_ID)
};
