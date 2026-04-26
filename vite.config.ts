import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: process.env.NODE_ENV === "production" ? "/onestreamxf-chat/" : "/",
  build: {
    outDir: "docs",
  },
  plugins: [react()],
});
