import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminSectionTopbarProvider } from "@/components/admin/AdminShell";
import { PROXY_ROUTES } from "@/lib/contracts/proxies";
import { AdminProxiesSection } from "./AdminProxiesSection";

afterEach(() => vi.unstubAllGlobals());

describe("AdminProxiesSection", () => {
  it("names the section in the topbar and lists the administrators' proxies from their route", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ proxies: [] })));
    vi.stubGlobal("fetch", fetchMock);
    const setTopbar = vi.fn();
    render(<AdminSectionTopbarProvider value={setTopbar}><AdminProxiesSection /></AdminSectionTopbarProvider>);
    expect(await screen.findByText("No proxies for everyone yet.")).toBeVisible();
    expect(fetchMock.mock.calls[0]).toEqual([PROXY_ROUTES.administrator, expect.anything()]);
    expect(setTopbar).toHaveBeenCalledWith(expect.objectContaining({ title: "Proxies" }));
  });
});
