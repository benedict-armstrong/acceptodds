import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
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
  globalIgnores([
    "node_modules/**",
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".claude/**",
  ]),
]);

export default eslintConfig;
