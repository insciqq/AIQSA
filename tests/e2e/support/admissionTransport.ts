import type { Page } from "@playwright/test";

export type AdmissionTransportFault = "headers" | "admission-body" | "malformed-admission" | "conflict";

type TransportControls = {
  returnToChat(): void;
  releaseLateResponse(): Promise<void>;
};

/** Lose only the first browser acknowledgement; the real server still owns its accepted run. */
export async function interruptAdmission(page: Page, fault: AdmissionTransportFault): Promise<void> {
  await page.addInitScript(({ fault }) => {
    const original = window.fetch.bind(window);
    let hidden = false;
    let intercepted = false;
    let release: () => Promise<void> = async () => undefined;
    let deliverConflict: (() => void) | null = null;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => hidden ? "hidden" : "visible"
    });
    Object.assign(window, {
      admissionTransport: {
        returnToChat() {
          hidden = false;
          if (deliverConflict) {
            // Network callbacks may resume before the lifecycle event. Deliver
            // the delayed refusal without any second send or Retry gesture.
            deliverConflict();
            setTimeout(() => document.dispatchEvent(new Event("visibilitychange")), 0);
          } else document.dispatchEvent(new Event("visibilitychange"));
        },
        releaseLateResponse: () => release()
      }
    });
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (intercepted || init?.method !== "POST" || !/\/api\/chats\/[^/]+\/messages$/u.test(url)) {
        return original(input, init);
      }
      intercepted = true;
      const pending = original(input, { ...init, signal: undefined });
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
      const response = await pending;
      if (!response.ok) return response;

      // Drain the actual response so provider execution and persistence remain
      // real. The replacement transport deliberately ignores AbortSignal.
      const body = response.text();
      if (fault === "conflict") {
        return new Promise<Response>((resolve) => {
          deliverConflict = () => resolve(Response.json({ error: "active_leaf_changed" }, { status: 409 }));
          release = async () => { await body; };
        });
      }
      if (fault === "headers") {
        return new Promise<Response>((resolve) => {
          release = async () => {
            resolve(new Response(await body, { status: response.status, headers: response.headers }));
          };
        });
      }
      if (fault === "malformed-admission") {
        release = async () => { await body; };
        return Response.json({}, { status: 202 });
      }
      const stalled = new ReadableStream<Uint8Array>({
        start(controller) {
          release = async () => {
            await body;
            controller.enqueue(new TextEncoder().encode("{}"));
            controller.close();
          };
        }
      });
      return new Response(stalled, { status: 202, headers: { "content-type": "application/json" } });
    };
  }, { fault });
}

export async function returnAfterAdmissionLoss(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { admissionTransport: TransportControls }).admissionTransport.returnToChat());
}

export async function releaseLateAdmission(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await (window as unknown as { admissionTransport: TransportControls }).admissionTransport.releaseLateResponse();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}
