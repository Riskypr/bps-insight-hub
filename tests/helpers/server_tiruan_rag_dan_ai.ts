/**
 * Server tiruan untuk tes Hub.
 *  - FakeRag : meniru layanan RAG (Flask) persis sesuai KONTRAK_API_RAG.md
 *  - FakeAi  : meniru API model umum (AI_API_BASE, format OpenAI) untuk uji fallback
 * Keduanya berjalan di port acak di mesin lokal; tidak butuh Ollama/Qdrant.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export const RAG_KEY = "kunci-rahasia-uji-123";

export type Call = {
  method: string;
  path: string;
  auth: string | undefined;
  headers: http.IncomingHttpHeaders;
  json?: any;
  form?: { file?: { name: string; size: number }; fields: Record<string, string> };
};

export type RagMode = "ok" | "busy" | "notready" | "error500" | "down" | "slow";

// 1x1 PNG valid
export const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

// ── Contoh respons /api/ask (bentuk sama dengan kontrak) ──
const base = {
  mode: "qa", answer: "", warning: null, note: null, combined: false, combined_titles: [],
  breadth_hint: null, sources: [] as any[], debug_chunks: [], doc_meta: null,
  image_only: false, featured_image: null as any, cached: false, cache_match: null,
};
export const askQa = () => ({
  ...base,
  answer: "Tingkat Pengangguran Terbuka Kalimantan Tengah sekitar 4,1 persen.",
  sources: [{ title: "Keadaan Angkatan Kerja Kalimantan Tengah", link: "https://x.test/pub", raw_score: 3.2,
    percent: 87, pages: ["12"], cited_pages: ["12"], images: [] }],
});
export const askWarning = () => ({ ...askQa(), warning: "Skor relevansi rendah, jawaban belum tentu tepat." });
// Bentuk NYATA dari chat.py: f"/static/sop_images/{quote(name)}", name = "<nama pdf>_p<halaman>.png"
// dan nama PDF SOP memuat spasi -> di URL menjadi %20.
export const SOP_IMG = "62551.11%20SOP%20Pengolahan%20Data_p5.png";
const sopImg = { page: "5", url: `/static/sop_images/${SOP_IMG}`, text_reliable: true };
export const askSop = () => ({
  ...base,
  answer: "Langkah pertama SOP adalah menyiapkan berkas.",
  sources: [{ title: "SOP Pengolahan Data", link: null, raw_score: 2.5, percent: 70, pages: ["5"], cited_pages: ["5"], images: [sopImg] }],
  featured_image: { url: sopImg.url, page: "5", title: "SOP Pengolahan Data" },
});
export const askImageOnly = () => ({
  ...askSop(),
  answer: "Teks halaman SOP ini tidak andal; lihat gambar halaman di bawah.",
  image_only: true,
});
export const askList = () => ({
  ...base, mode: "list_publications",
  answer: "Ditemukan publikasi berikut:\n- Publikasi A 2024 — https://x.test/a\n- Publikasi B 2025 — https://x.test/b\n- Publikasi C 2025 — https://x.test/c",
});

// ── util ──
function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => res(Buffer.concat(chunks)));
  });
}
function listen(server: http.Server): Promise<number> {
  return new Promise((res) => server.listen(0, "127.0.0.1", () => res((server.address() as AddressInfo).port)));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FakeRag {
  server!: http.Server;
  port = 0;
  calls: Call[] = [];
  mode: RagMode = "ok";
  delayMs = 1500;
  askResponse: any = askQa();
  ingestResult: { status: number; body: any; headers?: Record<string, string> } | null = null;
  private jobSeq = 0;

  get url() { return `http://127.0.0.1:${this.port}`; }
  callsTo(path: string) { return this.calls.filter((c) => c.path === path); }
  reset() {
    this.calls = []; this.mode = "ok"; this.delayMs = 1500; this.askResponse = askQa();
    this.ingestResult = null; this.jobSeq = 0;
  }

  async start() {
    this.server = http.createServer(async (req, res) => {
      const raw = await readBody(req);
      const url = new URL(req.url ?? "/", "http://x");
      const call: Call = { method: req.method ?? "GET", path: url.pathname, auth: req.headers.authorization, headers: req.headers };
      const ct = String(req.headers["content-type"] ?? "");
      if (ct.includes("application/json") && raw.length) { try { call.json = JSON.parse(raw.toString("utf8")); } catch { /* abaikan */ } }
      if (ct.includes("multipart/form-data")) {
        const fd = await new Response(raw, { headers: { "content-type": ct } }).formData();
        const fields: Record<string, string> = {}; let file: Call["form"] extends infer T ? any : never;
        for (const [k, v] of fd.entries()) {
          if (v instanceof File) file = { name: v.name, size: v.size }; else fields[k] = String(v);
        }
        call.form = { file, fields };
      }
      this.calls.push(call);

      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "Content-Type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      };
      const isApi = call.path.startsWith("/api/") && call.path !== "/api/health";

      if (this.mode === "down") { req.socket.destroy(); return; }
      if (this.mode === "slow" && isApi) await sleep(this.delayMs);
      if (this.mode === "notready" && isApi) return send(503, { error: "Server belum siap, tunggu beberapa saat lalu coba lagi." });
      if (this.mode === "error500" && isApi) return send(500, { error: "kesalahan internal" });
      if (isApi && call.auth !== `Bearer ${RAG_KEY}`) return send(401, { error: "Tidak diizinkan." });

      if (call.method === "GET" && call.path === "/api/health")
        return send(200, { ready: true, queue: { active: 0, waiting: 0, max_concurrent: 1, max_waiting: 10 } });

      if (call.method === "POST" && call.path === "/api/ask") {
        if (this.mode === "busy")
          return send(503, { error: "server_sibuk", reason: "antrean_penuh", retry_after: 30, message: "Sedang antre." }, { "Retry-After": "30" });
        return send(200, this.askResponse);
      }
      if (call.method === "POST" && call.path === "/api/ingest") {
        if (this.ingestResult) return send(this.ingestResult.status, this.ingestResult.body, this.ingestResult.headers);
        const id = `job-${++this.jobSeq}`;
        return send(202, { job_id: id, filename: call.form?.file?.name ?? "", title: call.form?.fields.title ?? "",
          kategori: "", jenis: "publikasi", jenis_basis: "tidak_ada_header_sop", status: "PENDING", chunks: 0,
          error: "", catatan: "", uploader: call.form?.fields.uploader ?? "", progress: "" });
      }
      const m = call.path.match(/^\/api\/ingest\/([^/]+)$/);
      if (call.method === "GET" && m) {
        if (m[1] === "job-unknown") return send(404, { error: "Job tidak ditemukan." });
        return send(200, { job_id: m[1], status: "PROCESSING", progress: "tahap 4 dari 5", chunks: 0, error: "", catatan: "" });
      }
      if (call.method === "GET" && call.path.startsWith("/static/sop_images/")) {
        if (call.path.endsWith("hilang.png")) { res.writeHead(404); return res.end("nf"); }
        res.writeHead(200, { "Content-Type": "image/png" }); return res.end(PNG_BYTES);
      }
      send(404, { error: "tidak ada" });
    });
    this.port = await listen(this.server);
  }
  stop() { this.server.closeAllConnections?.(); return new Promise<void>((r) => this.server.close(() => r())); }
}

export class FakeAi {
  server!: http.Server;
  port = 0;
  calls: Call[] = [];
  get url() { return `http://127.0.0.1:${this.port}/v1`; }
  reset() { this.calls = []; }
  async start() {
    this.server = http.createServer(async (req, res) => {
      const raw = await readBody(req);
      let json: any; try { json = JSON.parse(raw.toString("utf8")); } catch { /* */ }
      this.calls.push({ method: req.method ?? "", path: req.url ?? "", auth: req.headers.authorization, headers: req.headers, json });
      if (json?.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "FALLBACK_JAWABAN" } }] })}\n\n`);
        res.write("data: [DONE]\n\n"); return res.end();
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "FALLBACK_JAWABAN" } }], usage: null }));
    });
    this.port = await listen(this.server);
  }
  stop() { this.server.closeAllConnections?.(); return new Promise<void>((r) => this.server.close(() => r())); }
}
