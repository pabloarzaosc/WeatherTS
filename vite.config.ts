import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";


const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  // The desktop loads the build from file://, so every path is relative. The
  // web build (`--mode web`) is served from weatherts.tech/app/.
  base: mode === "web" ? "/app/" : "./",
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: {
    outDir: mode === "web" ? "dist-web" : "dist",
    rollupOptions: {
      output: {
        /**
         * Split the vendor libraries out of the app chunk.
         *
         * Everything shipped as one 1.85 MB file, so any change to app code
         * invalidated the whole download -- including MapLibre, which is the
         * bulk of it and changes only when the dependency does. Separate
         * chunks let the browser keep the big, stable ones across releases.
         */
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("maplibre-gl")) return "maplibre";
          if (id.includes("@supabase")) return "supabase";
          if (id.includes("lucide-react")) return "icons";
          if (id.includes("mp4-muxer") || id.includes("gifenc")) return "export";
          if (id.includes("react-dom") || id.includes("/react/") || id.includes("scheduler")) {
            return "react";
          }
          return "vendor";
        },
      },
    },
  },
  server: {
    // 0.0.0.0 so the phone can reach it over Tailscale. The box is only exposed
    // on the tailnet (and localhost), not the public internet -- Tailscale is
    // the access control here, so keep the machine off any untrusted LAN.
    host: true,
    port: 1420,
    strictPort: true,
    // Build output is not source: a web build rewriting dist-web/ while the dev
    // server watched it locked a file (EBUSY on Windows) and killed the server.
    watch: { ignored: ["**/dist/**", "**/dist-web/**", "**/dist-site/**", "**/release/**", "**/backend/**", "**/web/**"] },
    // Vite blocks requests whose Host header it doesn't know; the tailnet name
    // is how the phone will ask for it.
    allowedHosts: [".ts.net", "localhost"],
    proxy: {
      "/sounding-backend": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/sounding-backend/, ""),
      },
      "/nadocast": {
        target: "http://data.nadocast.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/nadocast/, ""),
      },
      "/sounding-api": {
        target: "https://soundinganalysis-752306366750.asia-southeast1.run.app",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/sounding-api/, ""),
      },
    },
  },
}));