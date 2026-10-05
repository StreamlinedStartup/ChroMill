import { defineConfig } from "@playwright/test"
import configuration from "../../../playwright.config"
export default defineConfig({ ...configuration, testDir: ".", testMatch: ["credentials.spec.ts", "connection.spec.ts"],
  outputDir: "../../../evidence/WMLC-013/browser/artifacts",
  metadata: { syntheticOnly: true, evidenceRoot: "evidence/WMLC-013/browser" } })
