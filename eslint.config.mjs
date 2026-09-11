import js from "@eslint/js";
import ts from "typescript-eslint";
import globals from "globals";

export default ts.config(
  { ignores: ["dist/**", "node_modules/**", ".opencode/**"] },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
  // SDK mocks intentionally model only the fields used by each test.
  { files: ["test/**/*.ts"], rules: { "@typescript-eslint/no-explicit-any": "off" } },
);
