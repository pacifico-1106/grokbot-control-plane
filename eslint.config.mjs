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
  // 木村 10/12 07:15 (2): the hold caller inventory (lib/safety/hold-callers.test.ts) reads
  // import statements. Keep every import statically visible: no require(), and import()
  // only with a plain string literal. Non-test app code (root files included).
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    ignores: ["**/*.test.ts", "**/*.test.tsx", "tests/**", "eslint-rules/**", "scripts/**", "e2e/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: "CallExpression[callee.type='Identifier'][callee.name='require']", message: "Use a static import (hold caller inventory reads imports)." },
        { selector: "ImportExpression[source.type!='Literal']", message: "import() needs a plain string literal (hold caller inventory reads imports)." },
      ],
    },
  },
];

export default eslintConfig;
