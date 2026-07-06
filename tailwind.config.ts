import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "#0a0b0e",
          panel: "#101218",
          raised: "#161922",
          hover: "#1c2029",
        },
        edge: "#242936",
        ink: {
          DEFAULT: "#e6e8ee",
          dim: "#9aa3b2",
          faint: "#5b6573",
        },
        accent: {
          DEFAULT: "#6ea8fe",
          soft: "#2b3b57",
        },
        ok: "#3fb950",
        warn: "#d29922",
        err: "#f85149",
      },
      fontFamily: {
        mono: [
          "var(--font-mono)",
          "ui-monospace",
          "SFMono-Regular",
          "monospace",
        ],
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      keyframes: {
        "pulse-dot": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
      },
      animation: {
        "pulse-dot": "pulse-dot 1.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
