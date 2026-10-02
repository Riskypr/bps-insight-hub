import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import {
  RagAuthError,
  RagBusyError,
  formatRagAnswer,
  ragAsk,
  ragEnabled,
  ragSseResponse,
} from "../lib/rag";

// ── Python LLM & RAG Backend (chat.py) Configuration ──
const CHAT_PY_URL =
  process.env.CHAT_PY_URL ?? process.env.PYTHON_BACKEND_URL ?? "http://localhost:5000";

// ── Model umum (OpenAI-compatible), hanya dipakai saat RAG gagal/dimatikan ──
const AI_BASE = (process.env["AI_API_BASE"] ?? "http://localhost:20128/v1").replace(/\/+$/, "");
const AI_MODEL = process.env["AI_API_MODEL"] ?? "default";

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

// ── Fallback ke model umum (dipakai saat RAG gagal/dimatikan) ────────────────
type AiMessage = { role: "system" | "user" | "assistant"; content: string };

function aiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = process.env["AI_API_KEY"];
  if (key) headers["Authorization"] = `Bearer ${key}`;
  return headers;
}

function textOnly(content: string | Array<{ type: string; text?: string | undefined }>): string {
  if (typeof content === "string") return content;
  return content
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n")
    .trim();
}

/** Riwayat (teks saja) + pertanyaan terakhir, dalam bentuk yang dimengerti API model umum. */
function fallbackMessages(
  messages:
    | Array<{
        role: "system" | "user" | "assistant";
        content: string | Array<{ type: string; text?: string | undefined }>;
      }>
    | undefined,
  question: string,
): AiMessage[] {
  const list: AiMessage[] = (messages ?? [])
    .map((m) => ({ role: m.role, content: textOnly(m.content) }))
    .filter((m) => m.content.length > 0);
  const last = list[list.length - 1];
  if (last && last.role === "user") last.content = question;
  else list.push({ role: "user", content: question });
  return list;
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

function sseSingle(conversationId: string, content: string): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ conversationId })}\n\n`));
      controller.enqueue(
        enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`),
      );
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

async function callGeneralAi(messages: AiMessage[]): Promise<{ text: string; usage: unknown }> {
  const res = await fetch(`${AI_BASE}/chat/completions`, {
    method: "POST",
    headers: aiHeaders(),
    body: JSON.stringify({ model: AI_MODEL, messages, stream: false }),
  });
  if (!res.ok) throw new Error(`model umum merespons ${res.status}`);
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: unknown;
  };
  return { text: data.choices?.[0]?.message?.content ?? "", usage: data.usage ?? null };
}

/** Jawaban model umum dipotong sama format SSE lama: conversationId -> token -> [DONE]. */
async function streamGeneralAi(messages: AiMessage[], conversationId: string): Promise<Response> {
  const aiRes = await fetch(`${AI_BASE}/chat/completions`, {
    method: "POST",
    headers: aiHeaders(),
    body: JSON.stringify({ model: AI_MODEL, messages, stream: true }),
  });
  if (!aiRes.ok || !aiRes.body) {
    const detail = await aiRes.text().catch(() => "");
    return sseSingle(conversationId, `Model umum tidak dapat diakses (${aiRes.status}). ${detail}`);
  }

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const upstream = aiRes.body;
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ conversationId })}\n\n`));
      const reader = upstream.getReader();
      let sawDone = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = dec.decode(value, { stream: true });
          if (chunk.includes("[DONE]")) sawDone = true;
          controller.enqueue(enc.encode(chunk));
        }
      } catch {
        // koneksi putus di tengah: tutup stream apa adanya
      }
      if (!sawDone) controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

/**
 * Galat RAG yang TIDAK boleh di-fallback (antre / key salah) -> Response awal;
 * selain itu null supaya lanjut ke fallback model umum.
 */
function ragErrorResponse(c: Context, e: unknown): Response | null {
  if (e instanceof RagBusyError) {
    return c.json(
      {
        error: "rag_sibuk",
        retry_after: e.retryAfter,
        message: `Server sedang antre, coba lagi sekitar ${e.retryAfter} detik.`,
      },
      503,
      { "Retry-After": String(e.retryAfter) },
    );
  }
  if (e instanceof RagAuthError) {
    return c.json({ error: "rag_auth", message: "Key layanan RAG ditolak. Hubungi admin." }, 502);
  }
  console.error("RAG gagal, memakai model umum:", e);
  return null;
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

    // ── Jalur utama: layanan RAG (chatbot BPS Kalteng) ──
    if (ragEnabled()) {
      try {
        const answer = await ragAsk(question);
        return c.json({
          id: crypto.randomUUID(),
          conversationId,
          text: formatRagAnswer(answer),
          usage: null,
          via: "rag",
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        const early = ragErrorResponse(c, err);
        if (early) return early;
        try {
          const { text, usage } = await callGeneralAi(fallbackMessages(body.messages, question));
          return c.json({
            id: crypto.randomUUID(),
            conversationId,
            text,
            usage,
            via: "fallback",
            createdAt: new Date().toISOString(),
          });
        } catch (fallbackErr) {
          console.error("[AI Fallback Error]:", fallbackErr);
          const detail = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          return c.json({ error: "Gagal menghubungi layanan RAG dan model umum", detail }, 502);
        }
      }
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

    // ── Jalur utama: layanan RAG (jawaban datang utuh, Hub yang memotong) ──
    if (ragEnabled()) {
      try {
        const answer = await ragAsk(question);
        return ragSseResponse(formatRagAnswer(answer), conversationId);
      } catch (err) {
        const early = ragErrorResponse(c, err);
        if (early) return early;
        try {
          return await streamGeneralAi(fallbackMessages(body.messages, question), conversationId);
        } catch (fallbackErr) {
          console.error("[AI Fallback Stream Error]:", fallbackErr);
          const detail = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          return sseSingle(
            conversationId,
            `Tidak dapat terhubung ke layanan RAG maupun model umum.\n\n${detail}`,
          );
        }
      }
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
