"use client";

import {
  SignInMethodCardFrame,
  SignInSecretField,
  SignInTextField,
  signInSecretAction,
  type AdminSignInMethodCardProps
} from "@/components/admin/signIn/SignInMethodCardFrame";
import { appUrl } from "@/components/admin/signIn/signInView";
import { useMemo, useState } from "react";

type OAuthClientMethod = "google" | "yandex";

const copy: Record<OAuthClientMethod, { clientIdPlaceholder: string; description: string; redirectLabel: string }> = {
  google: {
    clientIdPlaceholder: "1234567890-abc.apps.googleusercontent.com",
    description: "A Google OAuth client (Web application). People sign in with their Google account; the sign-up rules decide who gets in.",
    redirectLabel: "Authorized redirect URI"
  },
  yandex: {
    clientIdPlaceholder: "Client ID from oauth.yandex.com",
    description: "A Yandex ID application. People sign in with their Yandex account; the sign-up rules decide who gets in.",
    redirectLabel: "Redirect URI"
  }
};

/** Google and Yandex: a client ID and a write-only client secret. */
function OAuthClientSignInCard({ appBaseUrl, controller, state }: AdminSignInMethodCardProps<OAuthClientMethod>) {
  const method = state.method;
  const savedClientId = state.draft.config?.clientId ?? "";
  const [clientId, setClientId] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState("");
  const [errors, setErrors] = useState<{ clientId?: string; clientSecret?: string }>({});
  const secretConfigured = state.draft.secrets.clientSecret === true;
  const currentClientId = clientId ?? savedClientId;
  const dirty = (clientId !== null && clientId !== savedClientId) || clientSecret.length > 0;
  const busy = controller.state.busy !== null;

  const draft = useMemo(() => ({
    build() {
      const nextErrors: typeof errors = {};
      if (!currentClientId.trim()) nextErrors.clientId = "Enter the client ID.";
      if (!secretConfigured && !clientSecret) nextErrors.clientSecret = "Enter the client secret.";
      setErrors(nextErrors);
      if (Object.keys(nextErrors).length) return null;
      return {
        config: { clientId: currentClientId.trim() },
        secretActions: { clientSecret: signInSecretAction(clientSecret) }
      };
    },
    dirty,
    reset() {
      setClientId(null);
      setClientSecret("");
      setErrors({});
    }
  }), [clientSecret, currentClientId, dirty, secretConfigured]);

  return (
    <SignInMethodCardFrame
      controller={controller}
      copyValues={[{ label: copy[method].redirectLabel, value: appUrl(appBaseUrl, `/api/auth/oauth/${method}/callback`) }]}
      description={copy[method].description}
      draft={draft}
      state={state}
    >
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <SignInTextField
          disabled={busy}
          error={errors.clientId}
          label="Client ID"
          onChange={(value) => {
            setClientId(value);
            setErrors((current) => ({ ...current, clientId: undefined }));
          }}
          placeholder={copy[method].clientIdPlaceholder}
          value={currentClientId}
        />
        <SignInSecretField
          configured={secretConfigured}
          disabled={busy}
          error={errors.clientSecret}
          label="Client secret"
          onChange={(value) => {
            setClientSecret(value);
            setErrors((current) => ({ ...current, clientSecret: undefined }));
          }}
          value={clientSecret}
        />
      </div>
    </SignInMethodCardFrame>
  );
}

export function GoogleSignInCard(props: AdminSignInMethodCardProps<"google">) {
  return <OAuthClientSignInCard {...props} />;
}

export function YandexSignInCard(props: AdminSignInMethodCardProps<"yandex">) {
  return <OAuthClientSignInCard {...props} />;
}
