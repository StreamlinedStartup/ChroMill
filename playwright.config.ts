import { defineConfig } from "@playwright/test"
export default defineConfig({
  testDir: "./tests/run-radar/browser",
  workers: 1,
  timeout: 60000,
  reporter: [["list"]],
  outputDir: "./evidence/WMLC-003/browser-artifacts"
})
