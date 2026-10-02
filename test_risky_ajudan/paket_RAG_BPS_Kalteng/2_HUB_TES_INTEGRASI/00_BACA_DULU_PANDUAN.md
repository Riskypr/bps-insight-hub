# Panduan Tes Integrasi Hub ke Chatbot RAG

Untuk: pembuat Hub (`bps-insight-hub`).
Tujuan: kode Hub disesuaikan sampai **semua tes di sini lulus**. Dengan begitu,
saat digabung dengan backend RAG, tidak banyak yang perlu diubah lagi.

Tes ini **tidak butuh** Ollama, Qdrant, Postgres, atau backend RAG asli.
Layanan RAG diganti server tiruan yang meniru kontrak `KONTRAK_API_RAG.md`.

## Mulai cepat (5 langkah)

1. Salin folder `tests/` dan berkas `vitest.config.ts` ke **akar repo Hub**.
2. Jalankan `npm i -D vitest`, lalu tambahkan di `package.json` bagian scripts: `"test": "vitest run"`.
3. Jalankan `npx vitest run`. Awalnya **semua tes gagal. Itu normal**, karena Hub belum tersambung ke chatbot.
4. Ubah kode Hub sampai semua tes lulus. Aturan yang diminta ada di bagian 4 di bawah. Kalau bingung mulai dari mana, lihat `CONTOH_kode_integrasi_hub_OPSIONAL.patch`.
5. Kabari pemilik backend. Setelah itu kalian uji bersama dengan backend asli (bagian 8).

## Isi folder ini

| Berkas | Apa itu | Perlu Anda ubah? |
|---|---|---|
| `00_BACA_DULU_PANDUAN.md` | Panduan ini | Tidak |
| `KONTRAK_API_RAG.md` | Aturan API backend: apa yang dikirim dan diterima | Tidak. Ini acuan |
| `tests/tes_integrasi_hub_rag.test.ts` | **40 tes yang harus lulus** | Jangan dilemahkan. Hanya blok `CFG` di awal berkas yang boleh disesuaikan, setelah berunding dengan pemilik backend |
| `tests/helpers/server_tiruan_rag_dan_ai.ts` | Server chatbot dan AI palsu, supaya tes jalan tanpa backend asli | Tidak perlu disentuh |
| `vitest.config.ts` | Setelan alat tes | Tidak |
| `CONTOH_kode_integrasi_hub_OPSIONAL.patch` | Contoh kode yang membuat 40 tes lulus | Opsional |

## 1. Pasang

Salin ke akar repo Hub: folder `tests/` dan `vitest.config.ts`.

```bash
npm i -D vitest        # atau: bun add -d vitest
```

Tambahkan di `package.json` bagian `scripts`:

```json
"test": "vitest run"
```

Jalankan:

```bash
npx vitest run
```

`vitest.config.ts` sengaja terpisah dari `vite.config.ts` (yang memuat plugin
TanStack), jadi tes berjalan mandiri. Diuji dengan Node 22 + npm. Bila `bun`
bermasalah menjalankan vitest, pakai `npx`.

## 2. Kondisi awal

Di repo Hub sekarang (commit `1c2f7fe`) **belum ada integrasi RAG**: chat masih
langsung ke `AI_API_BASE`, dan upload hanya menyimpan lokal. Jadi wajar bila
**40 dari 40 tes gagal** saat pertama dijalankan. Itu daftar pekerjaan Anda.

Bila bingung mulai dari mana, ada `CONTOH_kode_integrasi_hub_OPSIONAL.patch` (opsional):

```bash
git apply CONTOH_kode_integrasi_hub_OPSIONAL.patch
```

Patch ini membuat ke-40 tes lulus dan menambah 2 berkas baru (`api/lib/rag.ts`,
`api/routes/rag.ts`) serta mengubah `index.ts`, `chat.ts`, `pdfs.ts`.
Pakai sebagai contoh atau tulis sendiri; yang dinilai adalah **perilaku**, bukan
kodenya. Frontend belum disentuh sama sekali.

## 3. Variabel env baru (tambahkan ke `.env.example`)

| Variabel | Isi | Catatan |
|---|---|---|
| `RAG_API_BASE` | mis. `http://localhost:5000` | Kosong = fitur RAG mati, Hub berperilaku seperti sekarang |
| `RAG_API_KEY` | key Bearer | **Sama persis** dengan `RAG_API_KEY` di backend. Hanya dipakai di server Hub, tidak boleh sampai ke browser |
| `RAG_TIMEOUT_MS` | disarankan `180000` | Satu jawaban baru bisa puluhan detik; jangan pakai timeout beberapa detik |

## 4. Yang diuji (ringkas)

**A. Chat `/chat/send`**
- Pertanyaan diteruskan ke RAG `POST /api/ask` dengan header `Authorization: Bearer <key>`.
- Bila ada riwayat (`messages`), yang dikirim hanya teks pesan user **terakhir** (RAG belum punya riwayat).
- Pesan kosong ditolak 400. Respons tetap punya `id`, `conversationId`, `createdAt`, plus `via: "rag"`.
- `warning` dan judul sumber ikut tampil.
- SOP: `featured_image` menjadi blok ` ```image ` yang alamatnya lewat **proxy Hub**, bukan alamat Flask.
- Daftar publikasi: tidak boleh ada baris berawalan `- ` (frontend `extractSuggestions` memotongnya). Ganti jadi `* `.
- API key tidak bocor ke respons.

**B. Error dari RAG**
- `503 server_sibuk`: Hub membalas `503 {error:"rag_sibuk", retry_after}` + header `Retry-After`. **Jangan kirim ulang otomatis dan jangan fallback.** Tampilkan "sedang antre, coba lagi N detik".
- RAG mati / belum siap / error 500 / melewati `RAG_TIMEOUT_MS`: fallback ke model umum, `via: "fallback"`.
- RAG menjawab 401 (key salah): jangan fallback diam-diam; balas galat 5xx.

**C. Streaming `/chat/stream`**: format SSE yang sama dengan sekarang (event `conversationId`, potongan `delta.content`, lalu `[DONE]`). Jawaban RAG datang utuh, jadi Hub yang memotongnya. `server_sibuk` dibalas 503 JSON biasa, bukan SSE.

**D. Proxy gambar SOP** `GET /rag/sop-image/<nama>.png`
- Meneruskan gambar dari RAG (`/static/sop_images/<nama>`).
- Menolak nama berbahaya (`../`, `%2F`, `\`, byte null) dan ekstensi selain png/jpg/jpeg/webp. Hal-hal itu tidak boleh diteruskan ke RAG.
- **Nama file SOP asli memuat spasi**, mis. `62551.11 SOP ..._p3.png`; di URL jadi `%20` (backend memakai `quote(name)`). Jangan memakai validasi `[A-Za-z0-9._-]` saja, karena gambar SOP asli akan ditolak. Yang ditolak: pemisah path, karakter kontrol, awalan titik, ekstensi non-gambar.

**E. Upload PDF (drag & drop) `POST /v1/pdfs/upload`**
- Tiap file diteruskan ke `POST /api/ingest` dengan **nama file asli** (bukan `<uuid>.pdf`), `title`, dan `uploader` (dari `x-user-id`).
- Field form `replace=true` diteruskan untuk mengganti versi.
- Hasil per file memuat `ragJobId` dan `ragStatus`:

| Jawaban RAG | `status` di Hub | `ragStatus` | Keterangan |
|---|---|---|---|
| 202 | `SUCCESS` | `PENDING` | `ragJobId` = `job_id` |
| 200 `SKIPPED` | `SKIPPED` | `SKIPPED` | Bukan publikasi/SOP BPS; `reason` dari `catatan`; **bukan galat** |
| 409 isi identik | `SKIPPED` | `DUPLICATE` | `ragJobId` = `existing_job_id` |
| 409 nama sama isi beda | bukan `SUCCESS` | `NAME_CONFLICT` | `existingChunks`; UI tawarkan "ganti versi" |
| RAG mati | `SUCCESS` | `UNAVAILABLE` | File tetap tersimpan di Hub |

**F. Status ingest** `GET /v1/pdfs/rag-jobs/<job_id>`: meneruskan `status`, `progress`, `chunks`, `error` dari RAG. Frontend polling tiap 3-5 detik sampai `INDEXED`, `FAILED`, atau `SKIPPED`. Job tidak ada: 404. RAG mati: 502.

## 5. Nama yang boleh Anda ubah

Semua nama env dan route ada di satu blok `CFG` di awal `tests/tes_integrasi_hub_rag.test.ts`.
Bila mengubah, **kabari pemilik backend** supaya dokumen serah terima tetap sama.
Selain itu, jangan melemahkan tes agar lulus; kalau tes terasa salah, tanyakan dulu.

## 6. Keputusan yang saya tetapkan (silakan dibahas, belum final)

1. Nama route `/rag/sop-image/...` dan `/v1/pdfs/rag-jobs/...`, serta nilai `via`, `ragStatus`.
2. Saat RAG mati, upload **tetap tersimpan** di Hub (`UNAVAILABLE`). Konsekuensinya, dokumen itu belum masuk chatbot; perlu tombol "kirim ulang" di UI.
3. PDF yang `SKIPPED`/`DUPLICATE`/`NAME_CONFLICT` oleh RAG **tidak disimpan** di Hub pada implementasi contoh. Tes tidak mengatur ini; putuskan bersama.
4. Patch contoh memakai awalan `/api` pada URL gambar (`PUBLIC_API_PREFIX`, default `/api`). Sesuaikan dengan cara Hub disajikan.

## 7. Yang TIDAK diuji

- Tampilan dan drag-and-drop di browser (frontend).
- Postgres/Prisma asli (dipalsukan), login website induk, hak akses admin.
- Backend RAG asli. Server tiruan mengikuti dokumen kontrak, bukan kode `app.py`. Bila ada beda, itu ketahuan saat uji gabungan dengan `uji_backend_rag.py` dan Hub berjalan.
- Belum diputuskan: kolom `ragJobId` permanen di `PdfFile`, sinkron hapus Hub ke chatbot, batas 25 MB (Hub) vs 100 MB (RAG), `/chat/upload`.

Bila Hub menambah pemanggilan Prisma baru (mis. `update` untuk `ragJobId`), tambahkan
di blok `vi.mock("../api/lib/prisma")` pada file tes.

## 8. Langkah setelah semua lulus

1. Jalankan Hub bersama backend RAG asli (`RAG_API_BASE`, `RAG_API_KEY` diisi).
2. Coba manual: satu pertanyaan publikasi, satu SOP (harus ada gambar), satu PDF publikasi, satu PDF acak (harus `SKIPPED`).
3. Kirim hasil `npx vitest run` dan catatan uji manual ke pemilik backend.
