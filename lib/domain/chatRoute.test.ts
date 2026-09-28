import { describe, expect, it } from "vitest";
import {
  BLANK_CHAT_ROUTE,
  boundedRouteId,
  chatReturnPath,
  chatRouteHref,
  controlCenterHref,
  formatAssistantEntryPath,
  formatChatRoutePath,
  isChatRoutePathname,
  legacyChatRouteHref,
  parseAssistantEntryPath,
  parseChatRoutePath,
  sameChatRoute,
  withoutChatScopedParameters
} from "./chatRoute";

const chatId = "0f5f3c1e-7d0a-4a55-9a51-8f0d2f6f4a10";
const projectId = "9d3b0a7c-2b61-4f8e-8f5c-6f0b3a1e2d44";

describe("chat route contract", () => {
  it.each([
    ["/", BLANK_CHAT_ROUTE],
    [`/c/${chatId}`, { chatId, projectId: null }],
    [`/p/${projectId}`, { chatId: null, projectId }],
    [`/p/${projectId}/c/${chatId}`, { chatId, projectId }]
  ])("round-trips %s", (pathname, route) => {
    expect(parseChatRoutePath(pathname)).toEqual(route);
    expect(formatChatRoutePath(route)).toBe(pathname);
    expect(isChatRoutePathname(pathname)).toBe(true);
  });

  it("decodes path segments and encodes ids that need it", () => {
    expect(parseChatRoutePath("/c/chat%20one")).toEqual({ chatId: "chat one", projectId: null });
    expect(formatChatRoutePath({ chatId: "a/b?c#d", projectId: "p q" })).toBe("/p/p%20q/c/a%2Fb%3Fc%23d");
    expect(parseChatRoutePath(formatChatRoutePath({ chatId: "a/b?c#d", projectId: "p q" })))
      .toEqual({ chatId: "a/b?c#d", projectId: "p q" });
  });

  it("applies the deep-link id bound to every segment", () => {
    expect(boundedRouteId(" id ")).toBe("id");
    expect(boundedRouteId("x".repeat(256))).toHaveLength(256);
    for (const value of ["", "   ", "x".repeat(257), "a\u0000b", "a\u007fb", null, undefined]) {
      expect(boundedRouteId(value)).toBeNull();
    }
    for (const pathname of [
      `/c/${"x".repeat(257)}`,
      "/c/%00",
      "/c/%E0%A4%A",
      "/c/%20",
      `/p/%7F/c/${chatId}`,
      `/p/${projectId}/c/%0A`
    ]) {
      expect(parseChatRoutePath(pathname)).toBeNull();
      expect(isChatRoutePathname(pathname)).toBe(true);
    }
  });

  it.each(["", "/c", "/c/", "/p", `/c/${chatId}/`, `/c/${chatId}/extra`, `/p/${projectId}/x/${chatId}`,
    `/x/${chatId}`, "/admin", "/artifacts/a/versions/v", "/login"])("rejects the non-route %s", (pathname) => {
    expect(parseChatRoutePath(pathname)).toBeNull();
  });

  it("recognizes only chat page pathnames", () => {
    expect(isChatRoutePathname("/admin")).toBe(false);
    expect(isChatRoutePathname("/artifacts/a/versions/v")).toBe(false);
    expect(isChatRoutePathname("/c")).toBe(false);
  });

  it("round-trips the Assistant entry link, which is a chat page but never a chat's route", () => {
    const assistantId = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
    expect(formatAssistantEntryPath(assistantId)).toBe(`/assistant/${assistantId}`);
    expect(parseAssistantEntryPath(`/assistant/${assistantId}`)).toEqual({ assistantId });
    expect(formatAssistantEntryPath("a/b?c#d")).toBe("/assistant/a%2Fb%3Fc%23d");
    expect(parseAssistantEntryPath(formatAssistantEntryPath("a/b?c#d"))).toEqual({ assistantId: "a/b?c#d" });
    expect(isChatRoutePathname(`/assistant/${assistantId}`)).toBe(true);
    expect(parseChatRoutePath(`/assistant/${assistantId}`)).toBeNull();
    expect(chatReturnPath(`/assistant/${assistantId}`)).toBe("/");
  });

  it("keeps a malformed or over-long Assistant id as an entry that names no Assistant", () => {
    expect(parseAssistantEntryPath(`/assistant/${"x".repeat(256)}`)).toEqual({ assistantId: "x".repeat(256) });
    for (const pathname of [`/assistant/${"x".repeat(257)}`, "/assistant/%00", "/assistant/%E0%A4%A", "/assistant/%20", "/assistant/"]) {
      expect(parseAssistantEntryPath(pathname)).toEqual({ assistantId: null });
      expect(isChatRoutePathname(pathname)).toBe(true);
    }
    for (const pathname of ["/assistant", "/assistant/a/b", "/assistants/a", `/c/${chatId}`, "/"]) {
      expect(parseAssistantEntryPath(pathname)).toBeNull();
    }
    expect(isChatRoutePathname("/assistant")).toBe(false);
    expect(isChatRoutePathname("/assistants/a")).toBe(false);
  });

  it("compares routes by chat and Project", () => {
    expect(sameChatRoute({ chatId, projectId: null }, { chatId, projectId: null })).toBe(true);
    expect(sameChatRoute({ chatId, projectId: null }, { chatId, projectId })).toBe(false);
  });

  it("carries unconsumed parameters and never writes legacy route parameters", () => {
    expect(chatRouteHref({ chatId, projectId: null }, "chat=old&project=old&message=m&library=mcp&oauth=connected"))
      .toBe(`/c/${chatId}?message=m&library=mcp&oauth=connected`);
    expect(chatRouteHref(BLANK_CHAT_ROUTE)).toBe("/");
    expect(withoutChatScopedParameters("message=m&artifactEdit=edit&artifactId=a&versionId=v&memorySource=x").toString())
      .toBe("memorySource=x");
  });

  it("redirects legacy query links to the path form", () => {
    expect(legacyChatRouteHref(new URLSearchParams(`chat=${chatId}`))).toBe(`/c/${chatId}`);
    expect(legacyChatRouteHref(new URLSearchParams(`chat=${chatId}&message=m1&keep=yes`)))
      .toBe(`/c/${chatId}?message=m1&keep=yes`);
    expect(legacyChatRouteHref(new URLSearchParams(`project=${projectId}&chat=${chatId}`)))
      .toBe(`/p/${projectId}/c/${chatId}`);
    expect(legacyChatRouteHref(new URLSearchParams(
      `chat=${chatId}&artifactEdit=edit&artifactId=artifact&versionId=version`
    ))).toBe(`/c/${chatId}?artifactEdit=edit&artifactId=artifact&versionId=version`);
    expect(legacyChatRouteHref(new URLSearchParams(`project=${projectId}`))).toBe(`/p/${projectId}`);
    expect(legacyChatRouteHref(new URLSearchParams("library=artifacts"))).toBeNull();
    expect(legacyChatRouteHref(new URLSearchParams("chat=&message=m&keep=yes"))).toBe("/?keep=yes");
    expect(legacyChatRouteHref(new URLSearchParams(`chat=a&chat=b`))).toBe("/");
  });

  it("accepts only internal chat routes as return paths", () => {
    expect(chatReturnPath(`/c/${chatId}`)).toBe(`/c/${chatId}`);
    expect(chatReturnPath(`/p/${projectId}/c/${chatId}`)).toBe(`/p/${projectId}/c/${chatId}`);
    expect(chatReturnPath(`/p/${projectId}`)).toBe(`/p/${projectId}`);
    expect(chatReturnPath("/")).toBe("/");
    for (const tampered of [
      null,
      undefined,
      "",
      "/admin",
      "/admin?section=mcp",
      "//evil.example/c/x",
      "https://evil.example/c/x",
      "javascript:alert(1)",
      `/c/${chatId}?library=mcp`,
      `/c/${chatId}#answer`,
      "/c/../admin",
      "/c/%00",
      "/login?next=/c/x",
      "/api/me/mcp/server/oauth/connect",
      `\\c\\${chatId}`
    ]) {
      expect(chatReturnPath(tampered)).toBe("/");
    }
  });

  it("builds the Control Center entry from the origin chat route", () => {
    expect(controlCenterHref(`/c/${chatId}`)).toBe(`/admin?return=%2Fc%2F${chatId}`);
    expect(new URLSearchParams(controlCenterHref(`/p/${projectId}/c/${chatId}`).split("?")[1]).get("return"))
      .toBe(`/p/${projectId}/c/${chatId}`);
    expect(controlCenterHref("/")).toBe("/admin");
    expect(controlCenterHref("https://evil.example/")).toBe("/admin");
  });
});
