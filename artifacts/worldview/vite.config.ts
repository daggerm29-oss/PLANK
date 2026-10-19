import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import cesium from "vite-plugin-cesium";
import express from "express";
import cors from "cors";
import proxyRouter from "../api-server/src/routes/proxy";
import cctvRouter from "../api-server/src/routes/cctv";
import healthRouter from "../api-server/src/routes/health";
import configRouter from "../api-server/src/routes/config";

const port = Number(process.env.PORT) || 3000;
const basePath = process.env.BASE_PATH || "/";

function apiProxyPlugin(): Plugin {
  const mountApi = (server: any) => {
    const apiApp = express();
    apiApp.use(cors());
    apiApp.use(express.json());
    const router = express.Router();
    router.use(healthRouter);
    router.use(configRouter);
    router.use(proxyRouter);
    router.use(cctvRouter);
    apiApp.use("/api", router);
    server.middlewares.use(apiApp);
  };

  return {
    name: "api-proxy-plugin",
    configureServer(server) {
      mountApi(server);
    },
    configurePreviewServer(server) {
      mountApi(server);
    },
  };
}

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    cesium({
      cesiumBuildRootPath: path.resolve(import.meta.dirname, "../../node_modules/cesium/Build"),
      cesiumBuildPath: path.resolve(import.meta.dirname, "../../node_modules/cesium/Build/Cesium/"),
    }),
    apiProxyPlugin(),
  ],
  worker: {
    format: "es",
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom", "three"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "../../dist"),
    emptyOutDir: true,
  },
  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
