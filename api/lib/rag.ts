// Klien layanan RAG BPS Kalteng (Flask). Acuan: KONTRAK_API_RAG.md
// Semua konfigurasi dibaca dari env saat dipanggil (bukan saat modul dimuat),
// supaya perubahan .env terbaca tanpa memuat ulang modul.

type RagCfg = { base: string; key: string; timeout: number };

function cfg(): RagCfg {
  const timeout = Number(process.env["RAG_TIMEOUT_MS"] ?? 180_000);
  return {
    base: (process.env["RAG_API_BASE"] ?? "").replace(/\/+$/, ""),
    key: process.env["RAG_API_KEY"] ?? "",
    timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 180_000,
  };
}

/** false = fitur RAG mati (RAG_API_BASE kosong), Hub berperilaku seperti biasa. */
export const ragEnabled = (): boolean => Boolean(cfg().base);

/** 503 {"error":"server_sibuk"} = antrean penuh. TIDAK boleh di-fallback. */
export class RagBusyError extends Error {
  retryAfter: number;
  constructor(retryAfter: number) {
    super("rag_sibuk");
    this.name = "RagBusyError";
    this.retryAfter = retryAfter;
  }
}

/** 401 dari RAG = key salah di Hub. TIDAK boleh di-fallback diam-diam. */
export class RagAuthError extends Error {
  constructor() {
    super("rag_auth");
    this.name = "RagAuthError";
  }
}

/** RAG mati, timeout, atau jawaban 5xx. Boleh di-fallback ke model umum. */
export class RagUnavailableError extends Error {
  constructor(message?: string) {
    super(message ?? "rag_tidak_tersedia");
    this.name = "RagUnavailableError";
  }
}

/** fetch ke RAG dengan key + batas waktu. Galat jaringan/timeout -> RagUnavailableError. */
export async function ragFetch(
  path: string,
  init: RequestInit = {},
  withKey = true,
): Promise<Response> {
  const { base, key, timeout } = cfg();
  const headers = new Headers(init.headers);
  if (withKey && key) headers.set("Authorization", `Bearer ${key}`);
  try {
    return await fetch(`${base}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new RagUnavailableError(e instanceof Error ? e.message : String(e));
  }
}

export type RagSource = {
  title?: string | null;
  pages?: string[] | null;
  cited_pages?: string[] | null;
};

export type RagAnswer = {
  mode?: string;
  answer: string;
  warning?: string | null;
  note?: string | null;
  sources?: RagSource[] | null;
  image_only?: boolean;
  featured_image?: { url: string; page?: string | null; title?: string | null } | null;
};

/** POST /api/ask. Satu pertanyaan berdiri sendiri (RAG belum punya riwayat). */
export async function ragAsk(question: string): Promise<RagAnswer> {
  const res = await ragFetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });

  if (res.status === 401) throw new RagAuthError();

  if (res.status === 503) {
    const j = (await res.json().catch(() => ({}))) as { error?: string; retry_after?: number };
    if (j.error === "server_sibuk") throw new RagBusyError(Number(j.retry_after) || 30);
    throw new RagUnavailableError("RAG belum siap");
  }

  if (!res.ok) throw new RagUnavailableError(`RAG ${res.status}`);
  return (await res.json()) as RagAnswer;
}

/** URL proxy gambar SOP di server Hub (browser tidak boleh menembak Flask langsung). */
const imagePrefix = (): string => `${process.env["PUBLIC_API_PREFIX"] ?? "/api"}/rag/sop-image/`;

/**
 * Susun jawaban RAG jadi markdown untuk bubble chat.
 * Baris berawalan '- ' diganti '* ': frontend memotong baris '- ' sebagai saran
 * (extractSuggestions), jadi daftar publikasi akan hilang kalau dibiarkan.
 */
export function formatRagAnswer(r: RagAnswer): string {
  const parts: string[] = [];

  parts.push((r.answer ?? "").replace(/^(\s*)-[ \t]/gm, "$1* "));
  if (r.warning) parts.push(`**Peringatan:** ${r.warning}`);
  if (r.note) parts.push(`*${r.note}*`);

  const featured = r.featured_image;
  if (featured?.url) {
    const name = featured.url.split("/").pop() ?? "";
    const title = featured.title ?? "Halaman SOP";
    const caption = featured.page ? `${title}, halaman ${featured.page}` : title;
    const block = { url: `${imagePrefix()}${name}`, alt: title, caption };
    parts.push("```image\n" + JSON.stringify(block) + "\n```");
  }

  const titles = (r.sources ?? []).filter((s) => s?.title);
  if (titles.length) {
    const lines = titles.map((s) => {
      const pages = s.pages?.length ? ` (hlm ${s.pages.join(", ")})` : "";
      return `* ${s.title}${pages}`;
    });
    parts.push(`**Sumber:**\n${lines.join("\n")}`);
  }

  return parts.join("\n\n");
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

/** Jawaban RAG datang utuh, jadi Hub yang memotongnya jadi potongan token (format SSE lama). */
export function ragSseResponse(text: string, conversationId: string): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ conversationId })}\n\n`));
      for (let i = 0; i < text.length; i += 60) {
        const delta = { choices: [{ delta: { content: text.slice(i, i + 60) } }] };
        controller.enqueue(enc.encode(`data: ${JSON.stringify(delta)}\n\n`));
      }
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

export type IngestOutcome = {
  hubStatus: "SUCCESS" | "SKIPPED" | "FAILED";
  storeLocally: boolean;
  reason?: string | undefined;
  fields: { ragJobId?: string | undefined; ragStatus: string; existingChunks?: number | undefined };
};

/** Bentuk objek job yang dikembalikan POST/GET /api/ingest (lihat KONTRAK_API_RAG.md). */
type IngestJobBody = {
  job_id?: string | undefined;
  status?: string | undefined;
  catatan?: string | undefined;
  error?: string | undefined;
  existing_job_id?: string | undefined;
  existing_chunks?: number | undefined;
};

/**
 * Teruskan 1 PDF ke POST /api/ingest dengan NAMA ASLI (jadi kunci dokumen di Qdrant),
 * lalu terjemahkan jawaban RAG jadi status yang dimengerti Hub.
 */
export async function ragIngest(o: {
  name: string;
  content: Uint8Array;
  title?: string | undefined;
  uploader?: string | undefined;
  replace?: boolean | undefined;
}): Promise<IngestOutcome> {
  const fd = new FormData();
  fd.append("file", new File([o.content as BlobPart], o.name, { type: "application/pdf" }));
  if (o.title) fd.append("title", o.title);
  if (o.uploader) fd.append("uploader", o.uploader);
  if (o.replace) fd.append("replace", "true");

  let res: Response;
  try {
    res = await ragFetch("/api/ingest", { method: "POST", body: fd });
  } catch {
    // RAG mati: file tetap tersimpan di Hub, status ingest dicatat UNAVAILABLE.
    return { hubStatus: "SUCCESS", storeLocally: true, fields: { ragStatus: "UNAVAILABLE" } };
  }

  const j = (await res.json().catch(() => ({}))) as IngestJobBody;

  if (res.status === 202) {
    return {
      hubStatus: "SUCCESS",
      storeLocally: true,
      fields: { ragJobId: j.job_id, ragStatus: j.status ?? "PENDING" },
    };
  }
  if (res.status === 200 && j.status === "SKIPPED") {
    return {
      hubStatus: "SKIPPED",
      storeLocally: false,
      reason: String(j.catatan || "Dilewati: bukan publikasi atau SOP BPS Kalteng"),
      fields: { ragJobId: j.job_id, ragStatus: "SKIPPED" },
    };
  }
  if (res.status === 409 && j.existing_job_id) {
    return {
      hubStatus: "SKIPPED",
      storeLocally: false,
      reason: String(j.error || "Isi file identik dengan dokumen yang sudah ada"),
      fields: { ragJobId: j.existing_job_id, ragStatus: "DUPLICATE" },
    };
  }
  if (res.status === 409) {
    return {
      hubStatus: "FAILED",
      storeLocally: false,
      reason: String(j.error || "Nama file sudah ada di chatbot; kirim ulang dengan replace"),
      fields: { ragStatus: "NAME_CONFLICT", existingChunks: j.existing_chunks },
    };
  }
  if (res.status === 401) {
    return {
      hubStatus: "FAILED",
      storeLocally: false,
      reason: "Key layanan RAG ditolak",
      fields: { ragStatus: "AUTH_ERROR" },
    };
  }
  if (res.status >= 400 && res.status < 500) {
    return {
      hubStatus: "FAILED",
      storeLocally: false,
      reason: String(j.error || "Ditolak layanan RAG"),
      fields: { ragStatus: "REJECTED" },
    };
  }
  // 5xx / bentuk respons tak dikenal: jangan buang unggahannya.
  return { hubStatus: "SUCCESS", storeLocally: true, fields: { ragStatus: "UNAVAILABLE" } };
}
