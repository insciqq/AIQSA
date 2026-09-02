import type { Metadata, Viewport } from "next";
import { Golos_Text, JetBrains_Mono } from "next/font/google";
import { cookies } from "next/headers";
import {
  AIQSA_THEME_COOKIE_NAME,
  resolveThemeColorScheme,
  resolveThemeId
} from "@/components/app-shell/theme";
import "katex/dist/katex.min.css";
import "../styles/tokens-v2.css";
import "../components/ui-v2/primitives.css";
import "../features/navigation-v2/navigation.css";
import "../features/conversation-v2/conversation.css";
import "../features/run-lifecycle-v2/run-lifecycle.css";
import "../features/composer-v2/composer.css";
import "../features/attachments-v2/attachments.css";
import "../features/answer-outputs-v2/answer-outputs.css";
import "../features/branches-v2/branches.css";
import "../features/library-v2/library.css";
import "../features/library-v2/knowledge.css";
import "../features/settings-v2/settings.css";
import "../components/auth/auth.css";
import "../features/projects-v2/projects.css";
import "../features/workspace-v2/workspace.css";
import "./globals.css";

const sans = Golos_Text({
  subsets: ["latin", "cyrillic"],
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
    { color: "#f5f7fa", media: "(prefers-color-scheme: light)" },
    { color: "#0c1017", media: "(prefers-color-scheme: dark)" }
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
      <body>{children}</body>
    </html>
  );
}
