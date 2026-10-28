import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import prettier from "eslint-plugin-prettier/recommended";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";

export default [
  // 1. Ignorar pastas que NÃO devem ser analisadas
  {
    ignores: [
      "node_modules/**",
      "out/**",
      "build/**",
      "dist/**",
      "coverage/**",
    ],
  },

  // 2. eslint:recommended
  js.configs.recommended,

  // 3. TypeScript — parser e regras recomendadas para arquivos .ts/.tsx
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx}"],
  })),

  // 4. React — para arquivos do projeto
  {
    files: ["**/*.{js,jsx,ts,tsx}"],
    plugins: {
      react: reactPlugin,
      "react-hooks": reactHooksPlugin,
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      "react/react-in-jsx-scope": "off",
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    languageOptions: {
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        Bun: "readonly",
      },
    },
  },

  // 5. Arquivos CommonJS (.cjs) — scripts
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },

  // 6. Prettier (sempre por último)
  prettier,
];
