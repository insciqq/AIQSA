import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { browserSignInRequestText } from "@/lib/contracts/browserSignIn";
import type { ThreadToolActivity } from "@/lib/contracts/chats";
import { BrowserSignInAgainRowsV2, BrowserSignInTurnV2, browserSignInAgainRows } from "./BrowserSignInAgainV2";

const handoff = (host: string, outcome: "cancelled" | "completed" | "not_answered" | "timed_out") =>
  ({ browserHandoff: { host, outcome }, round: 1, status: "complete" as const, toolName: "browser_handoff" });

describe("Sign in again under an answer", () => {
  it("lists each site a sign-in handoff ended on without the user, worded by how its last one ended", () => {
    const activity: ThreadToolActivity = { calls: [
      handoff("mail.example.com", "not_answered"), { round: 1, status: "complete", toolName: "fetch_url" },
      handoff("portal.example.org", "timed_out"), handoff("shop.example", "cancelled"),
      // Done later: that site needs nothing.
      handoff("bank.example", "not_answered"), handoff("bank.example", "completed"),
      handoff("mail.example.com", "timed_out")
    ] };
    expect(browserSignInAgainRows(activity)).toEqual([
      { host: "mail.example.com", text: "Signing in to mail.example.com was not finished." },
      { host: "portal.example.org", text: "Signing in to portal.example.org was not finished." },
      { host: "shop.example", text: "Signing in to shop.example was cancelled." }
    ]);
    expect(browserSignInAgainRows({ calls: [handoff("mail.example.com", "not_answered")] }))
      .toEqual([{ host: "mail.example.com", text: "mail.example.com waited for you to sign in." }]);
    expect(browserSignInAgainRows(null)).toEqual([]);
  });

  it("sends the request for the site pressed, once, and shows nothing without a way to send it", async () => {
    let finish!: () => void;
    const onSignIn = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const activity: ThreadToolActivity = { calls: [handoff("mail.example.com", "not_answered"), handoff("shop.example", "cancelled")] };
    const { rerender } = render(<BrowserSignInAgainRowsV2 disabled={false} toolActivity={activity} onSignIn={onSignIn} />);
    const section = screen.getByRole("region", { name: "Sign in again" });
    expect(within(section).getByText("mail.example.com waited for you to sign in.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Sign in again to mail.example.com" }));
    expect(onSignIn).toHaveBeenCalledExactlyOnceWith("mail.example.com");
    expect((screen.getByRole("button", { name: "Sign in again to shop.example" }) as HTMLButtonElement).disabled).toBe(true);
    finish();
    await vi.waitFor(() => expect((screen.getByRole("button", { name: "Sign in again to shop.example" }) as HTMLButtonElement).disabled)
      .toBe(false));

    rerender(<BrowserSignInAgainRowsV2 disabled toolActivity={activity} onSignIn={onSignIn} />);
    expect((screen.getByRole("button", { name: "Sign in again to mail.example.com" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<BrowserSignInAgainRowsV2 disabled={false} toolActivity={activity} onSignIn={undefined} />);
    expect(screen.queryByRole("region", { name: "Sign in again" })).toBeNull();
  });

  it("shows the server-written request as a chip naming the site, never the request's words", () => {
    render(<BrowserSignInTurnV2 anchorId="message-1" content={browserSignInRequestText("mail.example.com")} />);
    const turn = screen.getByRole("article", { name: "Sign in again" });
    expect(turn.textContent).toBe("Sign in again: mail.example.com");
    expect(turn.getAttribute("data-system-turn")).toBe("browser_sign_in_request");
  });
});
