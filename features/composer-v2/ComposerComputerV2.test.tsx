import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatComputerBinding, ConnectComputerWire } from "@/lib/contracts/computer";
import type { ConnectComputerSource } from "@/features/connect/connectShellContext";
import {
  composerGalleryAssistant,
  composerGalleryConfig
} from "@/app/ui-v2-fixture/_fixtures/ComposerV2Gallery";
import { ComposerV2 } from "./ComposerV2";
import { requestComposerComputerPicker } from "./computerPickerRequest";

const WINDOWS_ID = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b";
const BOX_ID = "6c1d9e3a-2b4f-4a8c-8d7e-5f3a1b9c0d2e";
const GONE_ID = "4d3c2b1a-0f9e-4d8c-9b7a-6f5e4d3c2b1a";

function computers(): ConnectComputerWire[] {
  return [
    {
      arch: "amd64",
      clientVersion: "0.4.22",
      id: WINDOWS_ID,
      info: { home: "C:\\Users\\dana", osVersion: "Windows 11 Pro", shell: { kind: "powershell", name: "Windows PowerShell", version: "5.1" } },
      lastSeenAt: "2026-11-07T10:00:00.000Z",
      name: "DESKTOP-7Q2",
      online: true,
      os: "windows"
    },
    {
      arch: "amd64",
      clientVersion: "0.4.21",
      id: BOX_ID,
      lastSeenAt: "2026-11-07T07:00:00.000Z",
      name: "build-box",
      online: false,
      os: "linux"
    }
  ];
}

function staticSource(list: ConnectComputerWire[] | null): ConnectComputerSource {
  const snapshot = { computers: list, connection: "live" as const, loadError: null };
  return { getSnapshot: () => snapshot, removeComputer: vi.fn(), start: vi.fn(), stop: vi.fn(), subscribe: () => () => undefined };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" }, status });
}

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

function requestedUrls(): URL[] {
  return fetchMock.mock.calls.map(([input]) => new URL(String(input), "https://aiqsa.test"));
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

function baseProps() {
  return {
    config: composerGalleryConfig,
    draft: "",
    onDraftChange: vi.fn(),
    onSelectModel: vi.fn(),
    onSelectSearchOptionIds: vi.fn(),
    onSend: vi.fn(),
    selectedModelId: "gpt-5.2",
    selectedProvider: "openai-work",
    selectedSearchOptionIds: ["web-primary"]
  } satisfies Parameters<typeof ComposerV2>[0];
}

function Harness({
  initial = null,
  list = computers(),
  onChange
}: Readonly<{ initial?: ChatComputerBinding | null; list?: ConnectComputerWire[] | null; onChange?(binding: ChatComputerBinding | null): void }>) {
  const [binding, setBinding] = useState(initial);
  const [source] = useState(() => staticSource(list));
  return (
    <ComposerV2
      {...baseProps()}
      computer={{
        binding,
        onChange: (next) => {
          onChange?.(next);
          setBinding(next);
        },
        source
      }}
    />
  );
}

function openPickerFromMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /^Use a computer…/u }));
  return screen.getByTestId("computer-picker");
}

function chooseComputer(picker: HTMLElement, name: string) {
  fireEvent.click(within(picker).getAllByTestId("computer-picker-computer").find((row) => row.textContent?.includes(name))!);
}

describe("Use a computer in the composer", () => {
  it("offers the + row only with AIQSA Connect on and never in an Assistant chat", () => {
    const view = render(<ComposerV2 {...baseProps()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.queryByRole("menuitem", { name: /Use a computer/u })).toBeNull();
    view.unmount();

    render(
      <ComposerV2
        {...baseProps()}
        assistant={{ current: composerGalleryAssistant({ origins: {} }), resetRow: vi.fn() }}
        computer={{ binding: { cwd: "~", deviceId: WINDOWS_ID }, onChange: vi.fn(), source: staticSource(computers()) }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.queryByRole("menuitem", { name: /Use a computer/u })).toBeNull();
    expect(screen.queryByTestId("composer-v2-computer")).toBeNull();
  });

  it("chooses a computer, then a recent folder checked on the computer, and shows the chip", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input), "https://aiqsa.test");
      if (url.pathname.endsWith("/recent-dirs")) {
        return json({ dirs: ["C:\\Users\\dana\\Documents\\Reports"], home: "C:\\Users\\dana" });
      }
      if (url.pathname.endsWith("/stat")) {
        return json({ exists: true, kind: "dir", mtime: "2026-11-07T10:00:00.000Z", path: url.searchParams.get("path"), size: 0 });
      }
      return json({ code: "connect_not_found" }, 404);
    });
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const picker = openPickerFromMenu();
    const rows = within(picker).getAllByTestId("computer-picker-computer");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("DESKTOP-7Q2"),
      expect.stringContaining("build-box")
    ]);
    expect(rows[0]).toHaveTextContent("Windows 11 Pro · x64 · Online");
    expect(rows[1]).toHaveTextContent("Offline");

    chooseComputer(picker, "DESKTOP-7Q2");
    const shortcut = await within(picker).findByRole("button", { name: /~\\Documents\\Reports/u });
    expect(within(picker).getByRole("button", { name: /^Home/u })).toBeVisible();
    fireEvent.click(shortcut);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ cwd: "C:\\Users\\dana\\Documents\\Reports", deviceId: WINDOWS_ID }));
    const stat = requestedUrls().find((url) => url.pathname.endsWith("/stat"))!;
    expect(stat.pathname).toBe(`/api/connect/devices/${WINDOWS_ID}/stat`);
    expect(stat.searchParams.get("path")).toBe("C:\\Users\\dana\\Documents\\Reports");

    expect(screen.queryByTestId("computer-picker")).toBeNull();
    const chip = screen.getByTestId("composer-v2-computer");
    expect(chip).toHaveAttribute("data-state", "online");
    expect(chip).toHaveTextContent("DESKTOP-7Q2 · Reports");
    expect(chip).toHaveAttribute("data-tooltip", "DESKTOP-7Q2 · C:\\Users\\dana\\Documents\\Reports");
  });

  it("browses one level at a time and uses the folder it reached", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input), "https://aiqsa.test");
      const path = url.searchParams.get("path");
      if (url.pathname.endsWith("/recent-dirs")) return json({ dirs: [], home: "C:\\Users\\dana" });
      if (url.pathname.endsWith("/dirs") && path === "C:\\Users\\dana") {
        return json({ dirs: ["Desktop", "Documents"], parent: "C:\\Users", path, truncated: false });
      }
      if (url.pathname.endsWith("/dirs") && path === "C:\\Users\\dana\\Documents") {
        return json({ dirs: ["Contracts"], parent: "C:\\Users\\dana", path, truncated: true });
      }
      if (url.pathname.endsWith("/stat")) return json({ exists: true, kind: "dir", mtime: "2026-11-07T10:00:00.000Z", path, size: 0 });
      return json({ code: "connect_not_found" }, 404);
    });
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const picker = openPickerFromMenu();
    chooseComputer(picker, "DESKTOP-7Q2");
    fireEvent.click(await within(picker).findByRole("button", { name: "Browse…" }));
    fireEvent.click(await within(picker).findByRole("button", { name: "Documents" }));
    expect(await within(picker).findByTestId("computer-picker-browse-path")).toHaveTextContent("~\\Documents");
    expect(within(picker).getByText(/Only the first folders are listed/u)).toBeVisible();
    fireEvent.click(within(picker).getByRole("button", { name: "Use this folder" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ cwd: "C:\\Users\\dana\\Documents", deviceId: WINDOWS_ID }));
  });

  it("refuses a typed path that is a file or missing, and names a failed browse", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input), "https://aiqsa.test");
      const path = url.searchParams.get("path");
      if (url.pathname.endsWith("/recent-dirs")) return json({ dirs: [], home: "C:\\Users\\dana" });
      if (url.pathname.endsWith("/dirs")) return json({ code: "connect_device_offline" }, 409);
      if (url.pathname.endsWith("/stat") && path === "C:\\notes.txt") {
        return json({ exists: true, kind: "file", mtime: "2026-11-07T10:00:00.000Z", path, size: 12 });
      }
      if (url.pathname.endsWith("/stat")) return json({ exists: false });
      return json({ code: "connect_not_found" }, 404);
    });
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const picker = openPickerFromMenu();
    chooseComputer(picker, "DESKTOP-7Q2");
    const field = await within(picker).findByLabelText("Or type a folder path");
    fireEvent.change(field, { target: { value: "C:\\notes.txt" } });
    fireEvent.click(within(picker).getByRole("button", { name: "Use" }));
    expect(await within(picker).findByTestId("computer-picker-error")).toHaveTextContent("This is a file, not a folder.");
    fireEvent.change(field, { target: { value: "D:\\missing" } });
    fireEvent.click(within(picker).getByRole("button", { name: "Use" }));
    await waitFor(() => expect(within(picker).getByTestId("computer-picker-error"))
      .toHaveTextContent("This folder does not exist on the computer."));
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(within(picker).getByRole("button", { name: "Browse…" }));
    expect(await within(picker).findByRole("alert")).toHaveTextContent("This computer is offline.");
  });

  it("takes a folder on an offline computer without asking it", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const picker = openPickerFromMenu();
    chooseComputer(picker, "build-box");
    expect(within(picker).getByTestId("computer-picker-offline")).toHaveTextContent("build-box is offline");
    expect(within(picker).queryByRole("button", { name: "Browse…" })).toBeNull();
    fireEvent.change(within(picker).getByLabelText("Or type a folder path"), { target: { value: "~/work" } });
    fireEvent.click(within(picker).getByRole("button", { name: "Use" }));
    expect(onChange).toHaveBeenCalledWith({ cwd: "~/work", deviceId: BOX_ID });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("composer-v2-computer")).toHaveAttribute("data-state", "offline");
    expect(screen.getByTestId("composer-v2-computer")).toHaveTextContent("build-box · workoffline");
  });

  it("leads to AIQSA Connect when the user has no computers", () => {
    render(<Harness list={[]} />);
    const picker = openPickerFromMenu();
    expect(within(picker).getByRole("link", { name: "Add a computer in AIQSA Connect" })).toHaveAttribute("href", "/connect");
  });

  it("offers Change folder, Change computer and Stop using computer on the chip", async () => {
    fetchMock.mockImplementation(async () => json({ dirs: [], home: "C:\\Users\\dana" }));
    const onChange = vi.fn();
    render(<Harness initial={{ cwd: "C:\\Users\\dana\\Documents", deviceId: WINDOWS_ID }} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("composer-v2-computer"));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Change folder", "Change computer", "Stop using computer"
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Change folder" }));
    expect(await screen.findByTestId("computer-picker-folder")).toBeVisible();
    expect(screen.getByLabelText("Or type a folder path")).toHaveValue("C:\\Users\\dana\\Documents");
    fireEvent.click(screen.getByRole("button", { name: "All computers" }));
    expect(screen.getAllByTestId("computer-picker-computer")).toHaveLength(2);
    fireEvent.click(within(screen.getByTestId("computer-picker")).getAllByRole("button", { name: "Close" })[0]!);

    fireEvent.click(screen.getByTestId("composer-v2-computer"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Stop using computer" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.queryByTestId("composer-v2-computer")).toBeNull();
  });

  it("shows a computer that is no longer the user's as removed, with a way to choose another", () => {
    render(<Harness initial={{ cwd: "~/Documents", deviceId: GONE_ID }} />);
    const chip = screen.getByTestId("composer-v2-computer");
    expect(chip).toHaveAttribute("data-state", "removed");
    expect(chip).toHaveTextContent("Computer removed");
    fireEvent.click(chip);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Choose another computer", "Stop using computer"
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Choose another computer" }));
    expect(screen.getByTestId("computer-picker")).toHaveTextContent("DESKTOP-7Q2");
  });

  it("does not call a computer removed before the list has loaded", () => {
    render(<Harness initial={{ cwd: "~", deviceId: WINDOWS_ID }} list={null} />);
    const chip = screen.getByTestId("composer-v2-computer");
    expect(chip).toHaveAttribute("data-state", "loading");
    expect(chip).toHaveTextContent("Computer · ~");
  });

  it("opens the picker when a refused send asks for another computer", () => {
    render(<Harness initial={{ cwd: "~", deviceId: GONE_ID }} />);
    expect(screen.queryByTestId("computer-picker")).toBeNull();
    act(() => requestComposerComputerPicker());
    expect(screen.getByTestId("computer-picker")).toBeVisible();
  });
});
