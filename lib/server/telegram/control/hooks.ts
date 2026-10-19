import type { TelegramBotApi } from "../botApi";

/**
 * Process-wide listeners of the Telegram control (one replica, shared across
 * route bundles through `globalThis`): change listeners re-evaluate the poller
 * after every administrator write, and activation hooks run when the bot is
 * switched on or its token changes while it is on (after `deleteWebhook` and
 * `setMyCommands`), for features that register more with Telegram.
 */

export type TelegramActivationHook = (input: Readonly<{ api: TelegramBotApi; botId: number }>) => Promise<void>;

export type TelegramControlHooks = Readonly<{
  onChange(listener: () => void): () => void;
  onActivation(hook: TelegramActivationHook): () => void;
  changed(): void;
  activationHooks(): readonly TelegramActivationHook[];
}>;

export function createTelegramControlHooks(): TelegramControlHooks {
  const listeners = new Set<() => void>();
  const hooks = new Set<TelegramActivationHook>();
  return Object.freeze({
    onChange(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    onActivation(hook: TelegramActivationHook) {
      hooks.add(hook);
      return () => { hooks.delete(hook); };
    },
    changed() {
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // A listener never fails the write that already committed.
        }
      }
    },
    activationHooks: () => [...hooks]
  });
}

const globalForTelegram = globalThis as unknown as { __aiqsaTelegramControlHooks?: TelegramControlHooks };

/** The application's one hook registry. */
export function telegramControlHooks(): TelegramControlHooks {
  globalForTelegram.__aiqsaTelegramControlHooks ??= createTelegramControlHooks();
  return globalForTelegram.__aiqsaTelegramControlHooks;
}

/** Runs after the bot is switched on, or gets a new token while on; failures are logged, never block activation. */
export function onTelegramActivation(hook: TelegramActivationHook): () => void {
  return telegramControlHooks().onActivation(hook);
}
