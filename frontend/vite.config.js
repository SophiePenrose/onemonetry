import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const isTest = mode === "test";

  return {
    // Vitest does not need the React Babel plugin and loading it in test mode
    // triggers Vite's esbuild/oxc deprecation warnings.
    plugins: isTest ? [] : [react()],
    server: {
      // Bind to 0.0.0.0 and allow the Codespaces/forwarded-host proxy so the
      // dev server is reachable at https://<codespace>-5173.app.github.dev.
      host: true,
      port: 5173,
      allowedHosts: [".app.github.dev", ".github.dev", ".gitpod.io"],
      proxy: {
        "/api": "http://localhost:8000"
      }
    },
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: "./__tests__/setup.js",
    },
  };
});
