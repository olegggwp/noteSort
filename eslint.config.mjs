import js from "@eslint/js";
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

export default [
    {
        ignores: ["main.js", "node_modules/"],
    },
    {
        ...js.configs.recommended,
        files: ["**/*.mjs"],
    },
    ...tseslint.configs.recommended,
    obsidianmd.configs.recommended,
    {
        files: ["src/**/*.ts"],
        rules: {
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    args: "all",
                    argsIgnorePattern: "^_",
                    caughtErrors: "all",
                    caughtErrorsIgnorePattern: "^_",
                },
            ],
        },
    },
];