import type { Config } from "tailwindcss";

const config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        "research-canvas": "rgb(var(--research-canvas) / <alpha-value>)",
        "workspace-rail": "rgb(var(--workspace-rail) / <alpha-value>)",
        "answer-paper": "rgb(var(--answer-paper) / <alpha-value>)",
        "composer-surface": "rgb(var(--composer-surface) / <alpha-value>)",
        control: {
          surface: "rgb(var(--control-surface) / <alpha-value>)",
          hover: "rgb(var(--control-hover) / <alpha-value>)",
          pressed: "rgb(var(--control-pressed) / <alpha-value>)",
          selected: "rgb(var(--control-selected) / <alpha-value>)"
        },
        "overlay-surface": "rgb(var(--overlay-surface) / <alpha-value>)",
        trace: {
          subtle: "rgb(var(--trace-subtle) / <alpha-value>)",
          strong: "rgb(var(--trace-strong) / <alpha-value>)"
        },
        ink: {
          DEFAULT: "rgb(var(--ink) / <alpha-value>)",
          secondary: "rgb(var(--ink-secondary) / <alpha-value>)",
          muted: "rgb(var(--ink-muted) / <alpha-value>)",
          disabled: "rgb(var(--ink-disabled) / <alpha-value>)"
        },
        proof: {
          DEFAULT: "rgb(var(--proof) / <alpha-value>)",
          hover: "rgb(var(--proof-hover) / <alpha-value>)",
          contrast: "rgb(var(--proof-contrast) / <alpha-value>)"
        },
        positive: "rgb(var(--positive) / <alpha-value>)",
        caution: "rgb(var(--caution) / <alpha-value>)",
        critical: "rgb(var(--critical) / <alpha-value>)",
        scrim: "rgb(var(--scrim) / <alpha-value>)",
        /* Temporary class aliases for legacy renderers during the in-place revamp. */
        surface: {
          canvas: "rgb(var(--surface-canvas) / <alpha-value>)",
          navigation: "rgb(var(--surface-navigation) / <alpha-value>)",
          thread: "rgb(var(--surface-thread) / <alpha-value>)",
          overlay: "rgb(var(--surface-overlay) / <alpha-value>)",
          hover: "rgb(var(--surface-hover) / <alpha-value>)",
          active: "rgb(var(--surface-active) / <alpha-value>)",
          selected: "rgb(var(--surface-selected) / <alpha-value>)",
          raised: "rgb(var(--surface-raised) / <alpha-value>)"
        },
        content: {
          primary: "rgb(var(--text-primary) / <alpha-value>)",
          secondary: "rgb(var(--text-secondary) / <alpha-value>)",
          muted: "rgb(var(--text-muted) / <alpha-value>)",
          disabled: "rgb(var(--text-disabled) / <alpha-value>)",
          link: "rgb(var(--text-link) / <alpha-value>)"
        },
        separator: {
          subtle: "rgb(var(--separator-subtle) / <alpha-value>)",
          strong: "rgb(var(--separator-strong) / <alpha-value>)"
        },
        accent: {
          cyan: "rgb(var(--accent-cyan) / <alpha-value>)",
          green: "rgb(var(--accent-green) / <alpha-value>)",
          amber: "rgb(var(--accent-amber) / <alpha-value>)",
          rose: "rgb(var(--accent-rose) / <alpha-value>)"
        }
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
        float: "var(--shadow-float)",
        overlay: "var(--shadow-overlay)"
      }
    }
  },
  plugins: []
} satisfies Config;

export default config;
