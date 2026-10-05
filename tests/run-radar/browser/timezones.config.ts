import { defineConfig } from "@playwright/test"
import configuration from "../../../playwright.config"
export default defineConfig({ ...configuration, testDir: ".", testMatch: "timezones.spec.ts",
  outputDir: "../../../evidence/WMLC-011/browser/artifacts",
  metadata: { syntheticOnly: true, evidenceRoot: "evidence/WMLC-011/browser" } })
