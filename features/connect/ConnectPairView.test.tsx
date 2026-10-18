import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectPairView } from "./ConnectPairView";
import { ConnectTestShell, jsonResponse, testShellValue } from "./connectShell.testFixtures";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/connect/pair", useRouter: () => ({ push: navigation.push }) }));
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => <a href={href} {...props}>{children}</a>
}));

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const pairing = {
  pairing: {
    arch: "arm64",
    clientVersion: "0.3.20",
    expiresAt: "2026-10-19T12:10:00.000Z",
    hostname: "mbp.local",
    name: "MacBook Pro",
    os: "darwin"
  }
};

beforeEach(() => vi.stubGlobal("fetch", fetchMock));
afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  navigation.push.mockReset();
  vi.unstubAllGlobals();
});

function renderPair(code: string | null) {
  const shell = testShellValue([]);
  render(<ConnectTestShell value={shell.value}><ConnectPairView code={code} /></ConnectTestShell>);
  return shell;
}

describe("ConnectPairView", () => {
  it("shows the computer and approves it", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(pairing)).mockResolvedValueOnce(jsonResponse({ status: "approved" }));
    renderPair("bcdf 2345");
    expect(await screen.findByText("Connect this computer to your AIQSA?")).toBeVisible();
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/connect/pairings/by-code/BCDF-2345");
    const facts = screen.getByTestId("connect-pair-facts");
    expect(facts).toHaveTextContent("MacBook Pro");
    expect(facts).toHaveTextContent("mbp.local");
    expect(facts).toHaveTextContent("macOS · arm64");
    expect(facts).toHaveTextContent("0.3.20");

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByTestId("connect-pair-approved")).toHaveTextContent("Return to the terminal");
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe("/api/connect/pairings/by-code/BCDF-2345");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ decision: "approve" });
  });

  it("denies a computer", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(pairing)).mockResolvedValueOnce(jsonResponse({ status: "denied" }));
    renderPair("BCDF-2345");
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
    expect(await screen.findByTestId("connect-pair-denied")).toHaveTextContent("was not connected");
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({ decision: "deny" });
  });

  it.each(["connect_pairing_expired", "connect_not_found"])("answers %s neutrally", async (code) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code }, 404));
    renderPair("BCDF-2345");
    expect(await screen.findByRole("alert")).toHaveTextContent("This code is not valid or has expired.");
    expect(screen.getByLabelText("Code from the terminal")).toBeVisible();
  });

  it("turns a code used meanwhile into the same neutral answer", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(pairing))
      .mockResolvedValueOnce(jsonResponse({ code: "connect_pairing_expired" }, 404));
    renderPair("BCDF-2345");
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This code is not valid or has expired.");
  });

  it("names a computer limit at approval and keeps the choice", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(pairing))
      .mockResolvedValueOnce(jsonResponse({ code: "connect_device_limit" }, 409));
    renderPair("BCDF-2345");
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("maximum of 10 computers");
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("never asks the server about a malformed code", () => {
    renderPair("not-a-code");
    expect(screen.getByText(/This code is not valid or has expired/u)).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Code from the terminal"), { target: { value: "hjkm7892" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(navigation.push).toHaveBeenCalledWith("/connect/pair?code=HJKM-7892");
  });

  it("leaves the mode when it was turned off", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "connect_disabled" }, 403));
    const { value } = renderPair("BCDF-2345");
    await vi.waitFor(() => expect(value.leave).toHaveBeenCalledWith("disabled"));
  });
});
