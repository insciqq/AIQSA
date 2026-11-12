/**
 * Process-wide change listeners of the Discord control (one replica, shared
 * across route bundles through `globalThis`): after every administrator write
 * the gateway session re-evaluates the switch, the token and the choices.
 */

export type DiscordControlHooks = Readonly<{
  onChange(listener: () => void): () => void;
  changed(): void;
}>;

export function createDiscordControlHooks(): DiscordControlHooks {
  const listeners = new Set<() => void>();
  return Object.freeze({
    onChange(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    changed() {
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // A listener never fails the write that already committed.
        }
      }
    }
  });
}

const globalForDiscord = globalThis as unknown as { __aiqsaDiscordControlHooks?: DiscordControlHooks };

/** The application's one hook registry. */
export function discordControlHooks(): DiscordControlHooks {
  globalForDiscord.__aiqsaDiscordControlHooks ??= createDiscordControlHooks();
  return globalForDiscord.__aiqsaDiscordControlHooks;
}
