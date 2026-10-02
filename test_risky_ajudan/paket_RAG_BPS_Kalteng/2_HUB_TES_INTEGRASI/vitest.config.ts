import { defineConfig } from "vitest/config";

// Config khusus tes. Sengaja terpisah dari vite.config.ts milik aplikasi
// (yang memuat plugin TanStack) supaya tes berjalan cepat dan mandiri.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
