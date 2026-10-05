import { defineConfig } from "vitest/config"
export default defineConfig({ envDir: false, test: { environment: "jsdom", include: ["tests/run-radar/**/*.test.{ts,tsx}"], clearMocks: true } })
