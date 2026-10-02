# Laporan Progress Integrasi AI — BPS Insight Hub (Kalimantan Tengah)

Dokumen ini adalah **satu-satunya catatan progress** integrasi AI di repo ini, disusun dari yang terbaru ke yang paling lama, agar agent/manusia lain bisa mengetahui perubahan (penambahan / perubahan / penghapusan) dengan cepat.

- **Fase terbaru** — Integrasi RAG Chatbot BPS Kalteng (Hub ↔ layanan RAG Flask): ada di bagian pertama setelah garis pemisah.
- **Fase 1 (riwayat)** — Migrasi dari AI Chat Completion API eksternal ke Python RAG Pipeline lokal (`back-end/chat.py`): ada di bagian bawah.

---

# 🆕 FASE TERBARU (2026-10-02) — Integrasi RAG Chatbot BPS Kalteng

> **Baca bagian ini dulu.** Rincian perubahan per file ada di bawah; fase lama (proxy ke `chat.py`) tetap berlaku dan ada di bagian paling bawah dokumen.

**Sumber requirements:** `test_risky_ajudan/paket_RAG_BPS_Kalteng/` — mulai dari `BACA_DULU.md`, lalu `2_HUB_TES_INTEGRASI/00_BACA_DULU_PANDUAN.md`. Kontrak API: `KONTRAK_API_RAG.md`.

### ✅ Status verifikasi

| Pemeriksaan | Hasil |
| :--- | :--- |
| `npm test` (40 tes integrasi Hub ↔ RAG) | ✅ **40/40 lulus** |
| `npm run build` | ✅ Sukses |
| `npx tsc --noEmit` (folder `api/`) | ✅ 23 error = **sama dengan baseline** (tidak ada error baru) |
| `npx eslint api/lib/rag.ts api/routes/rag.ts` | ✅ Bersih |
| `npm run lint` (seluruh repo) | ⚠️ Tetap gagal — **gagal sejak baseline** (576 error prettier/CRLF, bukan akibat perubahan ini) |
| Uji gabungan dengan backend RAG asli (Ollama/Qdrant/Flask) | ⏳ **Belum dilakukan** |

### 📁 Perubahan per file

| Berkas | Aksi | Ringkasan perubahan |
| :--- | :---: | :--- |
| `api/lib/rag.ts` | **BARU** | Klien RAG: `ragFetch` (header `Bearer` + `AbortSignal.timeout(RAG_TIMEOUT_MS)`), `ragAsk` (`POST /api/ask`), `ragIngest` (`POST /api/ingest`), `formatRagAnswer`, `ragSseResponse`. Kelas galat: `RagBusyError` (antre), `RagAuthError` (401), `RagUnavailableError` (mati/timeout/5xx). Konfigurasi dibaca dari env **saat dipanggil**. |
| `api/routes/rag.ts` | **BARU** | Proxy gambar SOP `GET /rag/sop-image/:name` → `GET {RAG}/static/sop_images/<nama>`. Menolak pemisah path (`/` `\`), karakter kontrol/NUL/DEL, awalan titik, ekstensi selain png/jpg/jpeg/webp. **Nama ber-spasi tetap diterima** (didecode lalu di-encode ulang) — validasi `[A-Za-z0-9._-]` sengaja tidak dipakai. |
| `api/index.ts` | **UBAH** | +2 baris: import & `app.route("/rag", ragRoutes)`. |
| `api/routes/chat.ts` | **UBAH** | `/chat/send` dan `/chat/stream` kini mencoba RAG lebih dulu bila `RAG_API_BASE` terisi. `503 server_sibuk` → `503 {error:"rag_sibuk", retry_after}` + header `Retry-After` (**tanpa retry & tanpa fallback**); `401` → `502` (**tanpa fallback diam-diam**); selain itu fallback ke `AI_API_BASE` dengan `via:"fallback"`. Baris `- ` → `* ` (frontend `extractSuggestions` memotong `- `). `featured_image` → blok ` ```image ` yang URL-nya lewat proxy Hub. Riwayat: hanya teks pesan user **terakhir** yang dikirim. Ditambah: helper `callGeneralAi` / `streamGeneralAi` / `sseSingle` / `ragErrorResponse`. |
| `api/routes/pdfs.ts` | **UBAH** | Setiap PDF diteruskan ke `/api/ingest` dengan **nama file asli** + `title`/`uploader`(`x-user-id`)/`replace`. Hasil per file kini memuat `ragJobId` & `ragStatus`: 202→`PENDING`, 200 `SKIPPED`→`SKIPPED`+alasan, 409 isi sama→`DUPLICATE`, 409 nama sama→`NAME_CONFLICT`+`existingChunks`, RAG mati→`UNAVAILABLE` (**file tetap tersimpan di Hub**). Route baru `GET /v1/pdfs/rag-jobs/:jobId` (validasi `^[A-Za-z0-9_-]{1,64}$`, 404 bila tak ada, 502 bila RAG mati). |
| `.env.example` | **UBAH** | +`RAG_API_BASE` (kosong = fitur mati), `RAG_API_KEY`, `RAG_TIMEOUT_MS=180000`, `PUBLIC_API_PREFIX=/api`. |
| `tests/`, `vitest.config.ts` | **BARU** | Disalin dari paket serah terima (isi tes **tidak diubah**, blok `CFG` tidak disentuh). |
| `package.json` | **UBAH** | `"test": "vitest run"` + devDependency `vitest`. |
| `test_risky_ajudan/` | **BARU** | Paket serah terima dari pemilik backend (dokumen + tes + server tiruan). |

**Penghapusan:** tidak ada file yang dihapus pada fase ini.

### 🧠 Hal yang perlu diketahui agent lain

1. **Jalur lama tidak dilepas.** Selama `RAG_API_BASE` kosong (kondisi `.env` lokal saat ini), `chat.ts` tetap memakai `CHAT_PY_URL`/`chat.py` persis seperti sebelumnya. RAG hanya aktif saat env diisi.
2. **`RAG_API_KEY` hanya boleh ada di server Hub**, tidak boleh sampai ke respons/browsers (dicegah tes A10 & E11).
3. **Frontend (`src/`) belum disentuh sama sekali.** UI polling `rag-jobs`, tombol "ganti versi" (NAME_CONFLICT), dan "kirim ulang" (UNAVAILABLE) belum ada.
4. **Prisma tidak ditambahi query baru**, jadi mock `vi.mock("../api/lib/prisma")` di tes tidak perlu diubah.
5. **Keputusan yang masih terbuka** (dari panduan bagian 6): kolom `ragJobId` permanen di `PdfFile`, sinkron hapus Hub→chatbot, batas 25 MB (Hub) vs 100 MB (RAG), nasib file `SKIPPED`/`DUPLICATE`/`NAME_CONFLICT` (implementasi contoh: **tidak disimpan** di Hub), dan `/chat/upload`.
6. **Cara verifikasi ulang:** `npm test` (harus 40/40). Kalau gagal, jangan melemahkan tes — lihat `00_BACA_DULU_PANDUAN.md` bagian 4.

### ⏳ Langkah berikutnya

1. Isi `RAG_API_BASE` + `RAG_API_KEY` di `.env`, jalankan backend RAG asli, lalu `docker compose up -d app` (lihat `1_BACKEND_RAG/PANDUAN_PINDAH_KE_SERVER_untuk_atasan.md`).
2. Uji manual: 1 pertanyaan publikasi, 1 SOP (harus ada gambar), 1 PDF publikasi, 1 PDF acak (harus `SKIPPED`).
3. Kirim hasil `npx vitest run` + catatan uji manual ke pemilik backend, lalu uji gabungan dengan `uji_backend_rag.py`.

---

# 📜 Fase 1 (riwayat) — Integrasi AI Chat Engine: LLM Python RAG (`chat.py`)

## 📊 Ringkasan Status

| Kategori | Status | Keterangan |
| :--- | :---: | :--- |
| **Arsitektur & Proxy Backend (Hono API)** | ✅ Selesai | Mengarahkan rute `/api/chat/*` ke server Python Flask |
| **Server Adapter Python (`app.py`)** | ✅ Selesai | Pembungkus REST & SSE stream untuk `chat.py` |
| **Layer Caching Respon (`answer_cache.py`)** | ✅ Selesai | Dual-layer cache (Exact match + Semantic similarity) |
| **Frontend Hook & UI (`use-chat.tsx`, dsb.)** | ✅ Selesai | Konsumsi SSE streaming & rendering sumber data BPS |
| **Instalasi Dependensi Python** | ✅ Selesai | Pemasangan seluruh pustaka dari `requirements.txt` sukses |
| **Verifikasi Server & Build Frontend** | ✅ Selesai | `app.py` aktif (port 5000) & Vite frontend aktif (port 8081) |
| **Uji Komunikasi Proxy End-to-End** | ✅ Selesai | Rute `/api/chat/status` & `/api/chat/send` terverifikasi |
| **Git Commit & Penyimpanan** | ✅ Selesai | Tersimpan di commit `2479cf5` tanpa rewrite history |
| **Aktivasi Service Eksternal (Ollama & Qdrant)** | ⏳ Menunggu User | Jalankan Ollama & Qdrant di mesin lokal untuk inferensi penuh |

---

## ✅ Progress yang Telah Dilakukan (Completed)

1. **Pembuatan Wrapper Flask untuk `chat.py` (`back-end/app.py`)**:
   - Memetakan dan menginisialisasi pipeline LlamaIndex dari `chat.py` (`build_index()`, `build_or_load_title_index()`, dan `answer_question()`).
   - Menyediakan endpoint:
     - `GET /api/health` — Status kesiapan model & koneksi Qdrant/Ollama.
     - `GET/POST /api/init` — Trigger re-koneksi pipeline tanpa restart Flask server.
     - `POST /api/ask` — Inferensi tanya-jawab mode non-streaming dengan cache.
     - `POST /api/chat/stream` — Inferensi streaming SSE dengan token teks & metadata dokumen BPS.
   - Penanganan graceful fallback jika Ollama/Qdrant belum siap sehingga server Flask tetap hidup melayani status.

2. **Dukungan Caching Cerdas (`back-end/answer_cache.py`)**:
   - Implementasi cache dua lapis (Exact MD5 match + Semantic cosine similarity embedding).

3. **Refactor API Proxy (`api/routes/chat.ts`)**:
   - Mengganti pemanggilan API pihak ketiga eksternal dengan proxy ke server Flask lokal (`http://localhost:5000`).
   - Meneruskan streaming SSE tanpa buffering ke klien.
   - Memetakan format sumber kutipan BPS (`formatSources`) ke kartu UI frontend.

4. **Refactor Klien & Hook Frontend**:
   - `src/lib/api.ts`: Generator async `parseSSEStream()` untuk streaming data & event metadata.
   - `src/hooks/use-chat.tsx`: Integrasi streaming, loading state, dan error toast informatif.
   - `src/components/chat/chat-workspace.tsx` & `src/components/common.tsx`: Tampilan referensi sumber dokumen BPS dengan tombol buka tautan.

5. **Konfigurasi & Skrip Proyek**:
   - Variabel `CHAT_PY_URL=http://localhost:5000` di `.env` dan `.env.example`.
   - Script `npm run py:server` dan `npm run py:install` di `package.json`.
   - Konfigurasi `vite.config.ts` untuk proxy API dan statik file.
   - Pembaruan `.gitignore` untuk direktori cache Python (`__pycache__`, `venv`).

6. **Pemasangan Dependensi & Verifikasi Lingkungan**:
   - Seluruh paket Python di `requirements.txt` sukses terpasang.
   - Verifikasi import modul Python sukses.
   - Build produksi Vite (`npm run build`) sukses 100%.

7. **Uji Coba Komunikasi Antar-Layanan**:
   - Server Flask Python berjalan di latar belakang pada `http://localhost:5000`.
   - Server Vite Dev berjalan di latar belakang pada `http://localhost:8081`.
   - Panggilan dari frontend ke `/api/chat/status` berhasil diteruskan ke Flask dan mengembalikan status konektivitas terverifikasi (`backend: chat.py`, `connected: True`).
   - Panggilan `/api/chat/send` berhasil menerima payload JSON dan memberikan respon error handling informatif saat Ollama offline.

8. **Penyimpanan ke Git**:
   - Seluruh perubahan telah di-commit ke Git pada commit `2479cf5`:
     `feat(ai): integrate local Python chat.py RAG engine to replace external LLM API` (sesuai aturan Lovable, tanpa rewrite git history).

---

## ⏳ Langkah yang Perlu Dijalankan Pengguna (Next Steps / Cara Menjalankan)

Karena model AI RAG menggunakan LLM lokal dan vector store pada mesin Anda, jalankan dua service pendukung berikut:

1. **Nyalakan Ollama**:
   - Pastikan Ollama terpasang dan berjalan di `http://localhost:11434`.
   - Download model yang dikonfigurasi:
     ```bash
     ollama run qwen2.5:3b-instruct
     ollama pull nomic-embed-text
     ```
2. **Nyalakan Qdrant**:
   - Jalankan Qdrant di port `6333` (misal via Docker):
     ```bash
     docker run -p 6333:6333 -p 6334:6334 -v qdrant_storage:/qdrant/storage qdrant/qdrant
     ```
3. **Inisialisasi Ulang Pipeline**:
   - Setelah Ollama & Qdrant aktif, Anda dapat memicu re-koneksi tanpa restart server dengan memanggil:
     ```bash
     curl -X POST http://localhost:5000/api/init
     ```
   - Buka browser di **`http://localhost:8081/chat`** untuk langsung berinteraksi dengan AI BPS Insight Hub.


