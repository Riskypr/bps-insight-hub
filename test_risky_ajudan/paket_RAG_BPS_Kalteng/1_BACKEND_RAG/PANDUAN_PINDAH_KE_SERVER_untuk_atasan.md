# Panduan Migrasi RAG Chatbot BPS Kalteng ke Server Internal

> **Status:** nama variabel sudah dicocokkan dengan `app.py`, `chat.py`, `publikasi.py`,
> `sop.py`, `common.py`. **Belum dilihat:** `ingest_service.py`, `upload_runner.py`,
> `answer_cache.py`. Seluruhnya **belum diuji** dengan Ollama/Qdrant asli.
> Bagian bertanda **[CEK]** perlu diverifikasi sebelum dipakai.

## 1. Gambaran singkat
Chatbot RAG on-premise (tanpa API eksternal): Flask (`app.py`), llama_index,
Qdrant, Ollama, Docker. Satu koleksi Qdrant `bps_kalteng_publikasi`
(~136 ribu chunk: publikasi dan SOP). Semua yang bergantung pada hardware
diatur lewat satu berkas `.env` (lihat `.env.example`), tanpa mengubah kode.

## 2. Aturan yang tidak boleh dilanggar
1. **Satu proses saja.** Jangan gunicorn multi-worker. Antrean `/api/ask`,
   antrean ingest, dan cache ada di memori.
2. **`EMBED_MODEL` harus sama** untuk chat dan ingest. Ganti embedding =
   embed ulang seluruh korpus.
3. **`ASK_MAX_CONCURRENT` tetap 1** sampai `_LAST_RETRIEVAL_TIMING` dibuat
   per-request. Bila nanti dinaikkan, naikkan bersama `OLLAMA_NUM_PARALLEL`,
   bertahap.
4. Ambang di `chat.py` hanya valid untuk skor re-ranker berskala logit.
   Setelah start, cek log: tidak boleh ada `Aktivasi re-ranker diganti ke Identity`.
5. `replace=true` pada ingest menghapus chunk lama lebih dulu. Simpan PDF asli.

## 3. Keputusan sebelum migrasi
| Keputusan | Catatan |
|---|---|
| Model embedding final | Migrasi adalah saat termurah untuk mengganti. Jika tidak diganti, tetap `nomic-embed-text` dan cukup pindahkan snapshot Qdrant. |
| Qdrant & Ollama | Tetap berdiri sendiri di luar compose app (seperti di laptop) atau digabung satu compose. Tulis keputusannya di sini. |
| Model LLM | Sesuaikan dengan VRAM server. Aman diganti kapan saja. |
| Ollama vs vLLM | Bila pengguna serentak banyak, vLLM kandidat; cukup ganti `OLLAMA_BASE_URL`. |
| Persetujuan unggahan | `INGEST_REQUIRE_APPROVAL=1` bila dokumen perlu disetujui admin dulu. |

## 4. Yang dipindahkan
- [ ] Snapshot Qdrant (koleksi `bps_kalteng_publikasi`)
- [ ] `static/sop_images` (di folder aplikasi; nama file `<nama pdf>_p<n>.png`, memuat spasi)
- [ ] PDF asli
- [ ] `INGEST_DATA_DIR` (bawaan: folder `ingest_data` di samping `app.py`; berisi SQLite status ingest)
- [ ] `titles_cache.json` TIDAK perlu dipindah: dibangun ulang dari Qdrant saat start / setelah ingest
- [ ] `.env` (isi `RAG_API_KEY` baru di server)

## 5. Langkah migrasi
1. Siapkan server: Docker, driver GPU + NVIDIA Container Toolkit (bila GPU).
2. Jalankan Qdrant dan Ollama; `ollama pull` model `LLM_MODEL` dan `EMBED_MODEL`.
3. Setel Ollama: `OLLAMA_NUM_PARALLEL`, `OLLAMA_CONTEXT_LENGTH` sesuai VRAM. Pull juga `INGEST_LLM_MODEL` (bawaan `hermes3`) selain `LLM_MODEL` dan `EMBED_MODEL`.
4. Restore snapshot Qdrant (koleksi `bps_kalteng_publikasi`); cek jumlah chunk mendekati ~136 ribu **[CEK]**.
5. Salin `static/sop_images`, PDF asli, `INGEST_DATA_DIR`.
6. Buat `.env` dari `.env.example`, isi `RAG_API_KEY`, `QDRANT_HOST`, `OLLAMA_BASE_URL`, model. Bila server punya GPU lega, pertimbangkan `RERANK_DEVICE=cuda` (bawaan `cpu`).
7. `docker compose up -d app` (bukan `restart`, agar `.env` terbaca). `docker-compose.yml` sudah meneruskan semua variabel `.env.example`. Bila Hub di mesin yang sama, set `RAG_PORT_BIND=127.0.0.1:5000:5000`.
8. Cek `docker compose logs app` dan `/api/health`.

## 6. Uji setelah migrasi
- Satu pertanyaan publikasi dan satu pertanyaan SOP (harus teks + gambar halaman).
- Satu PDF kecil ke `/api/ingest`; satu PDF acak (harus `SKIPPED`).
- 3-4 pertanyaan serentak; pantau `/api/health` (field `queue`) dan log.
- Pastikan tanpa `Authorization: Bearer <RAG_API_KEY>` endpoint menolak (401/503).

## 7. Menaikkan kapasitas
Untuk ~130 pegawai, naikkan bertahap dan pantau di tiap langkah:
`OLLAMA_NUM_PARALLEL` dan `ASK_MAX_CONCURRENT` bersama, lalu
`ASK_MAX_WAITING` / `ASK_WAIT_TIMEOUT` bila antrean sering penuh
(503 `server_sibuk`). Ingest dan tanya-jawab berbagi Ollama, jadi pantau
saat ada unggahan besar.

## 8. Backup rutin
Snapshot Qdrant, `static/sop_images`, PDF asli, `INGEST_DATA_DIR`, `.env`.

## 9. Masalah yang diketahui
- Cache semantik (ambang 0,95) kurang peka pada pertanyaan yang hanya beda
  kata kunci tanpa angka (mis. TPT vs TPAK).
- `kategori` unggahan belum masuk metadata Qdrant; dokumen ingest massal awal
  tidak muncul di `GET /api/documents`.
- Hapus di Hub belum sinkron ke chatbot.
- Pertanyaan identik yang bersamaan tidak berbagi hasil.

## 10. Belum diketahui
Spesifikasi server (VRAM, RAM, disk), mekanisme login website induk dan
peran admin, ada tidaknya dokumen yang dibatasi per unit.
