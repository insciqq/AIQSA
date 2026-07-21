import type { Metadata, Viewport } from "next";
import { Golos_Text, JetBrains_Mono } from "next/font/google";
import { cookies } from "next/headers";
import {
  AIQSA_THEME_COOKIE_NAME,
  resolveThemeColorScheme,
  resolveThemeId
} from "@/components/app-shell/theme";
import { isTestAuthEnabled } from "@/lib/server/auth/config";
import "katex/dist/katex.min.css";
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
  title: "AIQSA",
  description: "Question, Search, Answer with transparent provider control",
  icons: {
    icon: "/favicon.svg"
  }
};

export const viewport: Viewport = {
  initialScale: 1,
  interactiveWidget: "resizes-content",
  viewportFit: "cover",
  width: "device-width"
};

export default async function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Test runs assert state, not motion; the off switch keeps Playwright deterministic.
  const motionOff = isTestAuthEnabled();
  const cookieStore = await cookies();
  const themeId = resolveThemeId(cookieStore.get(AIQSA_THEME_COOKIE_NAME)?.value);
  const colorScheme = resolveThemeColorScheme(themeId);

  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable}`}
      data-color-scheme={colorScheme}
      data-theme={themeId}
      data-motion={motionOff ? "off" : undefined}
      suppressHydrationWarning
    >
      <body>{children}</body>
    </html>
  );
}
