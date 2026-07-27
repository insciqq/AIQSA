import { describe, expect, it } from "vitest";
import {
  CLIENT_SESSION_EXPIRED_CODE,
  clientSessionErrorFromStatus
} from "./http";

describe("client HTTP session failures", () => {
  it("maps only HTTP 401 to the session-expired client signal", () => {
    expect(clientSessionErrorFromStatus(401)).toBe(CLIENT_SESSION_EXPIRED_CODE);
    expect(clientSessionErrorFromStatus(403)).toBeNull();
    expect(clientSessionErrorFromStatus(500)).toBeNull();
  });
});
