/**
 * TES INTEGRASI HUB <-> LAYANAN RAG (BPS Kalteng)
 *
 * Tujuan: memastikan API Hub (Hono, folder api/) memakai layanan RAG dengan
 * benar, sesuai KONTRAK_API_RAG.md. Layanan RAG diganti server tiruan
 * (tests/helpers/server_tiruan_rag_dan_ai.ts), jadi tes ini berjalan tanpa Ollama/Qdrant.
 *
 * Cara pakai: lihat 00_BACA_DULU_PANDUAN.md. Jalankan:  npx vitest run
 * Bagian CFG di bawah adalah SATU-SATUNYA tempat nama env/route yang boleh
 * disesuaikan bila tim Hub dan backend sepakat memakai nama lain.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAi, FakeRag, PNG_BYTES, RAG_KEY, SOP_IMG, askImageOnly, askList, askQa, askSop, askWarning } from "./helpers/server_tiruan_rag_dan_ai";

// ───────────────────────── KESEPAKATAN NAMA ─────────────────────────
const CFG = {
  envRagBase: "RAG_API_BASE",      // alamat layanan RAG, mis. http://localhost:5000
  envRagKey: "RAG_API_KEY",        // key Bearer (SAMA dengan RAG_API_KEY di sisi backend)
  envRagTimeout: "RAG_TIMEOUT_MS", // batas tunggu Hub ke RAG (produksi disarankan 180000)
  chatSend: "/chat/send",
  chatStream: "/chat/stream",
  upload: "/v1/pdfs/upload",
  imageRoute: "/rag/sop-image/",       // GET {imageRoute}{nama-file}.png  -> gambar halaman SOP
  jobRoute: "/v1/pdfs/rag-jobs/",      // GET {jobRoute}{job_id}          -> status ingest dari RAG
  replaceField: "replace",             // field form upload (nilai "true") untuk mengganti versi
};
// ────────────────────────────────────────────────────────────────────

// Database & penyimpanan file dipalsukan: tes ini tidak butuh Postgres.
const store = vi.hoisted(() => ({ created: [] as any[], existing: null as any }));
vi.mock("../api/lib/prisma", () => ({
  prisma: {
    pdfFile: {
      findUnique: async () => store.existing,
      findFirst: async () => store.existing,
      findMany: async () => [],
      count: async () => 0,
      create: async ({ data }: any) => { store.created.push(data); return { ...data }; },
      update: async ({ data }: any) => ({ ...data }),
      delete: async () => ({}),
    },
    $queryRaw: async () => [],
  },
}));
vi.mock("../api/lib/pdf-storage", () => ({
  pdfStorage: { put: async () => {}, get: async () => Buffer.from("%PDF-1.4"), remove: async () => {} },
}));

const rag = new FakeRag();
const ai = new FakeAi();
beforeAll(async () => { await rag.start(); await ai.start(); });
afterAll(async () => { await rag.stop(); await ai.stop(); });

let app: { request: (input: string | Request, init?: RequestInit) => Response | Promise<Response> };
async function loadApp(extraEnv: Record<string, string> = {}) {
  vi.resetModules();
  process.env[CFG.envRagBase] = rag.url;
  process.env[CFG.envRagKey] = RAG_KEY;
  process.env[CFG.envRagTimeout] = "5000";
  process.env.AI_API_BASE = ai.url;
  Object.assign(process.env, extraEnv);
  app = (await import("../api/index")).default as typeof app;
}
beforeEach(async () => {
  rag.reset(); ai.reset(); store.created = []; store.existing = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
  await loadApp();
});

// ── helper ──
const postJson = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const chat = (message: string) => postJson(CFG.chatSend, { message });
const pdf = (tag = crypto.randomUUID()) => new TextEncoder().encode(`%PDF-1.4\n% ${tag}\n%%EOF\n`);
function upload(files: { name: string; data?: Uint8Array }[], opts: { metadata?: unknown; replace?: boolean; user?: string } = {}) {
  const fd = new FormData();
  for (const f of files) fd.append("files", new File([f.data ?? pdf()], f.name, { type: "application/pdf" }));
  if (opts.metadata) fd.append("metadata", JSON.stringify(opts.metadata));
  if (opts.replace) fd.append(CFG.replaceField, "true");
  return app.request(CFG.upload, { method: "POST", body: fd, headers: opts.user ? { "x-user-id": opts.user } : {} });
}
const sseEvents = (raw: string) =>
  raw.split("\n\n").map((b) => b.trim()).filter((b) => b.startsWith("data:")).map((b) => b.slice(5).trim());
const imageBlock = (text: string) => {
  const m = text.match(/```image\s*\n([\s\S]*?)\n```/);
  return m ? JSON.parse(m[1]) : null;
};

// ═════════════════════════ A. Chat lewat RAG ═════════════════════════
describe("A. Chat (/chat/send) memakai layanan RAG", () => {
  it("A1 meneruskan pertanyaan ke RAG /api/ask dengan Authorization Bearer", async () => {
    await chat("Berapa TPT Kalteng?");
    const calls = rag.callsTo("/api/ask");
    expect(calls).toHaveLength(1);
    expect(calls[0].auth).toBe(`Bearer ${RAG_KEY}`);
    expect(calls[0].json.question).toBe("Berapa TPT Kalteng?");
  });

  it("A2 jawaban RAG sampai ke pengguna; field lama tetap ada; via='rag'", async () => {
    const res = await chat("Berapa TPT Kalteng?");
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.text).toContain("4,1 persen");
    expect(j.via).toBe("rag");
    expect(typeof j.id).toBe("string");
    expect(typeof j.conversationId).toBe("string");
    expect(typeof j.createdAt).toBe("string");
  });

  it("A3 riwayat percakapan: hanya pertanyaan TERAKHIR (teks saja) yang dikirim ke RAG", async () => {
    await postJson(CFG.chatSend, {
      messages: [
        { role: "user", content: "Halo" },
        { role: "assistant", content: "Hai, ada yang bisa dibantu?" },
        { role: "user", content: [
          { type: "text", text: "pertanyaan akhir saya" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ] },
      ],
    });
    const calls = rag.callsTo("/api/ask");
    expect(calls).toHaveLength(1);
    expect(calls[0].json.question).toBe("pertanyaan akhir saya");
  });

  it("A4 pesan kosong -> 400 dan RAG tidak dipanggil", async () => {
    const res = await postJson(CFG.chatSend, {});
    expect(res.status).toBe(400);
    expect(rag.callsTo("/api/ask")).toHaveLength(0);
  });

  it("A5 warning dari RAG ikut ditampilkan (tidak dibuang)", async () => {
    rag.askResponse = askWarning();
    const j = await (await chat("uji")).json();
    expect(j.text).toContain("Skor relevansi rendah");
  });

  it("A6 judul sumber dicantumkan di jawaban", async () => {
    const j = await (await chat("uji")).json();
    expect(j.text).toContain("Keadaan Angkatan Kerja Kalimantan Tengah");
  });

  it("A7 SOP: featured_image tampil sebagai blok ```image lewat proxy Hub (bukan alamat Flask)", async () => {
    rag.askResponse = askSop();
    const j = await (await chat("prosedur SOP")).json();
    expect(j.text).toContain("menyiapkan berkas");
    const img = imageBlock(j.text);
    expect(img, "harus ada blok ```image berisi JSON").not.toBeNull();
    expect(img.url).toContain(CFG.imageRoute + SOP_IMG);
    expect(img.url).not.toContain(rag.url);
    expect(img.url).not.toContain("/static/sop_images/");
    expect(img.url, "nama file tetap ter-encode (%20), jangan di-decode/diubah").toContain("62551.11%20SOP");
  });

  it("A8 image_only: pesan penjelasan dari RAG + gambar tetap tampil", async () => {
    rag.askResponse = askImageOnly();
    const j = await (await chat("prosedur SOP")).json();
    expect(j.text).toContain("tidak andal");
    expect(imageBlock(j.text)?.url).toContain(CFG.imageRoute + SOP_IMG);
  });

  it("A9 daftar publikasi: tidak ada baris berawalan '- ' (akan terpotong extractSuggestions di frontend)", async () => {
    rag.askResponse = askList();
    const j = await (await chat("daftar publikasi")).json();
    expect(j.text).toContain("Publikasi A 2024");
    expect(j.text).toContain("Publikasi C 2025");
    const bullets = j.text.split("\n").filter((l: string) => /^\s*-\s/.test(l));
    expect(bullets, "ganti '- ' menjadi '* ' (atau bentuk lain) agar daftar tidak terpotong").toHaveLength(0);
  });

  it("A10 API key RAG tidak bocor ke respons", async () => {
    const res = await chat("uji");
    const body = await res.json();
    expect(body.text, "kontrol: jawaban RAG harus benar-benar sampai").toContain("4,1 persen");
    const dump = JSON.stringify(body) + JSON.stringify([...res.headers.entries()]);
    expect(dump).not.toContain(RAG_KEY);
  });
});

// ═════════════════ B. Error dari RAG: antre, gagal, fallback ═════════════════
describe("B. Penanganan error RAG", () => {
  it("B1 503 server_sibuk -> Hub 503 {error:'rag_sibuk', retry_after}, tanpa retry & tanpa fallback", async () => {
    rag.mode = "busy";
    const res = await chat("uji");
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.error).toBe("rag_sibuk");
    expect(j.retry_after).toBe(30);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(rag.callsTo("/api/ask"), "jangan kirim ulang otomatis").toHaveLength(1);
    expect(ai.calls, "antre bukan alasan untuk fallback").toHaveLength(0);
  });

  it("B2 RAG belum siap (503 biasa) -> fallback ke model umum, via='fallback'", async () => {
    rag.mode = "notready";
    const res = await chat("uji");
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.via).toBe("fallback");
    expect(j.text).toContain("FALLBACK_JAWABAN");
    expect(ai.calls).toHaveLength(1);
  });

  it("B3 RAG mati/tidak terjangkau -> fallback", async () => {
    rag.mode = "down";
    const j = await (await chat("uji")).json();
    expect(j.via).toBe("fallback");
    expect(j.text).toContain("FALLBACK_JAWABAN");
  });

  it("B4 RAG error 500 -> fallback", async () => {
    rag.mode = "error500";
    const j = await (await chat("uji")).json();
    expect(j.via).toBe("fallback");
  });

  it("B5 melewati batas waktu (RAG_TIMEOUT_MS) -> fallback", async () => {
    await loadApp({ [CFG.envRagTimeout]: "400" });
    rag.mode = "slow"; rag.delayMs = 1500;
    const t0 = Date.now();
    const j = await (await chat("uji")).json();
    expect(j.via).toBe("fallback");
    expect(Date.now() - t0).toBeLessThan(1400);
  });

  it("B6 key salah di Hub (RAG menjawab 401) -> jangan diam-diam fallback", async () => {
    await loadApp({ [CFG.envRagKey]: "key-salah" });
    const res = await chat("uji");
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(ai.calls).toHaveLength(0);
  });
});

// ═════════════════════════ C. Streaming ═════════════════════════
describe("C. Streaming (/chat/stream)", () => {
  it("C1 format SSE: event conversationId, potongan token (delta.content), lalu [DONE]", async () => {
    const res = await postJson(CFG.chatStream, { message: "Berapa TPT Kalteng?" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const ev = sseEvents(await res.text());
    expect(JSON.parse(ev[0]).conversationId).toBeTruthy();
    expect(ev[ev.length - 1]).toBe("[DONE]");
    const tokens = ev.slice(1, -1).map((e) => JSON.parse(e).choices?.[0]?.delta?.content ?? "").join("");
    expect(tokens).toContain("4,1 persen");
    expect(rag.callsTo("/api/ask")).toHaveLength(1);
  });

  it("C2 stream + SOP: blok gambar ikut terkirim", async () => {
    rag.askResponse = askSop();
    const ev = sseEvents(await (await postJson(CFG.chatStream, { message: "prosedur SOP" })).text());
    const tokens = ev.slice(1, -1).map((e) => JSON.parse(e).choices?.[0]?.delta?.content ?? "").join("");
    expect(imageBlock(tokens)?.url).toContain(CFG.imageRoute + SOP_IMG);
  });

  it("C3 stream + server_sibuk -> respons 503 JSON biasa (bukan SSE)", async () => {
    rag.mode = "busy";
    const res = await postJson(CFG.chatStream, { message: "uji" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("rag_sibuk");
  });

  it("C4 stream + RAG mati -> fallback tetap berupa SSE", async () => {
    rag.mode = "down";
    const res = await postJson(CFG.chatStream, { message: "uji" });
    expect(rag.callsTo("/api/ask"), "kontrol: RAG harus dicoba dulu").toHaveLength(1);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toContain("FALLBACK_JAWABAN");
  });
});

// ═══════════════════ D. Proxy gambar halaman SOP ═══════════════════
describe("D. Proxy gambar SOP", () => {
  it("D1 mengambil gambar dari RAG dan meneruskannya (image/png, byte identik)", async () => {
    const res = await app.request(`${CFG.imageRoute}${SOP_IMG}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG_BYTES)).toBe(true);
    expect(rag.calls.map((c) => c.path)).toContain(`/static/sop_images/${SOP_IMG}`);
  });

  it("D1b nama file SOP asli (spasi, kurung, huruf non-ASCII) diterima & diteruskan ke RAG", async () => {
    const asli = "62551.11 SOP Penyusunan (Revisi) Unit Pengolahan_p3.png";
    const res = await app.request(`${CFG.imageRoute}${encodeURIComponent(asli)}`);
    expect(res.status, "regex nama file terlalu ketat? nama SOP asli memuat spasi").toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG_BYTES)).toBe(true);
    const path = decodeURIComponent(rag.calls.at(-1)!.path);
    expect(path).toBe(`/static/sop_images/${asli}`);
  });

  it("D2 nama file berbahaya ditolak & tidak pernah diteruskan ke RAG", async () => {
    expect((await app.request(`${CFG.imageRoute}${SOP_IMG}`)).status, "kontrol: nama sah harus 200").toBe(200);
    rag.calls = [];
    const bad = ["..%2F..%2Fapi%2Fhealth", "%2e%2e%2fapi%2fask", "a%2Fb.png", "..%5Cx.png", "x.png%00.html"];
    for (const name of bad) {
      const res = await app.request(`${CFG.imageRoute}${name}`);
      expect([400, 404], `nama: ${name}`).toContain(res.status);
    }
    expect(rag.calls.filter((c) => !c.path.startsWith("/static/sop_images/"))).toHaveLength(0);
    expect(rag.calls.filter((c) => c.path.includes(".."))).toHaveLength(0);
  });

  it("D3 hanya ekstensi gambar (png/jpg/jpeg/webp) yang boleh", async () => {
    expect((await app.request(`${CFG.imageRoute}${SOP_IMG}`)).status, "kontrol: png harus 200").toBe(200);
    rag.calls = [];
    for (const name of ["catatan.html", "app.py", "data.json"]) {
      const res = await app.request(`${CFG.imageRoute}${name}`);
      expect([400, 404], `nama: ${name}`).toContain(res.status);
    }
    expect(rag.calls).toHaveLength(0);
  });

  it("D4 gambar tidak ada di RAG -> 404", async () => {
    const res = await app.request(`${CFG.imageRoute}hilang.png`);
    expect(rag.calls.map((c) => c.path), "kontrol: harus ditanyakan ke RAG").toContain("/static/sop_images/hilang.png");
    expect(res.status).toBe(404);
  });
});

// ═════════════════ E. Upload PDF (drag & drop) -> ingest RAG ═════════════════
describe("E. Upload PDF diteruskan ke RAG /api/ingest", () => {
  it("E1 file diteruskan dengan NAMA ASLI, Bearer key, title & uploader", async () => {
    await upload([{ name: "Laporan Uji 2025.pdf" }], { metadata: [{ title: "Judul Uji", category: "Uji" }], user: "budi" });
    const calls = rag.callsTo("/api/ingest");
    expect(calls).toHaveLength(1);
    expect(calls[0].auth).toBe(`Bearer ${RAG_KEY}`);
    expect(calls[0].form?.file?.name, "kunci dokumen di Qdrant = nama asli, bukan <uuid>.pdf").toBe("Laporan Uji 2025.pdf");
    expect(calls[0].form?.fields.title).toBe("Judul Uji");
    expect(calls[0].form?.fields.uploader).toBe("budi");
  });

  it("E2 hasil per file memuat ragJobId & ragStatus (status Hub tetap SUCCESS)", async () => {
    const j = await (await upload([{ name: "A.pdf" }])).json();
    const item = j.data[0];
    expect(item.status).toBe("SUCCESS");
    expect(item.ragJobId).toBe("job-1");
    expect(item.ragStatus).toBe("PENDING");
    expect(item.originalName).toBe("A.pdf");
  });

  it("E3 beberapa file -> tiap file dikirim sendiri-sendiri dengan job berbeda", async () => {
    const j = await (await upload([{ name: "A.pdf" }, { name: "B.pdf" }, { name: "C.pdf" }])).json();
    const names = rag.callsTo("/api/ingest").map((c) => c.form?.file?.name);
    expect(names).toEqual(["A.pdf", "B.pdf", "C.pdf"]);
    expect(new Set(j.data.map((d: any) => d.ragJobId)).size).toBe(3);
  });

  it("E4 RAG menjawab SKIPPED (bukan dokumen terdaftar) -> item SKIPPED + alasan, bukan galat", async () => {
    rag.ingestResult = { status: 200, body: { job_id: "job-x", status: "SKIPPED", jenis: "",
      catatan: "Dilewati: PDF ini tidak dikenali sebagai publikasi atau SOP BPS Kalteng." } };
    const res = await upload([{ name: "resep.pdf" }]);
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.data[0].status).toBe("SKIPPED");
    expect(j.data[0].ragStatus).toBe("SKIPPED");
    expect(j.data[0].reason).toContain("Dilewati");
    expect(j.summary.failed).toBe(0);
  });

  it("E5 RAG 409 isi identik -> item SKIPPED, ragStatus DUPLICATE, ragJobId = existing_job_id", async () => {
    rag.ingestResult = { status: 409, body: { error: "Isi file identik", existing_job_id: "job-lama",
      existing_filename: "A.pdf", existing_status: "INDEXED" } };
    const item = (await (await upload([{ name: "A.pdf" }])).json()).data[0];
    expect(item.status).toBe("SKIPPED");
    expect(item.ragStatus).toBe("DUPLICATE");
    expect(item.ragJobId).toBe("job-lama");
  });

  it("E6 RAG 409 nama sama isi beda -> ragStatus NAME_CONFLICT + existingChunks (bisa dikirim ulang dgn replace)", async () => {
    rag.ingestResult = { status: 409, body: { error: "Nama file sudah ada", existing_chunks: 130 } };
    const item = (await (await upload([{ name: "A.pdf" }])).json()).data[0];
    expect(item.status).not.toBe("SUCCESS");
    expect(item.ragStatus).toBe("NAME_CONFLICT");
    expect(item.existingChunks).toBe(130);
  });

  it("E7 field replace=true diteruskan ke RAG", async () => {
    await upload([{ name: "A.pdf" }], { replace: true });
    expect(rag.callsTo("/api/ingest")[0].form?.fields.replace).toBe("true");
  });

  it("E8 tanpa replace, field replace tidak dikirim", async () => {
    await upload([{ name: "A.pdf" }]);
    expect(rag.callsTo("/api/ingest")[0].form?.fields.replace).toBeUndefined();
  });

  it("E9 RAG mati -> file tetap tersimpan di Hub, ragStatus UNAVAILABLE (unggahan tidak gagal total)", async () => {
    rag.mode = "down";
    const res = await upload([{ name: "A.pdf" }]);
    const item = (await res.json()).data[0];
    expect(item.status).toBe("SUCCESS");
    expect(item.ragStatus).toBe("UNAVAILABLE");
    expect(store.created).toHaveLength(1);
  });

  it("E10 file yang bukan PDF tidak dikirim ke RAG", async () => {
    const fd = new FormData();
    fd.append("files", new File(["bukan pdf"], "catatan.pdf", { type: "application/pdf" }));
    fd.append("files", new File([pdf()], "sah.pdf", { type: "application/pdf" }));
    const res = await app.request(CFG.upload, { method: "POST", body: fd });
    const data = (await res.json()).data;
    expect(data[0].status).toBe("FAILED");
    expect(data[1].status).toBe("SUCCESS");
    expect(rag.callsTo("/api/ingest").map((c) => c.form?.file?.name)).toEqual(["sah.pdf"]);
  });

  it("E11 API key RAG tidak bocor di respons upload", async () => {
    const res = await upload([{ name: "A.pdf" }]);
    const body = await res.json();
    expect(body.data[0].ragJobId, "kontrol: upload harus sampai ke RAG").toBe("job-1");
    expect(JSON.stringify(body)).not.toContain(RAG_KEY);
  });
});

// ═════════════════ F. Status ingest (polling dari frontend) ═════════════════
describe("F. Status job ingest", () => {
  it("F1 GET {jobRoute}{id} meneruskan status dari RAG (status, progress, chunks, error)", async () => {
    const res = await app.request(`${CFG.jobRoute}job-1`);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.status).toBe("PROCESSING");
    expect(j.progress).toBe("tahap 4 dari 5");
    expect(rag.callsTo("/api/ingest/job-1")[0].auth).toBe(`Bearer ${RAG_KEY}`);
  });

  it("F2 job tidak ada -> 404", async () => {
    const res = await app.request(`${CFG.jobRoute}job-unknown`);
    expect(rag.callsTo("/api/ingest/job-unknown"), "kontrol: harus ditanyakan ke RAG").toHaveLength(1);
    expect(res.status).toBe(404);
  });

  it("F3 job_id berbahaya ditolak & tidak diteruskan", async () => {
    expect((await app.request(`${CFG.jobRoute}job-1`)).status, "kontrol: id sah harus 200").toBe(200);
    const res = await app.request(`${CFG.jobRoute}..%2F..%2Fapi%2Fhealth`);
    expect([400, 404]).toContain(res.status);
    expect(rag.calls.filter((c) => c.path === "/api/health")).toHaveLength(0);
  });

  it("F4 RAG mati -> 502/503 (bukan 200 palsu, bukan crash)", async () => {
    rag.mode = "down";
    const res = await app.request(`${CFG.jobRoute}job-1`);
    expect([502, 503]).toContain(res.status);
  });
});
