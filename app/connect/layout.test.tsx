import { isValidElement, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn((location: string): never => {
    throw new Error(`NEXT_REDIRECT ${location}`);
  }),
  viewer: null as null | Record<string, unknown>
}));

vi.mock("../(chat)/viewer", () => ({
  authorizeChatPage: async (pathname: string, query: URLSearchParams) => {
    if (mocks.viewer) return;
    const address = `${pathname}${query.size > 0 ? `?${query}` : ""}`;
    mocks.redirect(`/login?${new URLSearchParams({ next: address })}`);
  },
  chatPageQuery: (values: Record<string, string | string[] | undefined>) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) {
      for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, entry);
    }
    return query;
  },
  loadChatViewer: async () => mocks.viewer
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: mocks.redirect }));
vi.mock("@/features/connect/ConnectShell", () => ({ ConnectShell: () => null }));
vi.mock("@/features/connect/ConnectPairView", () => ({ ConnectPairView: () => null }));

import { ConnectPairView } from "@/features/connect/ConnectPairView";
import { ConnectShell } from "@/features/connect/ConnectShell";
import ConnectLayout from "./layout";
import ConnectPage from "./page";
import ConnectPairPage from "./pair/page";

const viewer = (connectEnabled: boolean) => ({
  accountDisplayName: "Dana",
  accountEmail: "dana@example.test",
  accountId: "user-1",
  adminEntryVisible: false,
  connectEnabled
});

afterEach(() => {
  mocks.viewer = null;
  vi.clearAllMocks();
});

function element(value: unknown): ReactElement<Record<string, unknown>> {
  expect(isValidElement(value)).toBe(true);
  return value as ReactElement<Record<string, unknown>>;
}

describe("AIQSA Connect routes", () => {
  it("do not exist while the installation has the feature off", async () => {
    mocks.viewer = viewer(false);
    await expect(ConnectLayout({ children: "page" })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("render the pair page's shell with the account", async () => {
    mocks.viewer = viewer(true);
    const shell = element(await ConnectLayout({ children: "page" }));
    expect(shell.type).toBe(ConnectShell);
    expect(shell.props).toMatchObject({
      accountId: "user-1",
      accountLabel: "Dana",
      adminEntryVisible: false,
      children: "page"
    });
    expect(shell.props).not.toHaveProperty("installOrigin");
  });

  it("send /connect to Settings › Computers, without other query parameters", async () => {
    mocks.viewer = viewer(true);
    await expect(ConnectPage({ searchParams: Promise.resolve({ tab: "x", utm_source: "mail" }) })).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.redirect).toHaveBeenCalledOnce();
    expect(mocks.redirect).toHaveBeenCalledWith("/?library=computers");
  });

  it("answer /connect with not found while the feature is off", async () => {
    mocks.viewer = viewer(false);
    await expect(ConnectPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("leave sign-in to the page, which returns to its exact address", async () => {
    await expect(ConnectLayout({ children: "page" })).resolves.toBe("page");
    await expect(ConnectPairPage({ searchParams: Promise.resolve({ code: "BCDF-2345" }) })).rejects.toThrow("NEXT_REDIRECT");
    const location = new URL(mocks.redirect.mock.calls[0]![0], "https://aiqsa.invalid");
    expect(location.searchParams.get("next")).toBe("/connect/pair?code=BCDF-2345");
    await expect(ConnectPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_REDIRECT");
    expect(new URL(mocks.redirect.mock.calls[1]![0], "https://aiqsa.invalid").searchParams.get("next")).toBe("/connect");
  });

  it("pass one pairing code and refuse repeated ones", async () => {
    mocks.viewer = viewer(true);
    expect(element(await ConnectPairPage({ searchParams: Promise.resolve({ code: "BCDF-2345" }) })).props).toMatchObject({ code: "BCDF-2345" });
    const repeated = element(await ConnectPairPage({ searchParams: Promise.resolve({ code: ["A", "B"] }) }));
    expect(repeated.type).toBe(ConnectPairView);
    expect(repeated.props.code).toBeNull();
  });
});
