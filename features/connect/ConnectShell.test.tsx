import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectHomeView } from "./ConnectHomeView";
import { ConnectShell } from "./ConnectShell";
import { testDevices, testShellValue } from "./connectShell.testFixtures";

vi.mock("next/navigation", () => ({ usePathname: () => "/connect", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => <a href={href} {...props}>{children}</a>
}));
vi.mock("@/components/app-shell/sessionActions", () => ({ signOutCurrentSession: vi.fn() }));

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderShell(devices = testDevices()) {
  const { source } = testShellValue(devices);
  render(
    <ConnectShell
      accountId="account-1"
      accountLabel="Dana"
      adminEntryVisible={false}
      browserNotificationsEnabled={false}
      installOrigin="https://ai.example.com"
      onLeave={vi.fn()}
      source={source}
    >
      <ConnectHomeView />
    </ConnectShell>
  );
  return source;
}

describe("ConnectShell", () => {
  it("has its own rail: AIQSA Connect is current and Chats returns to the chat shell", () => {
    const source = renderShell();
    expect(source.start).toHaveBeenCalledOnce();
    const rail = screen.getByTestId("connect-rail");
    expect(within(rail).getByRole("link", { name: "Chats" })).toHaveAttribute("href", "/");
    expect(within(rail).getByRole("link", { name: "AIQSA Connect" })).toHaveAttribute("aria-current", "page");
    expect(within(rail).queryByRole("link", { name: "Control Center" })).toBeNull();
    const column = screen.getByTestId("connect-column");
    expect(within(column).getByText("AIQSA Connect")).toBeVisible();
    expect(within(column).getAllByTestId("connect-device")).toHaveLength(2);
  });

  it("opens New session with only the online computers", () => {
    renderShell();
    fireEvent.click(within(screen.getByTestId("connect-column")).getByRole("button", { name: "New session" }));
    const sheet = screen.getByTestId("connect-new-session");
    expect(within(sheet).getByRole("option", { name: "MacBook Pro" })).toBeInTheDocument();
    expect(within(sheet).queryByRole("option", { name: "build-box" })).toBeNull();
  });

  it("shows the install steps for this installation without computers", () => {
    renderShell([]);
    const empty = screen.getByTestId("connect-empty-state");
    expect(within(empty).getByLabelText("Install aiqsa-connect command"))
      .toHaveTextContent("curl -fsSL https://ai.example.com/connect/install.sh | sh");
    expect(within(empty).getByLabelText("Connect the computer command"))
      .toHaveTextContent("aiqsa-connect login https://ai.example.com");
    expect(within(empty).getByLabelText("Finish setup command"))
      .toHaveTextContent("aiqsa-connect setup aiqsa-connect service install");
    expect(within(empty).getByRole("link", { name: "Settings → Claude Code & Codex" }))
      .toHaveAttribute("href", "/?settings=connected_apps");
    expect(empty).toHaveTextContent("happens at the computer");
    expect(within(screen.getByTestId("connect-column")).getByRole("button", { name: "New session" })).toBeDisabled();
  });
});
