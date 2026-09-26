import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // Client IP is read in exactly one place, `clientIp()` in
    // src/server/api/http.ts, from Cf-Connecting-Ip. X-Forwarded-For is
    // whatever the client chose to send; never key anything on it.
    files: ["src/**/*.ts", "src/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/^(x-forwarded-for|x-real-ip|forwarded|cf-connecting-ip)$/i]",
          message: "Read the client IP only through clientIp(req) in src/server/api/http.ts.",
        },
      ],
    },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
];

export default eslintConfig;
