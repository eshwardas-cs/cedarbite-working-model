import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const runtimeProcess = globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
};

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: runtimeProcess.process?.env?.VERCEL ? "dist" : "../backend/app/web",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8000",
      "/health": "http://127.0.0.1:8000",
    },
  },
  test: {
    environment: "jsdom",
  },
});
