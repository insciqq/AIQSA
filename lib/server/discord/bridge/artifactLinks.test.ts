import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeDiscord, type FakeDiscord, type FakeDiscordMessage } from "@/tests/support/fakeDiscord";
import type { ThreadGeneratedArtifact } from "../../../contracts/chats";
import type { ConnectorRunGateway } from "../../connectors/runGateway";
import { createDiscordChannelDirectory, createDiscordMembership, discordChannelInfo } from "../access";
import type { DiscordArtifactPublisher } from "../artifacts";
import type { DiscordEffectiveControl } from "../control/state";
import { DISCORD_COPY } from "../copy";
import { createDiscordHandlerRegistry, createDiscordIntake } from "../intake";
import { createDiscordRest } from "../rest";
import { composeDiscordAnswer } from "./answer";
import {
  createFakeDiscordRunGateway, createMemoryDiscordConversationStore, createMemoryDiscordLimitStore, createMemoryDiscordReplyStore,
  createMemoryDiscordRunFacts, type FakeRunFinish
} from "./bridge.testFixtures";
import { createDiscordBridge } from "./index";

/**
 * The artifacts a Discord answer made, linked under it (operator decision 2026-11-16): through the bridge with the
 * fake Discord, which refuses a message with a button Discord would refuse, and through the composer at Discord's
 * button limits.
 */

const logs = vi.hoisted(() => [] as Array<{ event: string; fields: Record<string, unknown> }>);
vi.mock("../../observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../observability")>();
  return {
    ...actual,
    logEvent: ((event: string, fields: Record<string, unknown>) => { logs.push({ event, fields }); }) as typeof actual.logEvent
  };
});

afterEach(() => {
  logs.length = 0;
});

const SHARE_URL = "https://aiqsa.example.com/s/synthetic-share-token";
const TOKEN = "b".repeat(43);

function artifact(index: number, overrides: Partial<ThreadGeneratedArtifact> = {}): ThreadGeneratedArtifact {
  return {
    artifactId: `artifact_${index}`, entrypoint: "index.html", kind: "html", title: `Report ${index}`, versionId: `version_${index}`, versionNumber: 1,
    ...overrides
  };
}

function controlFor(fake: FakeDiscord): DiscordEffectiveControl {
  return {
    assistantId: "assistant_1",
    bot: { applicationId: fake.application.id, generation: 1, roleId: fake.botRoleId, token: fake.token, userId: fake.bot.id, username: fake.bot.username },
    callNames: [], channelIds: new Set(), channelMode: "all_except", dmEnabled: true, enabled: true,
    enabledAt: new Date("2026-11-12T08:00:00.000Z"), guildId: fake.guild.id,
    limits: { parallelThreads: 16, perAuthorDaily: 100, perAuthorHourly: 20, perThreadHourly: 60 },
    serviceUserId: "svc_1", session: null, testAuthorIds: new Set(), testChannelIds: new Set(), tokenState: "ready", version: 3
  };
}

function harness(options: Readonly<{
  finish?: FakeRunFinish;
  /** The artifacts each run's answer made, by run id. */
  artifacts: (runId: string) => ThreadGeneratedArtifact[];
  publish?: DiscordArtifactPublisher;
  timeoutMs?: number;
}>) {
  const fake = createFakeDiscord();
  const clock = { latest: Date.parse("2026-11-12T09:00:00.000Z") };
  const now = () => clock.latest + 500;
  const rest = createDiscordRest({ authorize: () => true, token: () => fake.token, transport: fake.transport });
  const replies = createMemoryDiscordReplyStore();
  const conversations = createMemoryDiscordConversationStore();
  const runs = createFakeDiscordRunGateway({ autoFinish: () => options.finish ?? { text: "Here is the page." } });
  // The persisted answer as the run gateway serves it, with the versions the run made.
  const gateway: ConnectorRunGateway = {
    ...runs.gateway,
    async answer(input) {
      const answer = await runs.gateway.answer(input);
      if (!answer?.artifactSummary) return answer;
      return { ...answer, artifactSummary: { ...answer.artifactSummary, generatedArtifacts: options.artifacts(input.runId) } };
    }
  };
  const publish = vi.fn<DiscordArtifactPublisher>(options.publish ?? (async ({ versionId }) => `https://aiqsa.example.com/a/${versionId}${TOKEN}`));
  const control = controlFor(fake);
  const registry = createDiscordHandlerRegistry();
  const directory = createDiscordChannelDirectory();
  for (const id of Object.values(fake.channels)) directory.remember(discordChannelInfo(fake.channel(id), fake.guild.id)!);
  const intake = createDiscordIntake({
    control: async () => control, directory,
    lookupChannel: async (channelId) => {
      const answer = await rest.getChannel(channelId);
      return answer.ok ? discordChannelInfo(answer.value) : null;
    },
    membership: createDiscordMembership({ now, rest: async () => rest }), now, registry
  });
  let next = 0;
  const bridge = createDiscordBridge({
    artifactLinks: { publish, ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) },
    control: async () => control, conversations, facts: createMemoryDiscordRunFacts(replies), gateway, lanes: intake.lanes,
    limits: createMemoryDiscordLimitStore(replies), newChatId: () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`,
    now, publish: async () => undefined, replies, rest: () => rest, setupReady: async () => true,
    shares: { create: async () => SHARE_URL },
    timing: { claimGraceMs: 0, followMs: 0, mergeWindowMs: 0, statusIntervalMs: 60_000, typingIntervalMs: 60_000 }
  });
  bridge.register(registry);

  async function ask(content: string, channelId = fake.channels.text): Promise<FakeDiscordMessage> {
    const author = fake.addUser({ username: "alice" });
    const message = fake.postMessage({ authorId: author, channelId, content: `<@${fake.bot.id}> ${content}`, mentions: [fake.bot.id] });
    clock.latest = Math.max(clock.latest, Date.parse(message.timestamp));
    await intake.accept({ data: message, type: "MESSAGE_CREATE" });
    await vi.waitFor(async () => {
      await intake.lanes.idle();
      await bridge.idle();
      expect([...replies.rows.values()].filter((row) => row.state === "claimed" || row.state === "admitted")).toEqual([]);
    });
    return message;
  }

  function answerIn(channelId: string): FakeDiscordMessage {
    const answers = fake.messages(channelId).filter((message) => message.author.id === fake.bot.id);
    expect(answers).toHaveLength(1);
    return answers[0]!;
  }

  return { answerIn, ask, fake, publish, replies, runs };
}

function buttonsOf(message: FakeDiscordMessage): Array<Array<{ label: string; url: string }>> {
  return (message.components as Array<{ components: Array<{ label: string; url: string; style: number; type: number }> }>)
    .map((row) => row.components.map((button) => {
      expect(button).toMatchObject({ style: 5, type: 2 });
      return { label: button.label, url: button.url };
    }));
}

describe("Discord artifact links through the bridge", () => {
  it("links each version the answer made as an Open <title> button to its public link, published as the service account", async () => {
    const h = harness({ artifacts: () => [artifact(1, { title: "Sales chart" }), artifact(2, { title: "Deploy DB_PASSWORD=hunter2-hunter2-hunter2" })] });
    const question = await h.ask("make an artifact with the sales chart");
    const answer = h.answerIn(question.id);
    expect(answer.content).toBe("Here is the page.");
    const rows = buttonsOf(answer);
    expect(rows).toHaveLength(1);
    expect(rows[0]![0]).toEqual({ label: "Open Sales chart", url: `https://aiqsa.example.com/a/version_1${TOKEN}` });
    expect(rows[0]![1]!.label).not.toContain("hunter2");
    expect(rows[0]![1]!.label).toContain("[redacted]");
    expect(h.publish.mock.calls.map(([input]) => input)).toEqual([
      { artifactId: "artifact_1", userId: "svc_1", versionId: "version_1" }, { artifactId: "artifact_2", userId: "svc_1", versionId: "version_2" }
    ]);
    expect(h.replies.rows.get(question.id)).toMatchObject({ state: "delivered" });
    expect(h.fake.violations()).toEqual([]);
    // Logs never carry a title or a link.
    expect(JSON.stringify(logs)).not.toMatch(/Sales chart|hunter2|\/a\//u);
    expect(logs.find((entry) => entry.event === "discord_request" && entry.fields.stage === "delivered")?.fields.redactions).toBeGreaterThanOrEqual(1);
  });

  it("links a later answer's new version while the earlier answer keeps its own link", async () => {
    const h = harness({ artifacts: (runId) => runId === "run-1" ? [artifact(1)] : [artifact(1, { versionId: "version_1b", versionNumber: 2 })] });
    const first = await h.ask("make an artifact");
    const firstAnswer = h.answerIn(first.id);
    const second = await h.ask("change its colours", first.id);
    const answers = h.fake.messages(first.id).filter((message) => message.author.id === h.fake.bot.id);
    expect(answers).toHaveLength(2);
    expect(buttonsOf(firstAnswer)[0]![0]!.url).toBe(`https://aiqsa.example.com/a/version_1${TOKEN}`);
    expect(buttonsOf(answers[1]!)[0]![0]!.url).toBe(`https://aiqsa.example.com/a/version_1b${TOKEN}`);
    expect(h.replies.rows.get(second.id)).toMatchObject({ state: "delivered" });
  });

  it("delivers the answer with a line when publication fails", async () => {
    const h = harness({
      artifacts: () => [artifact(1), artifact(2)],
      publish: async ({ versionId }) => {
        if (versionId === "version_2") throw new Error("synthetic storage failure");
        return `https://aiqsa.example.com/a/${versionId}${TOKEN}`;
      }
    });
    const question = await h.ask("make two pages");
    const answer = h.answerIn(question.id);
    expect(answer.content).toBe("Here is the page.\n\n1 artifact is only in AIQSA");
    expect(buttonsOf(answer)).toEqual([[{ label: "Open Report 1", url: `https://aiqsa.example.com/a/version_1${TOKEN}` }]]);
    expect(h.replies.rows.get(question.id)).toMatchObject({ state: "delivered" });
    expect(logs.some((entry) => entry.fields.code === "discord_artifact_publish_failed" && entry.fields.outcome === "degraded")).toBe(true);
  });

  it("never holds the answer past the bound: a stuck publication leaves the answer with a line", async () => {
    const h = harness({ artifacts: () => [artifact(1)], publish: () => new Promise<string>(() => undefined), timeoutMs: 30 });
    const question = await h.ask("make a page");
    const answer = h.answerIn(question.id);
    expect(answer.content).toBe("Here is the page.\n\n1 artifact is only in AIQSA");
    expect(answer.components).toEqual([]);
    expect(h.replies.rows.get(question.id)).toMatchObject({ state: "delivered" });
    expect(logs.some((entry) => entry.fields.code === "discord_artifact_publish_timeout")).toBe(true);
  });

  it("writes lines instead of buttons on a plain-http installation", async () => {
    const h = harness({ artifacts: () => [artifact(1, { title: "Chart *v2*" })], publish: async () => `http://localhost:3000/a/${TOKEN}` });
    const question = await h.ask("make a page");
    const answer = h.answerIn(question.id);
    expect(answer.content).toBe(`Here is the page.\n\nOpen Chart \\*v2\\*: <http://localhost:3000/a/${TOKEN}>`);
    expect(answer.components).toEqual([]);
    expect(h.fake.violations()).toEqual([]);
  });

  it("publishes nothing for a failed answer", async () => {
    const h = harness({ artifacts: () => [artifact(1)], finish: { code: "run_failed", status: "error" } });
    const question = await h.ask("make a page");
    expect(h.answerIn(question.id).components).toEqual([]);
    expect(h.publish).not.toHaveBeenCalled();
  });
});

describe("Discord artifact links at Discord's button limits", () => {
  const links = (count: number, url = (index: number) => `https://aiqsa.example.com/a/${index}${TOKEN}`) =>
    Array.from({ length: count }, (_, index) => ({ title: `Page ${index}`, url: url(index) }));

  it("puts Open in AIQSA on its own row and the artifacts in rows of five under it, within five rows", async () => {
    const composed = await composeDiscordAnswer({
      answer: { artifactSummary: null, text: Array.from({ length: 12 }, (_, index) => `Paragraph ${index}: ${"detail ".repeat(40)}`).join("\n\n") },
      artifacts: { links: links(20), onlyInAiqsa: 0 }, files: { files: [], note: null }, share: async () => SHARE_URL
    });
    expect(composed.shared).toBe(true);
    expect(composed.buttons!.map((row) => row.length)).toEqual([1, 5, 5, 5, 5]);
    expect(composed.buttons![0]).toEqual([{ label: DISCORD_COPY.openInAiqsa, url: SHARE_URL }]);
    expect(composed.content.length).toBeLessThanOrEqual(2_000);
  });

  it("counts links past twenty buttons, or a link too long for a button that Discord would refuse, as only in AIQSA", async () => {
    const long = `https://aiqsa.example.com/${"x".repeat(520)}`;
    const composed = await composeDiscordAnswer({
      answer: { artifactSummary: null, text: "Done." },
      artifacts: { links: [...links(22), { title: "Long", url: long }], onlyInAiqsa: 1 }, files: { files: [], note: null }, share: async () => null
    });
    expect(composed.buttons!.flat()).toHaveLength(20);
    expect(composed.buttons!.flat().every((button) => button.url.length <= 512 && button.url.startsWith("https://"))).toBe(true);
    // The over-long https link goes as a line (no button can hold it); the three that did not fit and the one never published are counted.
    expect(composed.content).toBe(`Done.\n\nOpen Long: <${long}>\n3 artifacts are only in AIQSA`);
  });

  it("keeps plain-http lines within their share of the message and counts the rest", async () => {
    const composed = await composeDiscordAnswer({
      answer: { artifactSummary: null, text: "x ".repeat(990) },
      artifacts: { links: links(16, (index) => `http://localhost:3000/a/${index}${TOKEN}`), onlyInAiqsa: 0 },
      files: { files: [{ contentType: "text/plain", data: Buffer.from("x"), filename: "a.txt" }], fallbackNote: "1 file is only in AIQSA", note: "1 file is only in AIQSA" },
      share: async () => `http://localhost:3000/s/${TOKEN}`
    });
    expect(composed.buttons).toBeUndefined();
    expect(composed.content.length).toBeLessThanOrEqual(2_000);
    expect(composed.withoutFiles!.length).toBeLessThanOrEqual(2_000);
    const lines = composed.content.split("\n").filter((line) => line.startsWith("Open Page"));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(16);
    expect(composed.content).toContain(`${16 - lines.length} artifacts are only in AIQSA`);
    expect(composed.withoutFiles).toContain(`${16 - lines.length} artifacts are only in AIQSA`);
  });
});
