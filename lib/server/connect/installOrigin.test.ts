import { afterEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({ appBaseUrl: "https://ai.example.com/" }));
vi.mock("../auth/config", () => ({ getAuthConfig: () => ({ appBaseUrl: config.appBaseUrl, configured: true }) }));

import { connectInstallOrigin } from "./installOrigin";

afterEach(() => {
  config.appBaseUrl = "https://ai.example.com/";
});

describe("connectInstallOrigin", () => {
  it("names the installation's origin, as install.sh does", () => {
    expect(connectInstallOrigin()).toBe("https://ai.example.com");
    config.appBaseUrl = "http://192.168.1.20:3000/app";
    expect(connectInstallOrigin()).toBe("http://192.168.1.20:3000");
  });

  it.each(["https://user:secret@ai.example.com/", "https://ai.example.com/?next=1", "ftp://ai.example.com", "not a url"])(
    "is not known for %s",
    (appBaseUrl) => {
      config.appBaseUrl = appBaseUrl;
      expect(connectInstallOrigin()).toBeNull();
    }
  );
});
