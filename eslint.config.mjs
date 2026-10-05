import tseslint from "typescript-eslint"
export default tseslint.config(...tseslint.configs.recommended, {
  files: ["src/**/*.ts", "src/**/*.tsx", "tests/run-radar/**/*.ts", "tests/run-radar/**/*.tsx"],
  rules: { "@typescript-eslint/no-explicit-any": "error" }
})
