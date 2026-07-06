import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";
import prettier from "eslint-config-prettier";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const config = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  // Turns off ESLint rules that would fight Prettier's formatting.
  prettier,
  {
    ignores: [".next/**", "coverage/**", "node_modules/**", "next-env.d.ts"],
  },
  {
    // The dependency rule, enforced by CI instead of discipline:
    // protocol/ is pure TypeScript and must never reach up into the
    // framework or the state layer.
    files: ["protocol/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "react", message: "protocol/ must stay framework-free." },
            {
              name: "react-dom",
              message: "protocol/ must stay framework-free.",
            },
            { name: "next", message: "protocol/ must stay framework-free." },
            {
              name: "zustand",
              message: "protocol/ must not depend on the state layer.",
            },
          ],
          patterns: [
            {
              group: [
                "next/*",
                "@/stores/*",
                "@/hooks/*",
                "@/components/*",
                "@/app/*",
              ],
              message:
                "protocol/ may only import from protocol/ and lib/. Keep it pure.",
            },
          ],
        },
      ],
    },
  },
];

export default config;
