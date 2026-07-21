import { expect, type Page } from "@playwright/test";

type GatedRunStreamOptions = {
  abortMessage: string;
  chatId: string;
  key: string;
  notReadyError: string;
};

type GatedRunStreamState = {
  controller?: ReadableStreamDefaultController<Uint8Array>;
  requestCount: number;
};

type GatedRunStreamWindow = typeof window & {
  __aiqsaGatedRunStreams?: Record<string, GatedRunStreamState>;
};

export type GatedRunStreamFixture = {
  close(page: Page): Promise<void>;
  emit(page: Page, type: string, data: unknown): Promise<void>;
  install(page: Page, chatId: string): Promise<void>;
  installCurrent(page: Page, chatId: string): Promise<void>;
  waitForRequestCount(page: Page, requestCount: number): Promise<void>;
};

function installGatedRunStream({
  abortMessage,
  chatId: installedChatId,
  key
}: Pick<GatedRunStreamOptions, "abortMessage" | "chatId" | "key">) {
  const gatedWindow = window as GatedRunStreamWindow;
  const originalFetch = window.fetch.bind(window);
  const streams = (gatedWindow.__aiqsaGatedRunStreams ??= {});
  const stream = (streams[key] ??= { requestCount: 0 });

  window.fetch = async (requestInput: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof requestInput === "string"
        ? requestInput
        : requestInput instanceof URL
          ? requestInput.toString()
          : requestInput.url;
    const method = init?.method ?? (requestInput instanceof Request ? requestInput.method : "GET");

    if (method === "POST" && url.endsWith(`/api/chats/${installedChatId}/messages`)) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream.controller = controller;
          stream.requestCount += 1;
          init?.signal?.addEventListener(
            "abort",
            () => controller.error(new DOMException(abortMessage, "AbortError")),
            { once: true }
          );
        }
      });

      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
        status: 200
      });
    }

    if (method === "POST" && url.includes("/api/model-runs/") && url.endsWith("/cancel")) {
      return new Response(JSON.stringify({ status: "cancelled" }), {
        headers: { "content-type": "application/json" },
        status: 200
      });
    }

    return originalFetch(requestInput, init);
  };
}

export function createGatedRunStreamFixture(
  input: Omit<GatedRunStreamOptions, "chatId">
): GatedRunStreamFixture {
  return {
    async close(page) {
      await page.evaluate(
        ({ key, notReadyError }) => {
          const stream = (window as GatedRunStreamWindow).__aiqsaGatedRunStreams?.[key];
          if (!stream?.controller) {
            throw new Error(notReadyError);
          }
          stream.controller.close();
        },
        input
      );
    },

    async emit(page, type, data) {
      await page.evaluate(
        ({ eventData, eventType, key, notReadyError }) => {
          const stream = (window as GatedRunStreamWindow).__aiqsaGatedRunStreams?.[key];
          if (!stream?.controller) {
            throw new Error(notReadyError);
          }
          stream.controller.enqueue(
            new TextEncoder().encode(`event: ${eventType}\ndata: ${JSON.stringify(eventData)}\n\n`)
          );
        },
        { ...input, eventData: data, eventType: type }
      );
    },

    async install(page, chatId) {
      await page.addInitScript(installGatedRunStream, { ...input, chatId });
    },

    async installCurrent(page, chatId) {
      await page.evaluate(installGatedRunStream, { ...input, chatId });
    },

    async waitForRequestCount(page, requestCount) {
      await expect
        .poll(() =>
          page.evaluate(
            ({ key }) =>
              (window as GatedRunStreamWindow).__aiqsaGatedRunStreams?.[key]?.requestCount ?? 0,
            input
          )
        )
        .toBe(requestCount);
    }
  };
}
