import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import prettier from "eslint-config-prettier";

/**
 * ESLint 9 flat config.
 *
 * ESLint 9 dropped `.eslintrc.json`, and `eslint-config-next` 16 ships a flat
 * config natively, so it is imported directly rather than bridged. The rules
 * are the same set the old `.eslintrc.json` extended.
 */
const config = [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts",
    ],
  },
  ...nextCoreWebVitals,
  prettier,
  {
    rules: {
      "@next/next/no-img-element": "off",
    },
  },
];

export default config;
