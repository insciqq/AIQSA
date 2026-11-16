import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadGeneratedArtifact } from "../../contracts/chats";
import failureCodes from "../observability/failureCodes.json";
import {
  createDiscordArtifactPublisher, discordArtifactLabel, discordArtifactLine, DISCORD_ARTIFACT_LABEL_MAX, DISCORD_ARTIFACT_LINKS_MAX,
  publishDiscordAnswerArtifacts, type DiscordArtifactPublisher
} from "./artifacts";

const logs = vi.hoisted(() => [] as Array<{ event: string; fields: Record<string, unknown> }>);
vi.mock("../observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../observability")>();
  return {
    ...actual,
    logEvent: ((event: string, fields: Record<string, unknown>) => { logs.push({ event, fields }); }) as typeof actual.logEvent
  };
});

afterEach(() => {
  logs.length = 0;
});

const TOKEN = "a".repeat(43);

function artifact(index: number, overrides: Partial<ThreadGeneratedArtifact> = {}): ThreadGeneratedArtifact {
  return {
    artifactId: `artifact_${index}`, entrypoint: "index.html", kind: "html", title: `Page ${index}`, versionId: `version_${index}`, versionNumber: 1,
    ...overrides
  };
}

function urlOf(versionId: string): string {
  return `https://aiqsa.example.com/a/${versionId}-${TOKEN}`;
}

describe("Discord artifact links: publication within the bound", () => {
  it("publishes each version the answer made once, as the service account, in the answer's order", async () => {
    const publish = vi.fn<DiscordArtifactPublisher>(async ({ versionId }) => urlOf(versionId));
    const result = await publishDiscordAnswerArtifacts({
      publish, runId: "run_1", summary: { generatedArtifacts: [artifact(1), artifact(2), artifact(1)] }, userId: "svc_1"
    });
    expect(publish.mock.calls.map(([input]) => input)).toEqual([
      { artifactId: "artifact_1", userId: "svc_1", versionId: "version_1" },
      { artifactId: "artifact_2", userId: "svc_1", versionId: "version_2" }
    ]);
    expect(result).toEqual({ links: [{ title: "Page 1", url: urlOf("version_1") }, { title: "Page 2", url: urlOf("version_2") }], onlyInAiqsa: 0 });
    expect(logs).toEqual([]);
  });

  it("publishes nothing for an answer without artifacts", async () => {
    const publish = vi.fn<DiscordArtifactPublisher>();
    expect(await publishDiscordAnswerArtifacts({ publish, runId: "run_1", summary: null, userId: "svc_1" })).toEqual({ links: [], onlyInAiqsa: 0 });
    expect(publish).not.toHaveBeenCalled();
  });

  it("counts a failed, refused or unusable publication as only in AIQSA, never throws, and logs only a code", async () => {
    const publish = vi.fn<DiscordArtifactPublisher>(async ({ versionId }) => {
      if (versionId === "version_1") throw new Error("synthetic storage failure");
      if (versionId === "version_2") return null;
      if (versionId === "version_3") return "javascript:alert(1)";
      return urlOf(versionId);
    });
    const result = await publishDiscordAnswerArtifacts({
      publish, runId: "run_1", summary: { generatedArtifacts: [artifact(1), artifact(2), artifact(3), artifact(4)] }, userId: "svc_1"
    });
    expect(result).toEqual({ links: [{ title: "Page 4", url: urlOf("version_4") }], onlyInAiqsa: 3 });
    const codes = logs.map((entry) => entry.fields.code);
    expect(codes).toEqual(["discord_artifact_publish_failed", "discord_artifact_publish_failed"]);
    expect(logs.every((entry) => entry.fields.outcome === "degraded" && entry.fields.subsystem === "discord")).toBe(true);
    expect(JSON.stringify(logs)).not.toMatch(/Page|version_|artifact_[0-9]|aiqsa\.example/u);
  });

  it("answers at the bound with the links made by then; a slower publication is not shown", async () => {
    let release!: (url: string) => void;
    const publish = vi.fn<DiscordArtifactPublisher>(async ({ versionId }) => versionId === "version_2"
      ? new Promise<string>((resolve) => { release = resolve; })
      : urlOf(versionId));
    const started = Date.now();
    const result = await publishDiscordAnswerArtifacts({
      publish, runId: "run_1", summary: { generatedArtifacts: [artifact(1), artifact(2)] }, timeoutMs: 30, userId: "svc_1"
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result).toEqual({ links: [{ title: "Page 1", url: urlOf("version_1") }], onlyInAiqsa: 1 });
    expect(logs.map((entry) => entry.fields.code)).toEqual(["discord_artifact_publish_timeout"]);
    release(urlOf("version_2"));
    await Promise.resolve();
    expect(result.links).toHaveLength(1);
  });

  it("publishes only what Discord's buttons can show and counts the rest as only in AIQSA", async () => {
    const publish = vi.fn<DiscordArtifactPublisher>(async ({ versionId }) => urlOf(versionId));
    const generatedArtifacts = Array.from({ length: DISCORD_ARTIFACT_LINKS_MAX + 3 }, (_, index) => artifact(index));
    const result = await publishDiscordAnswerArtifacts({ publish, runId: "run_1", summary: { generatedArtifacts }, userId: "svc_1" });
    expect(publish).toHaveBeenCalledTimes(DISCORD_ARTIFACT_LINKS_MAX);
    expect(result.links).toHaveLength(DISCORD_ARTIFACT_LINKS_MAX);
    expect(result.onlyInAiqsa).toBe(3);
  });

  it("registers its log codes in order among their sorted neighbours", () => {
    const registry = failureCodes as string[];
    for (const code of ["discord_artifact_publish_failed", "discord_artifact_publish_timeout"]) {
      const index = registry.indexOf(code);
      expect(index, code).toBeGreaterThan(0);
      expect(registry[index - 1]! < code && code < registry[index + 1]!, code).toBe(true);
    }
  });
});

describe("Discord artifact links: labels and lines", () => {
  it("labels a button Open <title>, its secrets redacted and its invisible characters gone", () => {
    expect(discordArtifactLabel("Quarterly‮ report\n\tdraft")).toEqual({ label: "Open Quarterly report draft", redactions: 0 });
    const secret = discordArtifactLabel("Deploy DB_PASSWORD=hunter2-hunter2-hunter2");
    expect(secret.label).not.toContain("hunter2");
    expect(secret.label).toContain("[redacted]");
    expect(secret.redactions).toBe(1);
    expect(discordArtifactLabel(" ​ ")).toEqual({ label: "Open artifact", redactions: 0 });
  });

  it("cuts a long title to Discord's 80-character label, never inside a surrogate pair, and redacts before it cuts", () => {
    const long = discordArtifactLabel(`${"x".repeat(70)}😀😀😀😀😀😀`);
    expect(long.label.length).toBeLessThanOrEqual(DISCORD_ARTIFACT_LABEL_MAX);
    expect(long.label.endsWith("…")).toBe(true);
    expect(long.label).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u);
    // A secret past the cut is still recognized whole, so no part of it shows.
    const cut = discordArtifactLabel(`${"word ".repeat(12)}api_key=sk-live-abcdefghijklmnopqrstuvwxyz0123456789`);
    expect(cut.label.length).toBeLessThanOrEqual(DISCORD_ARTIFACT_LABEL_MAX);
    expect(cut.label).not.toMatch(/sk-live|abcdef/u);
  });

  it("writes a plain-http link as a line with its title escaped and redacted and its preview suppressed", () => {
    const line = discordArtifactLine("**Bold** <@123> TOKEN=abcdefghijklmnopqrstuvwxyz012345", "http://localhost:3000/a/token");
    expect(line.content).toMatch(/^Open .*: <http:\/\/localhost:3000\/a\/token>$/u);
    expect(line.content).not.toMatch(/<@123>|abcdefghijklmnop/u);
    expect(line.content).toContain("\\*\\*Bold\\*\\*");
    expect(line.redactions).toBeGreaterThanOrEqual(1);
  });
});

describe("Discord artifact links: the bridge's publisher", () => {
  function publisher(options: Readonly<{ allowed?: boolean; publicPath?: string; fail?: boolean; base?: string }> = {}) {
    const service = {
      publish: vi.fn(async (_input: Readonly<{ artifactId: string; ownerUserId: string; versionId: string }>) => {
        if (options.fail) throw new Error("synthetic publish failure");
        return { publicPath: options.publicPath ?? `/a/${TOKEN}` };
      })
    };
    const allowed = vi.fn(async (_userId: string) => options.allowed ?? true);
    const publish = createDiscordArtifactPublisher({
      allowed, load: async () => ({ appBaseUrl: () => options.base ?? "https://aiqsa.example.com/app", service })
    });
    return { allowed, publish, service };
  }

  it("publishes as the owning service account with no expiry and links it on the installation's address", async () => {
    const p = publisher();
    expect(await p.publish({ artifactId: "artifact_1", userId: "svc_1", versionId: "version_1" })).toBe(`https://aiqsa.example.com/a/${TOKEN}`);
    expect(p.allowed).toHaveBeenCalledWith("svc_1");
    expect(p.service.publish).toHaveBeenCalledExactlyOnceWith({ artifactId: "artifact_1", ownerUserId: "svc_1", versionId: "version_1" });
    expect(p.service.publish.mock.calls[0]![0]).not.toHaveProperty("expiresAt");
  });

  it("publishes nothing for an account that is no longer the bot's service account", async () => {
    const p = publisher({ allowed: false });
    expect(await p.publish({ artifactId: "artifact_1", userId: "svc_1", versionId: "version_1" })).toBeNull();
    expect(p.service.publish).not.toHaveBeenCalled();
  });

  it("refuses a public path that is not an artifact link", async () => {
    const p = publisher({ publicPath: "//evil.example.com/a/x" });
    expect(await p.publish({ artifactId: "artifact_1", userId: "svc_1", versionId: "version_1" })).toBeNull();
  });

  it("repeats the link it made for a retried delivery instead of publishing the version again", async () => {
    const p = publisher();
    const input = { artifactId: "artifact_1", userId: "svc_1", versionId: "version_1" };
    const [first, second] = await Promise.all([p.publish(input), p.publish(input)]);
    const third = await p.publish(input);
    expect(new Set([first, second, third]).size).toBe(1);
    expect(p.service.publish).toHaveBeenCalledTimes(1);
  });

  it("tries a failed publication again with a later delivery", async () => {
    const p = publisher({ fail: true });
    const input = { artifactId: "artifact_1", userId: "svc_1", versionId: "version_1" };
    await expect(p.publish(input)).rejects.toThrow("synthetic publish failure");
    await expect(p.publish(input)).rejects.toThrow("synthetic publish failure");
    expect(p.service.publish).toHaveBeenCalledTimes(2);
  });
});
