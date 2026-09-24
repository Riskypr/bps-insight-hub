import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { chatRoutes } from "./routes/chat";
import { conversationRoutes } from "./routes/conversations";
import { datasetRoutes } from "./routes/datasets";
import { pdfRoutes } from "./routes/pdfs";

const app = new Hono();

// ── Middleware ──
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: process.env.FRONTEND_ORIGIN ?? "http://localhost:5173",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

// ── Error handler ──
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

// ── Health check ──
app.get("/health", (c) => c.json({ status: "ok", timestamp: Date.now() }));

// ── Routes ──
app.route("/chat", chatRoutes);
app.route("/datasets", datasetRoutes);
app.route("/conversations", conversationRoutes);
app.route("/v1/pdfs", pdfRoutes);

export default app;
