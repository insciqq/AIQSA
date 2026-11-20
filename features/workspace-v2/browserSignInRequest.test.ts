import { beforeEach, describe, expect, it } from "vitest";
import {
  BROWSER_SIGN_IN_REQUEST_TTL_MS,
  requestBrowserSignIn,
  takeBrowserSignInRequest,
  useBrowserSignInRequestStore
} from "./browserSignInRequest";

describe("a Sign in again pressed in Settings", () => {
  beforeEach(() => useBrowserSignInRequestStore.setState({ request: null }));

  it("is taken once, only in the chat it names", () => {
    requestBrowserSignIn("chat-1", "mail.example.com", 1_000);
    expect(takeBrowserSignInRequest("chat-2", 1_500)).toBeNull();
    expect(takeBrowserSignInRequest(null, 1_500)).toBeNull();
    expect(takeBrowserSignInRequest("chat-1", 2_000)).toBe("mail.example.com");
    expect(takeBrowserSignInRequest("chat-1", 2_000)).toBeNull();

    requestBrowserSignIn(null, "portal.example.org", 1_000);
    expect(takeBrowserSignInRequest("chat-1", 1_500)).toBeNull();
    expect(takeBrowserSignInRequest(null, 1_500)).toBe("portal.example.org");
  });

  it("is dropped when its chat never opened in time, so a later visit sends nothing unasked", () => {
    requestBrowserSignIn("chat-1", "mail.example.com", 1_000);
    expect(takeBrowserSignInRequest("chat-1", 1_000 + BROWSER_SIGN_IN_REQUEST_TTL_MS + 1)).toBeNull();
    expect(useBrowserSignInRequestStore.getState().request).toBeNull();
  });
});
