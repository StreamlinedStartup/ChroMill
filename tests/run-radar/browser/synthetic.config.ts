import { defineConfig } from "@playwright/test"
import configuration from "../../../playwright.config"

export default defineConfig({
  ...configuration,
  testDir: ".",
  outputDir: "../../../evidence/WMLC-004/repair-browser/artifacts",
  metadata: { syntheticOnly: true, evidenceRoot: "evidence/WMLC-004/repair-browser" }
})
