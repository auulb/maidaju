import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
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
