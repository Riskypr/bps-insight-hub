// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Load .env and .env.local into process.env before Hono import */
function loadEnvFile() {
  for (const filename of [".env", ".env.local"]) {
    try {
      const envPath = resolve(__dirname, filename);
      const content = readFileSync(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        process.env[key] = val;
      }
    } catch { /* file not found */ }
  }
}

/** Mount Hono API at /api/* during dev */
function honoApiPlugin(): Plugin {
  return {
    name: "hono-api",
    configureServer(server) {
      // Ensure .env is loaded before Hono reads process.env
      loadEnvFile();

      server.middlewares.use("/api", async (req, res) => {
        try {
          const mod = await server.ssrLoadModule("./api/index.ts");
          const app = mod.default;
          // Vite passes stripped URL or full URL — ensure proper path for Hono
          const rawUrl = req.url ?? "/";
          const strippedUrl = rawUrl.startsWith("/api") ? rawUrl.slice(4) || "/" : rawUrl;
          const url = new URL(strippedUrl, `http://${req.headers.host ?? "localhost"}`);
          const headers = new Headers();
          for (const [key, val] of Object.entries(req.headers)) {
            if (val) headers.set(key, Array.isArray(val) ? val.join(", ") : val);
          }

          let body: BodyInit | undefined;
          if (req.method !== "GET" && req.method !== "HEAD") {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(chunk);
            body = Buffer.concat(chunks);
          }

          const request = new Request(url.toString(), {
            method: req.method,
            headers,
            body,
          });

          const response = await app.fetch(request);

          // Pipe response back to Node.js
          res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
          if (response.body) {
            const reader = response.body.getReader();
            const pump = async (): Promise<void> => {
              const { done, value } = await reader.read();
              if (done) { res.end(); return; }
              res.write(value);
              return pump();
            };
            await pump();
          } else {
            res.end();
          }
        } catch (err: unknown) {
          console.error("[Hono middleware error]:", err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : "Internal server error" }));
          } else {
            res.end();
          }
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [honoApiPlugin()],
  tanstackStart: {
    server: { entry: "server" },
  },
});
