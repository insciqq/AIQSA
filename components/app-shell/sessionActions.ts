export type SignOutResult =
  | {
      ok: true;
    }
  | {
      error: string;
      ok: false;
    };

type SignOutOptions = {
  fetcher?: typeof fetch;
  navigate?: (href: string) => void;
  timeoutMs?: number;
};

const DEFAULT_SIGN_OUT_TIMEOUT_MS = 15_000;

function signOutErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    json_required: "The sign-out request was not accepted. Refresh the page and try again.",
    logout_timeout: "Sign out timed out. Check your connection and try again.",
    network_error: "Could not reach the server. Check your connection and try signing out again.",
    unauthorized: "Your session is no longer valid. Refresh the page or sign in again."
  };

  return `${messages[code] ?? "Could not sign out. Try again."} (${code})`;
}

export async function signOutCurrentSession(options: SignOutOptions = {}): Promise<SignOutResult> {
  const fetcher = options.fetcher ?? fetch;
  const navigate = options.navigate ?? ((href: string) => window.location.assign(href));
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_SIGN_OUT_TIMEOUT_MS;
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error("logout_timeout"));
    }, timeoutMs);
  });

  const request = (async (): Promise<{ code?: string; ok: boolean }> => {
    const response = await fetcher("/api/auth/logout", {
      body: "{}",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json"
      },
      method: "POST",
      signal: controller.signal
    });

    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      return { code: data?.error ?? "logout_failed", ok: false };
    }

    return { ok: true };
  })();

  try {
    const result = await Promise.race([request, timeout]);

    if (!result.ok) {
      return {
        error: signOutErrorMessage(result.code ?? "logout_failed"),
        ok: false
      };
    }

    navigate("/login");
    return { ok: true };
  } catch {
    return {
      error: signOutErrorMessage(timedOut ? "logout_timeout" : "network_error"),
      ok: false
    };
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
