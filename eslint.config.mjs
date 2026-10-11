import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";
import jsonUtf8Rule from "./eslint-rules/json-utf8.mjs";
import { JSON_UTF8_LEGACY_ALLOWLIST } from "./eslint-rules/json-utf8-allowlist.mjs";

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
  // Legacy call sites; the mechanical replacement PR empties this list.
  ...(JSON_UTF8_LEGACY_ALLOWLIST.length
    ? [
        {
          // Literal paths: escape glob characters ([orgId] route segments).
          files: JSON_UTF8_LEGACY_ALLOWLIST.map((f) => f.replace(/[[\]{}()*?!+@]/g, "\\$&")),
          rules: { "staffpass/json-utf8": "off" },
        },
      ]
    : []),
];

export default eslintConfig;
