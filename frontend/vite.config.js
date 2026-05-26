import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, proxy API/doc/events to the local service (default port 4400).
// In production, the service serves `dist/` directly, so paths are same-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:4400",
      "/doc": "http://localhost:4400",
      "/events": { target: "http://localhost:4400", ws: false },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
