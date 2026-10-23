import type { Metadata, Viewport } from "next";
import { JetBrains_Mono } from "next/font/google";
import localFont from "next/font/local";
import { cookies } from "next/headers";
import {
  AIQSA_THEME_COOKIE_NAME,
  resolveThemeColorScheme,
  resolveThemeId
} from "@/components/app-shell/theme";
import { ClientErrorReporter } from "@/components/errors/ClientErrorReporter";
import "katex/dist/katex.min.css";
import "../styles/tokens-v2.css";
import "../components/ui-v2/primitives.css";
import "../components/artifacts/artifacts.css";
import "../features/navigation-v2/navigation.css";
import "../features/conversation-v2/conversation.css";
import "../features/run-lifecycle-v2/run-lifecycle.css";
import "../features/composer-v2/composer.css";
import "../features/attachments-v2/attachments.css";
import "../features/answer-outputs-v2/answer-outputs.css";
import "../features/branches-v2/branches.css";
import "../features/library-v2/library.css";
import "../features/library-v2/skills.css";
import "../features/settings-v2/settings.css";
import "../components/auth/auth.css";
import "../features/workspace-v2/workspace.css";
import "../features/connect/connect.css";
import "./globals.css";

// Bundled upstream file (see app/fonts/LICENSE.txt): next/font/google downloads
// the build Google serves to macOS, which lacks the TrueType prep table, so
// FreeType on Linux autohints it and letter spacing becomes uneven.
const sans = localFont({
  display: "swap",
  src: [{ path: "./fonts/GolosText-Variable.woff2", style: "normal", weight: "400 900" }],
  variable: "--font-sans"
});

const mono = JetBrains_Mono({
  subsets: ["latin", "cyrillic"],
  variable: "--font-mono"
});

export const metadata: Metadata = {
  title: {
    default: "AIQSA",
    template: "%s · AIQSA"
  },
  description: "Self-hosted AI workspace with multi-provider chat, MCP tools, and web search",
  icons: {
    apple: "/apple-touch-icon.png",
    icon: [
      { type: "image/svg+xml", url: "/favicon.svg" },
      { sizes: "32x32", type: "image/x-icon", url: "/favicon.ico" }
    ],
    shortcut: "/favicon.svg"
  }
};

export const viewport: Viewport = {
  initialScale: 1,
  themeColor: [
    { color: "#f7f7f8", media: "(prefers-color-scheme: light)" },
    { color: "#1a1b1e", media: "(prefers-color-scheme: dark)" }
  ],
  interactiveWidget: "resizes-content",
  viewportFit: "cover",
  width: "device-width"
};

export default async function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const themeId = resolveThemeId(cookieStore.get(AIQSA_THEME_COOKIE_NAME)?.value);
  const colorScheme = resolveThemeColorScheme(themeId);

  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable}`}
      data-color-scheme={colorScheme}
      data-theme={themeId}
      suppressHydrationWarning
    >
      <body>
        <ClientErrorReporter />
        {children}
      </body>
    </html>
  );
}
