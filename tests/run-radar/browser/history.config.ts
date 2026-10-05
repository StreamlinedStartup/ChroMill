import { defineConfig } from "@playwright/test"
import configuration from "../../../playwright.config"
export default defineConfig({ ...configuration, testDir: ".", testMatch: ["history.spec.ts"],
  outputDir: "../../../evidence/WMLC-018/browser/artifacts",
  metadata: { syntheticOnly: true, evidenceRoot: "evidence/WMLC-018/browser" } })
