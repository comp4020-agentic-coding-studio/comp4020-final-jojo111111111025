import { defineConfig } from "vitest/config";

// spec/invariants.test.ts is the one test here that checks the RUNNING app
// (over HTTP, via spec/global-setup.ts) rather than spinning up its own
// server — see spec/README.md. Every *.spec.ts file is a Last Shelter test
// that starts its own in-process server per test (spec/helpers/
// server-harness.ts) and ignores APP_URL entirely.
export default defineConfig({
  test: {
    environment: "node",
    include: ["spec/**/*.test.ts", "spec/**/*.spec.ts"],
    globalSetup: ["./spec/global-setup.ts"],
  },
});
