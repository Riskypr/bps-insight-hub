# Paket RAG Chatbot BPS Kalteng

Dua folder, untuk dua orang:

## 1_BACKEND_RAG  (untuk pemilik backend)
| Berkas | Fungsi |
|---|---|
| `docker-compose.yml` | Pengganti compose lama; meneruskan semua setelan dari `.env` ke container |
| `.env.example` | Salin jadi `.env`, isi `RAG_API_KEY`. Daftar setelan yang bisa diubah atasan |
| `uji_backend_rag.py` | Uji backend yang sedang berjalan (`pip install requests`) |
| `PANDUAN_PINDAH_KE_SERVER_untuk_atasan.md` | Panduan saat pindah ke server internal |
| `CONTOH_hasil_uji_lulus_server_tiruan.md` | Contoh bentuk hasil uji (dari server TIRUAN, bukan asli) |

Urutan: timpa `docker-compose.yml` -> buat `.env` -> `docker compose up -d app` (bukan `restart`)
-> `python uji_backend_rag.py --key KEY --concurrent 4 --with-ingest --with-sop --sop-question "..."`.

## 2_HUB_TES_INTEGRASI  (kirim ke teman pembuat Hub)
Mulai dari `00_BACA_DULU_PANDUAN.md`.

## Status
Belum ada yang dijalankan dengan Ollama/Qdrant asli. Yang belum dilihat: `ingest_service.py`,
`ingest/upload_runner.py`, `answer_cache.py`.
