import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx,js,mjs}", "test/**/*.{test,spec}.{ts,tsx,js,mjs}"],
    exclude: ["node_modules/**", "dist/**", "test/**/*.e2e.ts", "release/**", "release-assets/**"],
  },
});
