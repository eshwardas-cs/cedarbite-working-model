import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../backend/app/web",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("/node_modules/")) return;
          if (id.includes("/react-dom/") || id.includes("/scheduler/")) return "react-runtime";
          if (id.includes("/react/")) return "react-runtime";
          if (id.includes("/@supabase/")) return "supabase-client";
        },
      },
    },
  },
  server: {
    proxy: {
      "/.netlify/functions": {
        target: "http://127.0.0.1:8888",
        changeOrigin: true,
      },
      "/api": "http://127.0.0.1:8000",
      "/health": "http://127.0.0.1:8000",
    },
  },
  test: {
    environment: "jsdom",
  },
});
