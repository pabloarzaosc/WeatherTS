import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    // 0.0.0.0 so the phone can reach it over Tailscale. The box is only exposed
    // on the tailnet (and localhost), not the public internet -- Tailscale is
    // the access control here, so keep the machine off any untrusted LAN.
    host: true,
    port: 1420,
    strictPort: true,
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
});
