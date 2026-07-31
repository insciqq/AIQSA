import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAdminReleaseStatus } from "./useAdminReleaseStatus";

const { requestAdminReleaseStatus } = vi.hoisted(() => ({
  requestAdminReleaseStatus: vi.fn()
}));

vi.mock("@/components/admin/adminReleaseApi", () => ({
  requestAdminReleaseStatus
}));

const updateStatus = {
  checkedAt: "2026-07-31T13:00:00.000Z",
  currentVersion: "0.1.12",
  latestVersion: "0.2.0",
  publishedAt: "2026-07-31T12:00:00.000Z",
  releaseUrl: "https://github.com/insciqq/AIQSA/releases/tag/v0.2.0",
  state: "update_available" as const
};

describe("useAdminReleaseStatus", () => {
  beforeEach(() => {
    requestAdminReleaseStatus.mockReset();
  });

  it("waits for the dashboard and refreshes alongside its successful snapshots", async () => {
    requestAdminReleaseStatus.mockResolvedValue({ ok: true, status: updateStatus });
    const { rerender, result } = renderHook(
      ({ refreshKey }) => useAdminReleaseStatus(refreshKey),
      { initialProps: { refreshKey: null as number | null } }
    );

    expect(result.current).toBeNull();
    expect(requestAdminReleaseStatus).not.toHaveBeenCalled();

    rerender({ refreshKey: 1 });
    await waitFor(() => expect(result.current).toEqual(updateStatus));
    expect(requestAdminReleaseStatus).toHaveBeenCalledOnce();

    rerender({ refreshKey: 2 });
    await waitFor(() => expect(requestAdminReleaseStatus).toHaveBeenCalledTimes(2));
  });

  it("leaves the Control Center usable when the release check fails", async () => {
    requestAdminReleaseStatus.mockResolvedValue({ ok: false });
    const { result } = renderHook(() => useAdminReleaseStatus(1));

    await waitFor(() => expect(requestAdminReleaseStatus).toHaveBeenCalledOnce());
    expect(result.current).toBeNull();
  });
});
