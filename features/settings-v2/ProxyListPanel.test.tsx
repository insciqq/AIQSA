import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROXY_ADDRESS_FAILURE_CODES,
  PROXY_CHANGE_FAILURE_CODES,
  PROXY_CONNECTION_FAILURE_CODES,
  PROXY_INPUT_FAILURE_CODES,
  PROXY_ROUTES,
  type ProxySharedWire,
  type ProxyWire
} from "@/lib/contracts/proxies";
import { proxyFailureMessage } from "./proxyMessages";
import { ProxyListPanel } from "./ProxyListPanel";

const PROXY_ID = "10000000-0000-4000-8000-000000000001";
const proxy: ProxyWire = { active: true, country: "KZ", domainHints: [".kz", "ozon.ru"], hasPassword: true, host: "proxy.example.com", id: PROXY_ID,
  lastCheck: null, login: "alice", name: "Almaty", owner: "personal", port: 8080, protocol: "http", version: 3 };
const shared: ProxySharedWire = { active: true, country: "DE", domainHints: [".de"], id: "20000000-0000-4000-8000-000000000002", name: "Berlin office",
  owner: "administrator", protocol: "socks5" };

type Reply = Readonly<{ body: unknown; status?: number }>;
const calls: { body: unknown; method: string; url: string }[] = [];
let replies: Reply[] = [];

function queue(...next: Reply[]) { replies.push(...next); }
const listed = (proxies: readonly ProxyWire[], sharedRows: readonly ProxySharedWire[] = []): Reply => ({ body: { proxies, shared: sharedRows } });
const refused = (error: string, status = 400): Reply => ({ body: { error }, status });
const writes = () => calls.filter((call) => call.method !== "GET");

beforeEach(() => {
  calls.length = 0;
  replies = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ body: typeof init.body === "string" ? JSON.parse(init.body) : undefined, method: init.method ?? "GET", url });
    const reply = replies.shift();
    if (!reply) throw new Error(`Unexpected request ${init.method ?? "GET"} ${url}`);
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

async function renderList(first: Reply, audience: "administrator" | "personal" = "personal") {
  queue(first);
  const view = render(<ProxyListPanel audience={audience} />);
  await waitFor(() => expect(screen.queryByText("Loading proxies…")).toBeNull());
  return view;
}
const openEdit = (name = "Almaty") => fireEvent.click(screen.getByRole("button", { name: `Edit ${name}` }));
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save proxy" }));

describe("proxyFailureMessage", () => {
  const codes = [...PROXY_ADDRESS_FAILURE_CODES, ...PROXY_CONNECTION_FAILURE_CODES, ...PROXY_INPUT_FAILURE_CODES, ...PROXY_CHANGE_FAILURE_CODES];

  it("words every stable code on its own", () => {
    const unknown = proxyFailureMessage("not_a_code");
    for (const code of codes) {
      expect(proxyFailureMessage(code), code).not.toBe(unknown);
      expect(proxyFailureMessage(code), code).not.toContain(code);
    }
    expect(new Set(codes.map(proxyFailureMessage)).size).toBe(new Set(codes).size);
  });

  it("does not read a response's code through the prototype", () => {
    expect(proxyFailureMessage("constructor")).toBe(proxyFailureMessage("not_a_code"));
  });
});

describe("ProxyListPanel", () => {
  it("says loading, then empty", async () => {
    queue(listed([]));
    render(<ProxyListPanel audience="personal" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading proxies…");
    expect(await screen.findByText(/No proxies yet/)).toBeVisible();
  });

  it("shows a failed load as a failure with a way back, never as an empty list", async () => {
    await renderList(refused("proxy_unavailable", 503));
    expect(screen.getByRole("alert")).toHaveTextContent("could not be loaded");
    expect(screen.queryByText(/No proxies yet/)).toBeNull();
    expect(screen.getByRole("button", { name: "Add proxy" })).toBeDisabled();
    queue(listed([proxy]));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Almaty" })).toBeVisible();
  });

  it("refuses a malformed response visibly", async () => {
    await renderList({ body: { proxies: [{ ...proxy, port: "8080" }], shared: [] } });
    expect(screen.getByRole("alert")).toHaveTextContent("unexpected answer");
  });

  it("shows a member an administrator proxy by name, with nothing to act on", async () => {
    await renderList(listed([], [shared]));
    const list = screen.getByRole("list", { name: "Proxies from your administrators" });
    expect(within(list).getByRole("heading", { name: "Berlin office" })).toBeVisible();
    expect(within(list).queryAllByRole("button")).toHaveLength(0);
    expect(within(list).queryByRole("switch")).toBeNull();
  });

  it("keeps the administrator list on the administrator routes", async () => {
    await renderList({ body: { proxies: [{ ...proxy, owner: "administrator" }] } }, "administrator");
    expect(calls[0]?.url).toBe(PROXY_ROUTES.administrator);
    queue({ body: { proxy: { ...proxy, active: false, owner: "administrator", version: 4 } } });
    fireEvent.click(screen.getByRole("switch", { name: "Use Almaty" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Use Almaty" })).toHaveAttribute("aria-checked", "false"));
    expect(writes()[0]).toEqual({ body: { active: false, expectedVersion: 3 }, method: "PATCH", url: PROXY_ROUTES.administratorItem(PROXY_ID) });
  });

  it("adds a proxy with hints as plain text, then focuses its row", async () => {
    await renderList(listed([]));
    fireEvent.click(screen.getByRole("button", { name: "Add proxy" }));
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveFocus());
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: " Almaty " } });
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "proxy.example.com" } });
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "8080" } });
    fireEvent.change(screen.getByLabelText("Domain hints (optional)"), { target: { value: ".kz\nozon.ru, wb.ru" } });
    queue({ body: { proxy }, status: 201 });
    save();
    const heading = await screen.findByRole("heading", { name: "Almaty" });
    expect(writes()[0]?.body).toEqual({ domainHints: [".kz", "ozon.ru", "wb.ru"], host: "proxy.example.com", name: "Almaty", port: 8080, protocol: "http" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByRole("status")).toHaveTextContent("Proxy saved");
  });

  it("refuses a port that is no port without asking the server", async () => {
    await renderList(listed([proxy]));
    openEdit();
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "70000" } });
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent("from 1 to 65535");
    expect(writes()).toHaveLength(0);
  });

  it.each([
    "proxy_country_invalid", "proxy_hint_invalid", "proxy_host_invalid", "proxy_input_invalid", "proxy_login_invalid", "proxy_name_invalid",
    "proxy_password_invalid", "proxy_port_invalid", "proxy_protocol_invalid", "proxy_address_forbidden", "proxy_dns_failed",
    "proxy_address_check_unavailable", "proxy_limit", "proxy_name_taken"
  ])("shows why a save was refused (%s) in the form and keeps the draft", async (code) => {
    await renderList(listed([proxy]));
    openEdit();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed" } });
    queue(refused(code));
    save();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(proxyFailureMessage(code));
    await waitFor(() => expect(alert).toHaveFocus());
    expect(screen.getByLabelText("Name")).toHaveValue("Renamed");
  });

  describe("the password", () => {
    it("starts empty, and an empty field keeps the stored one", async () => {
      await renderList(listed([proxy]));
      openEdit();
      expect(screen.getByLabelText("New password")).toHaveValue("");
      expect(screen.getByText("A password is stored. Leave the field empty to keep it.")).toBeVisible();
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed" } });
      queue({ body: { proxy: { ...proxy, name: "Renamed", version: 4 } } });
      save();
      await screen.findByRole("heading", { name: "Renamed" });
      expect(writes()[0]?.body).toEqual({ expectedVersion: 3, name: "Renamed" });
    });

    it("replaces it with what was typed", async () => {
      await renderList(listed([proxy]));
      openEdit();
      fireEvent.change(screen.getByLabelText("New password"), { target: { value: "synthetic-new" } });
      queue({ body: { proxy: { ...proxy, version: 4 } } });
      save();
      await screen.findByRole("heading", { name: "Almaty" });
      expect(writes()[0]?.body).toEqual({ expectedVersion: 3, password: "synthetic-new" });
    });

    it("clears it only on the explicit removal, and the choice can be taken back", async () => {
      await renderList(listed([proxy]));
      openEdit();
      fireEvent.click(screen.getByRole("button", { name: "Remove stored password" }));
      expect(screen.getByLabelText("New password")).toBeDisabled();
      expect(screen.getByText("The stored password will be removed when you save.")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Keep stored password" }));
      expect(screen.getByLabelText("New password")).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Remove stored password" }));
      queue({ body: { proxy: { ...proxy, hasPassword: false, version: 4 } } });
      save();
      await screen.findByRole("heading", { name: "Almaty" });
      expect(writes()[0]?.body).toEqual({ expectedVersion: 3, password: null });
    });

    it("says where the address is edited that the stored password goes to a new address", async () => {
      await renderList(listed([proxy]));
      openEdit();
      const note = "Changing the address keeps the stored password, and the password then goes to the new address.";
      expect(screen.getByText(note)).toBeVisible();
      fireEvent.change(screen.getByLabelText("Host"), { target: { value: "other.example.com" } });
      expect(screen.getByText(note)).toHaveClass("text-caution");
      queue({ body: { proxy: { ...proxy, host: "other.example.com", version: 4 } } });
      save();
      await screen.findByRole("heading", { name: "Almaty" });
      expect(writes()[0]?.body).toEqual({ expectedVersion: 3, host: "other.example.com" });
    });

    it("has nothing to keep on a proxy without one", async () => {
      await renderList(listed([{ ...proxy, hasPassword: false }]));
      openEdit();
      expect(screen.getByText("No password is stored.")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Remove stored password" })).toBeNull();
      expect(screen.queryByText(/Changing the address keeps/)).toBeNull();
    });
  });

  it("saves nothing when nothing changed", async () => {
    await renderList(listed([proxy]));
    openEdit();
    save();
    expect(await screen.findByRole("heading", { name: "Almaty" })).toBeVisible();
    expect(writes()).toHaveLength(0);
  });

  it("on a version conflict reloads the row, keeps what was typed and saves against the latest version", async () => {
    await renderList(listed([proxy]));
    openEdit();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Mine" } });
    queue(refused("proxy_conflict", 409), listed([{ ...proxy, host: "moved.example.com", name: "Theirs", version: 7 }]));
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent("changed somewhere else");
    expect(screen.getByLabelText("Host")).toHaveValue("moved.example.com");
    expect(screen.getByLabelText("Name")).toHaveValue("Mine");
    queue({ body: { proxy: { ...proxy, host: "moved.example.com", name: "Mine", version: 8 } } });
    save();
    await screen.findByRole("heading", { name: "Mine" });
    expect(writes().at(-1)?.body).toEqual({ expectedVersion: 7, name: "Mine" });
  });

  it("closes the form when the proxy is gone", async () => {
    await renderList(listed([proxy]));
    openEdit();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Mine" } });
    queue(refused("proxy_not_found", 404), listed([]));
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent("“Almaty” no longer exists. Nothing was saved.");
    expect(screen.queryByLabelText("Name")).toBeNull();
  });

  it("reloads a row whose switch lost a race, and says so", async () => {
    await renderList(listed([proxy]));
    queue(refused("proxy_conflict", 409), listed([{ ...proxy, name: "Almaty 2", version: 5 }]));
    fireEvent.click(screen.getByRole("switch", { name: "Use Almaty" }));
    expect(await screen.findByRole("heading", { name: "Almaty 2" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("so the switch was not changed");
  });

  describe("the check", () => {
    it("shows the exit address and updates the row", async () => {
      await renderList(listed([proxy]));
      const check = { checkedAt: "2026-11-01T10:00:00.000Z", exitAddress: "203.0.113.7", status: "ok" };
      queue({ body: { check, proxy: { ...proxy, lastCheck: check } } });
      fireEvent.click(screen.getByRole("button", { name: "Check Almaty" }));
      expect(await screen.findByText(/Works\. Sites see 203\.0\.113\.7\./)).toBeVisible();
      expect(writes()[0]).toMatchObject({ method: "POST", url: PROXY_ROUTES.personalCheck(PROXY_ID) });
    });

    it.each([...PROXY_ADDRESS_FAILURE_CODES, ...PROXY_CONNECTION_FAILURE_CODES])("explains %s", async (status) => {
      await renderList(listed([proxy]));
      const check = { checkedAt: "2026-11-01T10:00:00.000Z", exitAddress: null, status };
      queue({ body: { check, proxy: { ...proxy, lastCheck: check } } });
      fireEvent.click(screen.getByRole("button", { name: "Check Almaty" }));
      expect(await screen.findByText(new RegExp(proxyFailureMessage(status).slice(0, 24).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")))).toHaveClass("text-critical");
    });

    it("shows the saved result of an earlier check after a reload", async () => {
      await renderList(listed([{ ...proxy, lastCheck: { checkedAt: "2026-11-01T10:00:00.000Z", exitAddress: null, status: "proxy_timeout" } }]));
      expect(screen.getByText(/did not answer in time/)).toBeVisible();
    });

    it("never brings back an older row when the proxy changed during the check", async () => {
      await renderList(listed([proxy]));
      let finish: (response: Response) => void = () => undefined;
      vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      fireEvent.click(screen.getByRole("button", { name: "Check Almaty" }));
      expect(await screen.findByText("Checking…")).toBeVisible();
      const check = { checkedAt: "2026-11-01T10:00:00.000Z", exitAddress: "203.0.113.7", status: "ok" };
      await act(async () => finish(new Response(JSON.stringify({ check, proxy: { ...proxy, lastCheck: null, name: "Newer", version: 4 } }))));
      expect(await screen.findByRole("heading", { name: "Newer" })).toBeVisible();
      expect(screen.getByRole("alert")).toHaveTextContent("changed during the check");
    });
  });

  describe("deleting", () => {
    it("names the target and consequences, and keeping it returns focus", async () => {
      await renderList(listed([proxy]));
      fireEvent.click(screen.getByRole("button", { name: "Delete Almaty" }));
      const group = screen.getByRole("group", { name: "Delete Almaty" });
      expect(group).toHaveTextContent("Delete “Almaty”? Your chats lose it at once. This cannot be undone.");
      const keep = within(group).getByRole("button", { name: "Keep proxy" });
      await waitFor(() => expect(keep).toHaveFocus());
      fireEvent.keyDown(keep, { key: "Escape" });
      await waitFor(() => expect(screen.getByRole("button", { name: "Delete Almaty" })).toHaveFocus());
      expect(writes()).toHaveLength(0);
    });

    it("sends the version it showed and leaves focus on Add", async () => {
      await renderList(listed([proxy]));
      fireEvent.click(screen.getByRole("button", { name: "Delete Almaty" }));
      queue({ body: { ok: true } });
      fireEvent.click(screen.getByRole("button", { name: "Delete proxy" }));
      expect(await screen.findByText("Proxy deleted.")).toBeVisible();
      expect(writes()[0]).toEqual({ body: { expectedVersion: 3 }, method: "DELETE", url: PROXY_ROUTES.personalItem(PROXY_ID) });
      await waitFor(() => expect(screen.getByRole("button", { name: "Add proxy" })).toHaveFocus());
    });

    it("does not delete a row that changed", async () => {
      await renderList(listed([proxy]));
      fireEvent.click(screen.getByRole("button", { name: "Delete Almaty" }));
      queue(refused("proxy_conflict", 409), listed([{ ...proxy, version: 9 }]));
      fireEvent.click(screen.getByRole("button", { name: "Delete proxy" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("so it was not deleted");
      expect(screen.getByRole("heading", { name: "Almaty" })).toBeVisible();
    });
  });

  describe("leaving the form", () => {
    it("returns focus to the opener, and Escape stays inside the form", async () => {
      const outer = vi.fn();
      queue(listed([proxy]));
      render(<div onKeyDown={outer}><ProxyListPanel audience="personal" /></div>);
      fireEvent.click(await screen.findByRole("button", { name: "Edit Almaty" }));
      await waitFor(() => expect(screen.getByLabelText("Name")).toHaveFocus());
      fireEvent.keyDown(screen.getByLabelText("Name"), { key: "Escape" });
      expect(outer).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.getByRole("button", { name: "Edit Almaty" })).toHaveFocus());
    });

    it("asks before dropping typed changes", async () => {
      const dirty = vi.fn();
      queue(listed([proxy]));
      render(<ProxyListPanel audience="personal" onDirtyChange={dirty} />);
      fireEvent.click(await screen.findByRole("button", { name: "Edit Almaty" }));
      fireEvent.change(screen.getByLabelText("New password"), { target: { value: "synthetic-typed" } });
      expect(dirty).toHaveBeenLastCalledWith(true);
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Keep editing" })).toHaveFocus());
      fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
      expect(screen.getByLabelText("New password")).toHaveValue("synthetic-typed");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
      expect(screen.queryByLabelText("New password")).toBeNull();
      expect(dirty).toHaveBeenLastCalledWith(false);
    });
  });

  it("stops new proxies at the limit, and says why", async () => {
    await renderList(listed(Array.from({ length: 50 }, (_, index) => ({ ...proxy, id: `row-${index}`, name: `Proxy ${index}` }))));
    expect(screen.getByRole("button", { name: "Add proxy" })).toBeDisabled();
    expect(screen.getByText(proxyFailureMessage("proxy_limit"))).toBeVisible();
  });
});
