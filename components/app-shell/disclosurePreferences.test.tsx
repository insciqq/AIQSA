import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDisclosurePreferences, DisclosurePreferencesProvider, useDisclosurePreference } from "./disclosurePreferences";

beforeEach(() => localStorage.clear());
function Folder() {
  const [open, setOpen] = useDisclosurePreference("folder:example", true);
  return <button aria-expanded={open} onClick={() => setOpen(value => !value)}>Folder</button>;
}
describe("Account disclosure preferences", () => {
  it("survives remount and reload without crossing accounts", () => {
    const first = render(<DisclosurePreferencesProvider accountId="a"><Folder /></DisclosurePreferencesProvider>);
    fireEvent.click(screen.getByRole("button"));
    first.unmount();
    const second = render(<DisclosurePreferencesProvider accountId="a"><Folder /></DisclosurePreferencesProvider>);
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
    second.rerender(<DisclosurePreferencesProvider accountId="b"><Folder /></DisclosurePreferencesProvider>);
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    second.rerender(<DisclosurePreferencesProvider accountId="a"><Folder /></DisclosurePreferencesProvider>);
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
  });
  it("bounds stored choices and isolates Projects, with a usable fallback for blocked storage", () => {
    const store = createDisclosurePreferences("a");
    for (let i = 0; i < 510; i++) store.set(`workspace:${i}`, true);
    expect(store.get("workspace:0", false)).toBe(false);
    expect(createDisclosurePreferences("a").get("workspace:509", false)).toBe(true);
    store.set("project-folder:first:folder", false);
    expect(store.get("project-folder:second:folder", true)).toBe(true);
    const denied = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    store.set("folder:offline", false);
    expect(store.get("folder:offline", true)).toBe(false);
    denied.mockRestore();
  });
});
