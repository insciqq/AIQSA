import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectNewSessionDialog, connectFolderError } from "./ConnectNewSessionDialog";
import { BOX_ID, ConnectTestShell, MAC_ID, jsonResponse, testDevices, testShellValue } from "./connectShell.testFixtures";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/connect", useRouter: () => ({ push: navigation.push }) }));

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

beforeEach(() => vi.stubGlobal("fetch", fetchMock));
afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  navigation.push.mockReset();
  vi.unstubAllGlobals();
});

function respond(create: Response) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/recent-dirs")) {
      return jsonResponse({ dirs: ["/Users/me/src/aiqsa", "/opt/tools"], home: "/Users/me" });
    }
    if (url.endsWith("/sessions") && init?.method === "POST") return create;
    return jsonResponse({ code: "connect_not_found" }, 404);
  });
}

function renderDialog(onClose = vi.fn()) {
  const devices = testDevices().map((device) => ({ ...device, online: true }));
  const shell = testShellValue(devices);
  render(
    <ConnectTestShell value={shell.value}>
      <ConnectNewSessionDialog devices={devices} initialDeviceId={null} onClose={onClose} />
    </ConnectTestShell>
  );
  return { onClose, shell };
}

function createBody() {
  const call = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/sessions") && init?.method === "POST");
  return call ? { body: JSON.parse(String(call[1]?.body)) as unknown, url: String(call[0]) } : null;
}

describe("ConnectNewSessionDialog", () => {
  it("starts Claude Code in the home folder and leaves the title to the computer", async () => {
    respond(jsonResponse({ sessionId: "ac-new001" }, 201));
    const { onClose } = renderDialog();
    expect(screen.getByLabelText(/Title/u)).toHaveAttribute("placeholder", "Claude Code · ~");
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith(`/connect/${MAC_ID}/ac-new001`));
    expect(createBody()).toEqual({ body: { cwd: "~", program: "claude" }, url: `/api/connect/devices/${MAC_ID}/sessions` });
    expect(onClose).toHaveBeenCalled();
  });

  it("takes a recent folder, another program and a title", async () => {
    respond(jsonResponse({ sessionId: "ac-new002" }, 201));
    renderDialog();
    fireEvent.change(screen.getByLabelText("Computer"), { target: { value: BOX_ID } });
    const recent = await screen.findByRole("group", { name: "Recent folders" });
    fireEvent.click(within(recent).getByRole("button", { name: "~/src/aiqsa" }));
    expect(screen.getByLabelText("Folder")).toHaveValue("~/src/aiqsa");
    fireEvent.click(screen.getByRole("radio", { name: "Codex" }));
    expect(screen.getByLabelText(/Title/u)).toHaveAttribute("placeholder", "Codex · aiqsa");
    fireEvent.change(screen.getByLabelText(/Title/u), { target: { value: "  Review  " } });
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() => expect(createBody()).not.toBeNull());
    expect(createBody()).toEqual({
      body: { cwd: "~/src/aiqsa", program: "codex", title: "Review" },
      url: `/api/connect/devices/${BOX_ID}/sessions`
    });
  });

  it("explains a folder the computer does not have on the field", async () => {
    respond(jsonResponse({ code: "connect_cwd_invalid" }, 422));
    renderDialog();
    fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "/missing" } });
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    expect(await screen.findByText("This folder does not exist on MacBook Pro.")).toBeVisible();
    expect(screen.getByLabelText("Folder")).toHaveAttribute("aria-invalid", "true");
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it.each([
    ["connect_session_limit", 409, "maximum of 30 sessions"],
    ["connect_device_offline", 409, "This computer is offline."],
    ["connect_device_timeout", 504, "did not answer in time"]
  ])("names %s", async (code, status, message) => {
    respond(jsonResponse({ code }, status));
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("checks the folder before asking the computer", () => {
    respond(jsonResponse({ sessionId: "ac-new003" }, 201));
    renderDialog();
    fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "relative/path" } });
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    expect(screen.getByText("Enter an absolute path, or one that starts with ~.")).toBeVisible();
    expect(createBody()).toBeNull();
    expect(connectFolderError("~")).toBeNull();
    expect(connectFolderError("/srv/app")).toBeNull();
    expect(connectFolderError("~user")).not.toBeNull();
  });
});
