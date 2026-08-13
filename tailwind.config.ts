import type { Config } from "tailwindcss";

function v2Color(variable: string): string {
  return `color-mix(in srgb, var(${variable}) calc(<alpha-value> * 100%), transparent)`;
}

const config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./features/**/*.{ts,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        "app-canvas": v2Color("--v2-color-canvas"),
        "workspace-rail": v2Color("--v2-color-sidebar"),
        "answer-paper": v2Color("--v2-color-surface"),
        "composer-surface": v2Color("--v2-color-surface"),
        control: {
          boundary: v2Color("--v2-color-text3"),
          surface: v2Color("--v2-color-surface2"),
          hover: v2Color("--v2-color-hover"),
          pressed: v2Color("--v2-color-active"),
          selected: v2Color("--v2-color-accent-dim")
        },
        focus: v2Color("--v2-color-accent"),
        "overlay-surface": v2Color("--v2-color-surface"),
        trace: {
          subtle: v2Color("--v2-color-border"),
          strong: v2Color("--v2-color-border2")
        },
        ink: {
          DEFAULT: v2Color("--v2-color-text"),
          secondary: v2Color("--v2-color-text2"),
          muted: v2Color("--v2-color-text3"),
          disabled: v2Color("--v2-color-text3")
        },
        proof: {
          DEFAULT: v2Color("--v2-color-accent"),
          hover: v2Color("--v2-color-accent"),
          contrast: v2Color("--v2-color-accent-ink")
        },
        positive: v2Color("--v2-color-ok"),
        caution: v2Color("--v2-color-warn"),
        critical: v2Color("--v2-color-danger"),
        scrim: v2Color("--v2-color-scrim")
      },
      fontFamily: {
        sans: [
          "var(--font-sans)",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
          "Apple Color Emoji",
          "Segoe UI Emoji",
          "Noto Color Emoji"
        ],
        mono: [
          "var(--font-mono)",
          "SFMono-Regular",
          "Consolas",
          "Liberation Mono",
          "monospace",
          "Apple Color Emoji",
          "Segoe UI Emoji",
          "Noto Color Emoji"
        ]
      },
      fontSize: {
        incidental: ["0.6875rem", { lineHeight: "1rem" }],
        metadata: ["0.75rem", { lineHeight: "1.5" }]
      },
      borderRadius: {
        control: "0.625rem",
        panel: "0.875rem",
        composer: "1.25rem",
        bubble: "1.125rem",
        pill: "9999px"
      },
      height: {
        "control-sm": "2rem",
        control: "2.5rem",
        touch: "2.75rem"
      },
      minHeight: {
        "control-sm": "2rem",
        control: "2.5rem",
        touch: "2.75rem"
      },
      minWidth: {
        touch: "2.75rem"
      },
      maxWidth: {
        reading: "46rem"
      },
      boxShadow: {
        float: "var(--v2-shadow-float)",
        overlay: "var(--v2-shadow-overlay)"
      }
    }
  },
  plugins: []
} satisfies Config;

export default config;
