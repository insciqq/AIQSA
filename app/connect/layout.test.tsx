import { isValidElement, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appBaseUrl: "https://ai.example.com/",
  findSettings: vi.fn(),
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
vi.mock("@/lib/server/auth/config", () => ({ getAuthConfig: () => ({ appBaseUrl: mocks.appBaseUrl, configured: true }) }));
vi.mock("@/lib/server/prisma", () => ({ prisma: { userSettings: { findUnique: mocks.findSettings } } }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: mocks.redirect }));
vi.mock("@/features/connect/ConnectShell", () => ({ ConnectShell: () => null }));
vi.mock("@/features/connect/ConnectHomeView", () => ({ ConnectHomeView: () => null }));
vi.mock("@/features/connect/ConnectPairView", () => ({ ConnectPairView: () => null }));
vi.mock("@/features/connect/ConnectSessionView", () => ({
  ConnectSessionNotFound: () => null,
  ConnectSessionView: () => null
}));

import { ConnectPairView } from "@/features/connect/ConnectPairView";
import { ConnectSessionNotFound, ConnectSessionView } from "@/features/connect/ConnectSessionView";
import { ConnectShell } from "@/features/connect/ConnectShell";
import ConnectSessionPage from "./[deviceId]/[sessionId]/page";
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
  mocks.appBaseUrl = "https://ai.example.com/";
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
    expect(mocks.findSettings).not.toHaveBeenCalled();
  });

  it("render the shell with the installation origin and the notification setting", async () => {
    mocks.viewer = viewer(true);
    mocks.findSettings.mockResolvedValue({ browserNotificationsEnabled: false });
    const shell = element(await ConnectLayout({ children: "page" }));
    expect(shell.type).toBe(ConnectShell);
    expect(shell.props).toMatchObject({
      accountId: "user-1",
      accountLabel: "Dana",
      browserNotificationsEnabled: false,
      children: "page",
      installOrigin: "https://ai.example.com"
    });
    expect(mocks.findSettings).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "user-1" } }));
  });

  it("leave sign-in to the page, which returns to its exact address", async () => {
    await expect(ConnectLayout({ children: "page" })).resolves.toBe("page");
    await expect(ConnectPairPage({ searchParams: Promise.resolve({ code: "BCDF-2345" }) })).rejects.toThrow("NEXT_REDIRECT");
    const location = new URL(mocks.redirect.mock.calls[0]![0], "https://aiqsa.invalid");
    expect(location.searchParams.get("next")).toBe("/connect/pair?code=BCDF-2345");
    await expect(ConnectPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_REDIRECT");
  });

  it("pass one pairing code and refuse repeated ones", async () => {
    mocks.viewer = viewer(true);
    expect(element(await ConnectPairPage({ searchParams: Promise.resolve({ code: "BCDF-2345" }) })).props).toMatchObject({ code: "BCDF-2345" });
    const repeated = element(await ConnectPairPage({ searchParams: Promise.resolve({ code: ["A", "B"] }) }));
    expect(repeated.type).toBe(ConnectPairView);
    expect(repeated.props.code).toBeNull();
  });

  it("answer malformed ids like unknown sessions without opening a view", async () => {
    mocks.viewer = viewer(true);
    const page = (deviceId: string, sessionId: string) => ConnectSessionPage({
      params: Promise.resolve({ deviceId, sessionId }),
      searchParams: Promise.resolve({})
    });
    const valid = element(await page("0b6f2c1e-5a7d-4c3e-9f10-2a4b6c8d0e1f", "ac-k3m9q2"));
    expect(valid.type).toBe(ConnectSessionView);
    expect(valid.props).toMatchObject({ deviceId: "0b6f2c1e-5a7d-4c3e-9f10-2a4b6c8d0e1f", sessionId: "ac-k3m9q2" });
    expect(element(await page("not-a-device", "ac-k3m9q2")).type).toBe(ConnectSessionNotFound);
    expect(element(await page("0B6F2C1E-5A7D-4C3E-9F10-2A4B6C8D0E1F", "ac-k3m9q2")).type).toBe(ConnectSessionNotFound);
    expect(element(await page("0b6f2c1e-5a7d-4c3e-9f10-2a4b6c8d0e1f", "tmux-main")).type).toBe(ConnectSessionNotFound);
  });

  it("offer no install commands for an installation address that is not a plain origin", async () => {
    mocks.viewer = viewer(true);
    mocks.appBaseUrl = "https://user:secret@ai.example.com/";
    mocks.findSettings.mockResolvedValue(null);
    const shell = element(await ConnectLayout({ children: "page" }));
    expect(shell.props).toMatchObject({ browserNotificationsEnabled: true, installOrigin: null });
  });
});
