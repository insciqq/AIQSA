import { act, renderHook, waitFor } from "@testing-library/react";
import { useAdminFeedback } from "@/components/admin/useAdminFeedback";
import { describe, expect, it, vi } from "vitest";
import {
  useAdminOneTimeInviteLink,
  type AdminClipboardWriter
} from "./useAdminOneTimeInviteLink";

function useInviteLinkHarness(writeText: AdminClipboardWriter) {
  const feedback = useAdminFeedback();
  const inviteLink = useAdminOneTimeInviteLink({ feedback, writeText });

  return { feedback, inviteLink };
}

function deferred<T>() {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });

  return { promise, reject, resolve };
}

describe("useAdminOneTimeInviteLink", () => {
  it("reveals and copies the ephemeral link without storing it in dashboard data", async () => {
    const writeText = vi.fn<AdminClipboardWriter>().mockResolvedValue(undefined);
    const { result } = renderHook(() => useInviteLinkHarness(writeText));
    const url = "https://aiqsa.example/login?invite=one-time-token";

    act(() => result.current.inviteLink.revealOneTimeUrl(url));
    expect(result.current.inviteLink.oneTimeUrl).toBe(url);
    expect(result.current.inviteLink.oneTimeUrlCopied).toBe(false);

    await act(async () => {
      await result.current.inviteLink.copyOneTimeUrl();
    });

    expect(writeText).toHaveBeenCalledWith(url);
    expect(result.current.inviteLink.oneTimeUrlCopied).toBe(true);
    expect(result.current.feedback).toMatchObject({
      error: null,
      notice: "Invite link copied."
    });
  });

  it("clears a copy failure when retry succeeds and keeps the URL available", async () => {
    const writeText = vi
      .fn<AdminClipboardWriter>()
      .mockRejectedValueOnce(new Error("blocked"))
      .mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useInviteLinkHarness(writeText));
    const url = "https://aiqsa.example/login?invite=retry-token";

    act(() => result.current.inviteLink.revealOneTimeUrl(url));
    await act(async () => {
      await result.current.inviteLink.copyOneTimeUrl();
    });
    expect(result.current.feedback.error).toMatch(/could not be copied/i);
    expect(result.current.inviteLink.oneTimeUrlCopied).toBe(false);

    await act(async () => {
      await result.current.inviteLink.copyOneTimeUrl();
    });
    await waitFor(() => expect(result.current.feedback.error).toBeNull());
    expect(result.current.feedback.notice).toBe("Invite link copied.");
    expect(result.current.inviteLink.oneTimeUrl).toBe(url);
    expect(result.current.inviteLink.oneTimeUrlCopied).toBe(true);
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("does not clear feedback without a URL and resets copied state only when a new success is revealed", async () => {
    const writeText = vi.fn<AdminClipboardWriter>().mockResolvedValue(undefined);
    const { result } = renderHook(() => useInviteLinkHarness(writeText));

    act(() => result.current.feedback.reportError("Existing error."));
    await act(async () => {
      await result.current.inviteLink.copyOneTimeUrl();
    });
    expect(result.current.feedback.error).toBe("Existing error.");
    expect(writeText).not.toHaveBeenCalled();

    act(() => result.current.inviteLink.revealOneTimeUrl("https://aiqsa.example/invite/first"));
    await act(async () => result.current.inviteLink.copyOneTimeUrl());
    expect(result.current.inviteLink.oneTimeUrlCopied).toBe(true);

    act(() => result.current.inviteLink.revealOneTimeUrl(null));
    expect(result.current.inviteLink.oneTimeUrl).toBeNull();
    expect(result.current.inviteLink.oneTimeUrlCopied).toBe(false);
  });

  it("ignores a copy completion after a newer invite URL is revealed", async () => {
    const firstCopy = deferred<void>();
    const writeText = vi.fn<AdminClipboardWriter>().mockReturnValue(firstCopy.promise);
    const { result } = renderHook(() => useInviteLinkHarness(writeText));
    const firstUrl = "https://aiqsa.example/invite/first";
    const secondUrl = "https://aiqsa.example/invite/second";
    act(() => result.current.inviteLink.revealOneTimeUrl(firstUrl));

    let copyPromise!: Promise<void>;
    act(() => {
      copyPromise = result.current.inviteLink.copyOneTimeUrl();
    });
    act(() => result.current.inviteLink.revealOneTimeUrl(secondUrl));
    firstCopy.resolve(undefined);
    await act(async () => copyPromise);

    expect(result.current.inviteLink.oneTimeUrl).toBe(secondUrl);
    expect(result.current.inviteLink.oneTimeUrlCopied).toBe(false);
    expect(result.current.feedback.notice).toBeNull();
  });

  it("lets only the latest overlapping copy attempt commit feedback", async () => {
    const firstCopy = deferred<void>();
    const secondCopy = deferred<void>();
    const writeText = vi
      .fn<AdminClipboardWriter>()
      .mockReturnValueOnce(firstCopy.promise)
      .mockReturnValueOnce(secondCopy.promise);
    const { result } = renderHook(() => useInviteLinkHarness(writeText));
    act(() => result.current.inviteLink.revealOneTimeUrl("https://aiqsa.example/invite/current"));

    let firstPromise!: Promise<void>;
    let secondPromise!: Promise<void>;
    act(() => {
      firstPromise = result.current.inviteLink.copyOneTimeUrl();
      secondPromise = result.current.inviteLink.copyOneTimeUrl();
    });
    secondCopy.resolve(undefined);
    await act(async () => secondPromise);
    firstCopy.reject(new Error("late clipboard failure"));
    await act(async () => firstPromise);

    expect(result.current.inviteLink.oneTimeUrlCopied).toBe(true);
    expect(result.current.feedback).toMatchObject({
      error: null,
      notice: "Invite link copied."
    });
  });
});
