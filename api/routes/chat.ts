import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

// ── Backend Python (chat.py) Configuration ──
const CHAT_PY_URL =
  process.env.CHAT_PY_URL ?? process.env.PYTHON_BACKEND_URL ?? "http://localhost:5000";

const chatRoutes = new Hono();

// ── Schemas ──
const textContentSchema = z.object({ type: z.literal("text"), text: z.string() });
const imageContentSchema = z.object({
  type: z.literal("image_url"),
  image_url: z.object({ url: z.string(), detail: z.string().optional() }).optional(),
});
const contentPartSchema = z.union([textContentSchema, imageContentSchema]);

const sendMessageSchema = z.object({
  message: z.string().min(1).optional(),
  conversationId: z.string().optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.union([z.string(), z.array(contentPartSchema)]),
      }),
    )
    .optional(),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
});

/** Helper to extract the most recent user question */
function extractQuestion(body: {
  message?: string;
  messages?: Array<{
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: string; text?: string }>;
  }>;
}): string {
  if (body.message && body.message.trim()) {
    return body.message.trim();
  }

  if (body.messages && body.messages.length > 0) {
    // Find the last user message
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const msg = body.messages[i];
      if (msg.role === "user") {
        if (typeof msg.content === "string") return msg.content.trim();
        if (Array.isArray(msg.content)) {
          const textPart = msg.content.find((p) => p.type === "text" && p.text);
          if (textPart && textPart.text) return textPart.text.trim();
        }
      }
    }
  }

  return "";
}

/** Format chat.py sources for the frontend */
function formatSources(sources?: any[]) {
  if (!Array.isArray(sources)) return [];
  return sources.map((s) => ({
    kind: s.title && s.title.toLowerCase().includes("sop") ? "SOP BPS" : "Publikasi BPS",
    title: s.title || "Dokumen BPS",
    meta:
      [
        s.percent != null ? `Relevansi: ${s.percent}%` : null,
        s.pages && s.pages.length > 0 ? `Hal. ${s.pages.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join(" • ") || "Publikasi Resmi BPS",
    link: s.link || undefined,
    rawScore: s.raw_score ?? null,
    pages: s.pages ?? [],
    citedPages: s.cited_pages ?? [],
    images: s.images ?? [],
  }));
}

// ── GET /chat/status (Check Python chat.py backend health) ──
chatRoutes.get("/status", async (c) => {
  try {
    const res = await fetch(`${CHAT_PY_URL}/api/health`, { method: "GET" });
    if (res.ok) {
      const data = await res.json();
      return c.json({ backend: "chat.py", connected: true, ...data });
    }
    return c.json({ backend: "chat.py", connected: false, status: res.status }, 503);
  } catch (err) {
    return c.json(
      {
        backend: "chat.py",
        connected: false,
        error: (err as Error).message,
        hint: `Pastikan server python back-end/app.py aktif di ${CHAT_PY_URL}`,
      },
      503,
    );
  }
});

// ── POST /chat/send  (non-streaming via chat.py) ──
chatRoutes.post(
  "/send",
  zValidator("json", sendMessageSchema),
  async (c) => {
    const body = c.req.valid("json");
    const conversationId = body.conversationId ?? crypto.randomUUID();
    const question = extractQuestion(body);

    if (!question) {
      return c.json({ error: "Pertanyaan tidak boleh kosong." }, 400);
    }

    try {
      const res = await fetch(`${CHAT_PY_URL}/api/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, conversationId }),
      });

      if (!res.ok) {
        const err = await res.text();
        return c.json(
          {
            error: `Python chat.py backend error (${res.status})`,
            detail: err,
            hint: `Pastikan Ollama dan Qdrant berjalan serta server Python aktif di ${CHAT_PY_URL}.`,
          },
          502,
        );
      }

      const data = (await res.json()) as {
        answer?: string;
        sources?: any[];
        featured_image?: { url: string; page?: string; title?: string };
        warning?: string;
        note?: string;
        mode?: string;
        cached?: boolean;
      };

      const sources = formatSources(data.sources);

      return c.json({
        id: crypto.randomUUID(),
        conversationId,
        text: data.answer ?? "",
        sources,
        warning: data.warning ?? null,
        note: data.note ?? null,
        featuredImage: data.featured_image ?? null,
        mode: data.mode ?? "qa",
        cached: data.cached ?? false,
        createdAt: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error("[Chat Py Error]:", err);
      return c.json(
        {
          error: "Gagal terhubung ke backend Python chat.py",
          detail: err?.message,
          hint: `Jalankan server Python dengan perintah 'python back-end/app.py' (port default 5000).`,
        },
        502,
      );
    }
  },
);

// ── POST /chat/stream  (SSE streaming via chat.py) ──
chatRoutes.post(
  "/stream",
  zValidator("json", sendMessageSchema),
  async (c) => {
    const body = c.req.valid("json");
    const conversationId = body.conversationId ?? crypto.randomUUID();
    const question = extractQuestion(body);

    if (!question) {
      return c.json({ error: "Pertanyaan tidak boleh kosong." }, 400);
    }

    try {
      const pyRes = await fetch(`${CHAT_PY_URL}/api/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, conversationId }),
      });

      if (!pyRes.ok || !pyRes.body) {
        const errText = await pyRes.text().catch(() => "Gagal membaca error dari server Python");
        // Stream error message as SSE
        const errStream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(`data: ${JSON.stringify({ conversationId })}\n\n`),
            );
            const errMsg = `Maaf, backend Python chat.py tidak dapat diakses (${pyRes.status}).\n\nDetail: ${errText}\n\nPastikan:
1. Python backend 'python back-end/app.py' sudah aktif.
2. Ollama dan Qdrant sudah berjalan.`;
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: errMsg } }] })}\n\n`,
              ),
            );
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          },
        });

        return new Response(errStream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      // Stream SSE from Python chat.py → client
      return new Response(pyRes.body, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    } catch (err: any) {
      console.error("[Chat Stream Py Error]:", err);
      const errMsg = `Tidak dapat terhubung ke backend Python chat.py di ${CHAT_PY_URL}.\n\nSilakan jalankan backend Python:\n\`\`\`powershell\npython back-end/app.py\n\`\`\`\nPastikan Ollama dan Qdrant juga telah aktif.`;

      const errStream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify({ conversationId })}\n\n`),
          );
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: errMsg } }] })}\n\n`,
            ),
          );
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      });

      return new Response(errStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }
  },
);

// ── POST /chat/upload  (file upload → text extraction + chat.py) ──
chatRoutes.post("/upload", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  const message = (formData.get("message") as string) ?? "";
  const conversationId = (formData.get("conversationId") as string) ?? crypto.randomUUID();

  if (!file) {
    return c.json({ error: "No file provided" }, 400);
  }

  let prompt = message;
  const isImage = file.type.startsWith("image/");

  if (isImage) {
    prompt = message
      ? `${message}\n(Gambar: ${file.name})`
      : `Tolong analisis informasi pada gambar ${file.name}.`;
  } else {
    try {
      const text = await file.text();
      const filePreview = text.length > 8000 ? text.slice(0, 8000) + "\n... (dipotong)" : text;
      prompt = message
        ? `${message}\n\n---\nIsi dokumen "${file.name}":\n${filePreview}`
        : `Tolong analisis isi dokumen "${file.name}" berikut:\n${filePreview}`;
    } catch {
      prompt = message ? `${message} (File: ${file.name})` : `Tolong analisis file ${file.name}.`;
    }
  }

  try {
    const pyRes = await fetch(`${CHAT_PY_URL}/api/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: prompt, conversationId }),
    });

    if (!pyRes.ok || !pyRes.body) {
      const errText = await pyRes.text().catch(() => "Gagal membaca error dari server Python");
      const errStream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify({ conversationId })}\n\n`),
          );
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      content: `Gagal memproses file pada Python chat.py (${pyRes.status}): ${errText}`,
                    },
                  },
                ],
              })}\n\n`,
            ),
          );
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      });

      return new Response(errStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    return new Response(pyRes.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (err: any) {
    const errMsg = `Gagal menghubungkan upload file ke backend Python: ${err?.message}`;
    const errStream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify({ conversationId })}\n\n`),
        );
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: errMsg } }] })}\n\n`,
          ),
        );
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    return new Response(errStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }
});

export { chatRoutes };
