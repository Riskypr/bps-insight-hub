# Kontrak API Layanan RAG BPS Kalteng (tanya-jawab + ingest)

Untuk tim Hub. Semua endpoint ada di layanan Flask (port 5000) dan **hanya boleh dipanggil dari server Hub** (bukan dari browser), karena memakai API key. Bagian A = tanya-jawab, Bagian B = ingest dokumen.

Ditulis dari kode `app.py` dan `chat.py` yang aktif. Belum pernah dijalankan end-to-end dengan Hub.

## Autentikasi (berlaku untuk semua)

```
Authorization: Bearer <RAG_API_KEY>
```

- Key salah/tanpa header → `401 {"error": "Tidak diizinkan."}`
- Bila `RAG_API_KEY` **kosong** di layanan RAG: `/api/ask` terbuka tanpa autentikasi, tetapi endpoint ingest/dokumen dimatikan (`503`). Di produksi, isi key.
- `/api/health`, `/`, dan `/static/*` tidak memakai key.
- Layanan RAG **tidak** tahu siapa pegawai/admin. **Hub yang wajib memeriksa hak akses** sebelum memanggil endpoint ini.

---

# Bagian A. Tanya-jawab

## `POST /api/ask`

`Content-Type: application/json`

| Field | Wajib | Keterangan |
|---|---|---|
| `question` | ya | Teks pertanyaan. Kosong → `400`. |
| `no_cache` | tidak | `true` = lewati cache (baca dan tulis). Untuk uji saja. |

Setiap pertanyaan berdiri sendiri: **belum ada riwayat percakapan**. Kalau pengguna bertanya lanjutan ("yang tahun lalu?"), Hub harus mengirim pertanyaan yang sudah lengkap.

**200 OK**
```json
{
  "mode": "qa",
  "answer": "…teks jawaban…",
  "warning": null,
  "note": null,
  "combined": false,
  "combined_titles": [],
  "breadth_hint": null,
  "sources": [
    {
      "title": "Judul Publikasi",
      "link": "https://…",
      "raw_score": 3.2,
      "percent": 87,
      "pages": ["12", "13"],
      "cited_pages": ["12"],
      "images": [
        { "page": "5", "url": "/static/sop_images/xxx.png", "text_reliable": false }
      ]
    }
  ],
  "debug_chunks": [ { "rank": 1, "score": 3.2, "page": "12", "title": "…", "snippet": "…" } ],
  "doc_meta": null,
  "image_only": false,
  "featured_image": null,
  "cached": false,
  "cache_match": null
}
```

Nilai `raw_score`/`percent`/`link` bisa `null`. Contoh di atas hanya bentuknya, bukan data asli.

### Field penting

| Field | Arti |
|---|---|
| `mode` | `qa` (tanya-jawab biasa), `list_publications` (daftar publikasi), `summary` (ringkasan dokumen penuh), `summary_not_found` (dokumen yang diminta diringkas tidak ditemukan), `needs_clarification` (perlu tahun/edisi; lihat `answer`) |
| `answer` | Teks utama. Untuk `list_publications` dan `needs_clarification` berisi daftar judul (`- judul — link`). |
| `warning` | Pesan peringatan (skor relevansi rendah, dsb.). Bila ada, tampilkan dan jangan disajikan sebagai jawaban pasti. |
| `note` | Catatan non-kritis (mis. dua sumber berskor berdekatan). |
| `combined`, `combined_titles` | `true` bila jawaban memadukan beberapa publikasi; angka antar-sumber bisa berbeda dan sudah diberi label sumber. |
| `sources[].cited_pages` | Halaman yang benar-benar disebut di teks jawaban; boleh disorot. |
| `sources[].images` | Gambar halaman (SOP). `text_reliable: false` = teks halaman itu tidak andal, gambar adalah rujukan utama. |
| **`image_only`** | `true` = sumber utama hanya andal sebagai gambar. `answer` sudah berisi pesan yang menjelaskan hal itu (bukan sintesis LLM), dan `featured_image` **harus ditampilkan besar** di bubble jawaban. |
| **`featured_image`** | `{url, page, title}` atau `null`. Gambar halaman yang harus ditampilkan besar. |
| `cached`, `cache_match` | `true` bila dari cache; `cache_match` = `"exact"` atau `"semantic"`. |
| `debug_chunks` | Untuk debugging. Sebaiknya **jangan ditampilkan** ke pegawai biasa. |
| `doc_meta` | Metadata dokumen; hanya terisi pada mode `summary`. |

Kebijakan tampilan SOP: teks + gambar halaman selalu ditampilkan; bila `image_only` = `true`, yang tampil adalah gambar saja dengan pesan di `answer`.

### Gambar

`url` berupa path relatif (`/static/sop_images/<nama>.png`) yang dilayani Flask tanpa key. Browser pegawai tidak boleh menembak Flask langsung, jadi Hub sebaiknya **meneruskan (proxy)** gambar lewat servernya sendiri dan mengganti URL di respons.

### Error

| Kode | Body | Arti |
|---|---|---|
| 400 | `{"error": "Pertanyaan tidak boleh kosong."}` | |
| 401 | `{"error": "Tidak diizinkan."}` | |
| 500 | `{"error": "…"}` | Kesalahan internal pipeline |
| 503 | `{"error": "Server belum siap, tunggu beberapa saat lalu coba lagi."}` | Pipeline masih memuat saat server start (bisa beberapa menit) |
| **503** | `{"error": "server_sibuk", "reason": "antrean_penuh" \| "timeout_antre", "retry_after": 30, "message": "…"}` + header `Retry-After` | Terlalu banyak pertanyaan sekaligus |

**Dua respons 503 berbeda.** Bedakan dari `error`: nilai `"server_sibuk"` berarti antrean; yang lain berarti server belum siap. Untuk `server_sibuk`, tampilkan "sedang antre, coba lagi sekitar N detik" (N = `retry_after`), jangan sebagai galat umum.

### Perilaku antrean

- Layanan hanya menjalankan `ASK_MAX_CONCURRENT` pertanyaan sekaligus (default 1). Sisanya antre urut kedatangan (maks `ASK_MAX_WAITING`, default 10, menunggu maks `ASK_WAIT_TIMEOUT` = 90 detik).
- Jawaban dari cache tidak ikut antre dan cepat.
- Satu jawaban baru bisa memakan puluhan detik. **Atur timeout HTTP Hub ke layanan RAG sedikit lebih besar dari waktu tunggu + waktu jawab** (saran awal: 180 detik), jangan default beberapa detik.
- Bila Hub memutus koneksi saat menunggu, permintaan tetap ikut giliran (server tidak bisa mendeteksinya). Jangan kirim ulang otomatis; itu menambah beban.
- `retry_after` adalah perkiraan kasar dari rata-rata durasi jawaban, bukan jaminan. Saat ada ingest, jawaban bisa lebih lambat.

## `GET /api/health`

Tanpa key.
```json
{ "ready": true, "queue": { "active": 1, "waiting": 3, "max_concurrent": 1, "max_waiting": 10 } }
```
`ready: false` selama pipeline masih memuat. `queue` bisa dipakai untuk menampilkan indikator "N pertanyaan sedang antre".

## Yang belum ada

Streaming jawaban, riwayat percakapan/penulisan ulang pertanyaan, dan pembatasan akses dokumen per unit. Semuanya masuk rencana tahap berikutnya; jangan dibangun dengan asumsi sudah tersedia.

---

# Bagian B. Ingest dokumen

Autentikasi dan pembagian hak akses: lihat bagian awal dokumen ini.

## Alur singkat

1. Hub kirim PDF ke `POST /api/ingest` → dapat `job_id` (status `PENDING`).
2. Hub polling `GET /api/ingest/<job_id>` tiap 3–5 detik sampai `INDEXED` atau `FAILED`.
3. Setelah `INDEXED`, isi dokumen otomatis bisa dijawab chatbot. Cache jawaban dikosongkan otomatis.

Status: `MENUNGGU_PERSETUJUAN` → `PENDING` → `PROCESSING` → `INDEXED` | `FAILED`; atau langsung `SKIPPED` bila PDF bukan dokumen terdaftar; dokumen `INDEXED` bisa jadi `DELETED` (ditarik) atau `SUPERSEDED` (digantikan versi baru).

---

## `POST /api/ingest`

`multipart/form-data`

| Field | Wajib | Keterangan |
|---|---|---|
| `file` | ya | PDF. **Kirim dengan nama file asli** (bukan `<uuid>.pdf`); nama ini menjadi kunci dokumen di Qdrant. Maks `MAX_UPLOAD_MB` (default 100). |
| `title` | tidak | Judul tampilan. Kosong → nama file tanpa `.pdf`. Untuk SOP, judul ini menimpa judul hasil baca otomatis. |
| `jenis` | tidak | `auto` (default), `publikasi`, atau `sop`. |
| `force` | tidak | `true` untuk memaksa ingest PDF yang tadinya di-skip. **Wajib disertai `jenis` eksplisit** (`publikasi`/`sop`), kalau tidak `400`. |
| `replace` | tidak | `true` jika ini versi baru dari dokumen yang sudah ada (nama file sama). Chunk lama **dihapus dulu**, lalu diganti. |
| `kategori` | tidak | Disimpan di catatan job saja (belum masuk metadata pencarian). |
| `uploader` | tidak | Nama/ID pengunggah untuk pencatatan. |

**202 Accepted**
```json
{
  "job_id": "9f1c…",
  "filename": "Laporan Ketenagakerjaan 2025.pdf",
  "title": "Laporan Ketenagakerjaan Kalteng 2025",
  "kategori": "",
  "jenis": "publikasi",
  "jenis_basis": "tidak_ada_header_sop",
  "status": "PENDING",
  "chunks": 0,
  "error": "",
  "catatan": "",
  "uploader": "budi",
  "created_at": 1790000000.0,
  "updated_at": 1790000000.0,
  "progress": ""
}
```

`jenis_basis` menjelaskan dasar penentuan jenis. Nilai `gagal_baca_pdf(...)` atau `tanpa_teks(kemungkinan_scan)` berarti jenis **tidak** terdeteksi dan jatuh ke `publikasi` — sebaiknya tampilkan pilihan jenis ke pengunggah dan kirim ulang dengan `jenis` eksplisit bila salah.

**PDF acak / bukan dokumen terdaftar → `200` (bukan 202), status `SKIPPED`**

Layanan hanya menerima dua jenis dokumen. PDF dianggap terdaftar bila 3 halaman pertamanya memuat:
- **SOP**: tulisan "Nomor SOP" (header tabel SOP BPS), atau
- **Publikasi**: "Badan Pusat Statistik" **dan** minimal satu penanda pendukung (ISSN, katalog, nomor publikasi, Kalimantan Tengah, dsb.).

Selain itu (resep, berita, surat, PDF rusak, PDF scan tanpa teks, atau `jenis` eksplisit yang isinya tidak cocok) di-skip: **tidak diproses, file langsung dibuang**, hanya tercatat di daftar job.
```json
{ "job_id": "…", "status": "SKIPPED", "jenis": "", "error": "",
  "catatan": "Dilewati: PDF ini tidak dikenali sebagai publikasi atau SOP BPS Kalteng (bukan_dokumen_bps_terdaftar). …" }
```
Untuk unggah banyak file sekaligus, tampilkan per file: `SKIPPED` = dilewati (bukan galat). Skip tidak dianggap duplikat, jadi file yang sama bisa dikirim ulang (mis. dengan `force=true`). Penanda di atas disusun dari pola umum dokumen BPS dan belum diuji pada seluruh koleksi, jadi sediakan tombol "paksa unggah" untuk admin.

**Error**

| Kode | Penyebab |
|---|---|
| 400 | Bukan `.pdf`, isi bukan PDF, `force=true` tanpa `jenis` eksplisit, `jenis` tidak valid, field `file` tidak ada |
| 409 | Isi file identik dengan dokumen yang sudah ada → `{"error": "...", "existing_job_id": "...", "existing_filename": "...", "existing_status": "..."}` |
| 409 | Nama file sudah ada di korpus tetapi isi berbeda dan `replace` tidak diset → `{"error": "...", "existing_chunks": 130}` |
| 413 | Melebihi `MAX_UPLOAD_MB` |
| 401 / 503 | Lihat bagian autentikasi |

## `GET /api/ingest/<job_id>`

Mengembalikan objek yang sama seperti di atas. Field yang relevan saat polling:

- `status`
- `progress` — hanya terisi saat `PROCESSING`, mis. `"tahap 4 dari 5"` (tahap 4 = ekstraksi + embedding, paling lama)
- `chunks` — jumlah chunk yang benar-benar masuk Qdrant (dihitung ulang dari Qdrant, bukan dari log)
- `error` — alasan gagal, siap ditampilkan (mis. PDF scan perlu OCR)
- `catatan` — peringatan non-fatal. Untuk SOP: metadata nomor/judul tidak terbaca otomatis; dokumen **tetap aktif** tapi sebaiknya diperiksa admin.

`404` jika `job_id` tidak ada.

## `POST /api/ingest/<job_id>/approve`

Hanya bila layanan dijalankan dengan `INGEST_REQUIRE_APPROVAL=1`; dokumen unggahan awalnya berstatus `MENUNGGU_PERSETUJUAN` dan **tidak diproses** sampai endpoint ini dipanggil. `202` + objek job. `409` jika status bukan `MENUNGGU_PERSETUJUAN`.

## `GET /api/documents`

Query: `status` (default `INDEXED`; `all` untuk semua), `jenis` (`publikasi`/`sop`), `limit` (default 200, maks 1000).

```json
{ "count": 2, "documents": [ { …objek job… }, { … } ] }
```

Hanya mencantumkan dokumen yang masuk lewat API ini. Dokumen hasil ingest massal awal (≈981 publikasi + 376 SOP) **tidak** ada di daftar ini.

## `DELETE /api/documents/<job_id>`

Menarik dokumen: chunk-nya dihapus dari Qdrant, chatbot berhenti menjawab dari dokumen itu.

```json
{ "job_id": "…", "status": "DELETED", "chunks_removed": 130, … }
```

`409` jika sedang `PROCESSING` atau sudah `DELETED`/`SUPERSEDED`; `404` jika tidak ada. Gambar halaman SOP di `static/sop_images/` **tidak** ikut terhapus. File PDF asli tetap disimpan di server.

---

## Hal yang perlu diketahui Hub

- **Proses lama**: dokumen tebal bisa butuh beberapa menit. Jangan tahan koneksi HTTP; pakai polling.
- **Job hilang saat restart**: job `PROCESSING` saat server restart ditandai `FAILED` (sebagian chunk mungkin sudah masuk). Solusinya unggah ulang dengan `replace=true`.
- **Chatbot bisa melambat saat ada ingest**: embedding dan tanya-jawab memakai Ollama yang sama.
- **Upload identik ditolak** (SHA-256), jadi aman jika pegawai menekan tombol dua kali.