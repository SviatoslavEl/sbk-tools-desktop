import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// These are the same job-level values embedded by src-tauri/build.rs. They
// identify the packaged frontend without exposing the rest of the environment.
// @ts-expect-error process is a nodejs global
const buildEnvironment = process.env;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  define: {
    __SBK_BUILD_INFO__: JSON.stringify({
      artifactVersion: buildEnvironment.ARTIFACT_VERSION || "",
      revision: buildEnvironment.GITHUB_SHA || "",
      target: buildEnvironment.TARGET || "",
      installed: buildEnvironment.VITE_SBK_INSTALLED_FAST_START === "true",
    }),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
