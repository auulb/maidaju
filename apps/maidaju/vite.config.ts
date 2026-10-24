import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // GitHub Pages 部署在子路径下，构建时通过 BASE_PATH 覆盖。
  base: process.env.BASE_PATH ?? "/",
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  plugins: [
    {
      name: "maidaju-demo-api",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/api/")) return next();
          try {
            const api = await server.ssrLoadModule("/src/server/web-api.ts");
            await api.handleApi(req, res);
          } catch (error) {
            next(error);
          }
        });
      },
    },
  ],
  server: { port: 5173, strictPort: false },
});
