import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";
import jsonUtf8Rule from "./eslint-rules/json-utf8.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
  // staffpass/json-utf8: JSON responses carry a charset (use jsonUtf8 from
  // @/lib/http/json-utf8). Non-test code only.
  {
    files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
    ignores: ["**/*.test.ts", "**/*.test.tsx", "tests/**", "eslint-rules/**"],
    plugins: { staffpass: { rules: { "json-utf8": jsonUtf8Rule } } },
    rules: { "staffpass/json-utf8": "error" },
  },
];

export default eslintConfig;
