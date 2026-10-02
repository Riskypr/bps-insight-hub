# Laporan uji kontrak API RAG BPS Kalteng

> CONTOH dari server TIRUAN buatan saya (bukan layanan RAG asli). Hanya untuk memperlihatkan bentuk hasil uji saat semua lulus.

Waktu: 2026-10-01 06:51:09


## 1. Health

- **[LULUS]** health: layanan siap (ready=true)
- **[LULUS]** health: objek queue lengkap
- **[LULUS]** halaman / dan /static tanpa key tidak 401

## 2. Autentikasi

- **[LULUS]** tanpa header -> 401 di /api/documents
- **[LULUS]** key salah -> 401 di /api/documents
- **[LULUS]** tanpa header -> 401 di /api/ask
- **[LULUS]** key salah -> 401 di /api/ask
- **[LULUS]** body 401 sesuai kontrak

## 3. /api/ask - validasi

- **[LULUS]** pertanyaan kosong -> 400
- **[LULUS]** pesan error 400 sesuai kontrak
- **[LULUS]** tanpa field question -> 400

## 4. /api/ask - tanya-jawab sungguhan

- **[LULUS]** pertanyaan publikasi -> 200
- **[LULUS]** publikasi: field wajib (mode, answer, sources)
- **[LULUS]** publikasi: nilai mode valid
- **[LULUS]** publikasi: sources berupa list
- **[LULUS]** publikasi: jawaban tidak kosong
- **[LULUS]** publikasi: no_cache=true -> cached=false
- **[LULUS]** pertanyaan sama dua kali -> 200
- **[LULUS]** ulangan dari cache (cached=true, exact)
- **[LULUS]** pertanyaan SOP -> 200
- **[LULUS]** SOP: field wajib (mode, answer, sources)
- **[LULUS]** SOP: nilai mode valid
- **[LULUS]** SOP: sources berupa list
- **[LULUS]** SOP: featured_image.url path relatif /static/
- **[LULUS]** SOP: ada gambar halaman

## 5. /api/ingest - validasi input

- **[LULUS]** tanpa field file -> 400
- **[LULUS]** ekstensi bukan .pdf -> 400
- **[LULUS]** isi bukan PDF -> 400
- **[LULUS]** jenis tidak valid -> 400
- **[LULUS]** force=true tanpa jenis eksplisit -> 400
- **[LULUS]** GET job tidak ada -> 404
- **[LULUS]** DELETE job tidak ada -> 404
- **[LULUS]** GET /api/documents -> 200
- **[LULUS]** documents: {count, documents[]}

## 6. PDF acak -> SKIPPED

- **[LULUS]** PDF acak -> HTTP 200 (bukan 202)
- **[LULUS]** status = SKIPPED
- **[LULUS]** catatan alasan skip terisi
- **[LULUS]** kirim ulang file yang di-skip tidak 409 (bukan duplikat)

## 7. Antrean: 3 pertanyaan serentak

- **[LULUS]** health menunjukkan antrean terisi (waiting>0 atau active>0)
- **[LULUS]** semua respons 200 atau 503-server_sibuk
- **[LULUS]** minimal satu pertanyaan terjawab (200)

## 8. Ingest publikasi (PDF uji)

- **[LULUS]** POST /api/ingest -> 202
- **[LULUS]** respons 202 memuat field kontrak
- **[LULUS]** filename = nama asli
- **[LULUS]** jenis = publikasi
- **[LULUS]** status awal PENDING
- **[LULUS]** job selesai INDEXED
- **[LULUS]** chunks > 0
- **[LULUS]** error kosong
- **[LULUS]** dokumen muncul di GET /api/documents
- **[LULUS]** filter jenis=publikasi berfungsi
- **[LULUS]** upload identik -> 409
- **[LULUS]** 409 identik memuat existing_job_id yang benar
- **[LULUS]** nama sama isi beda tanpa replace -> 409
- **[LULUS]** 409 nama sama memuat existing_chunks
- **[LULUS]** approve pada job non-menunggu -> 409
- **[LULUS]** chatbot menjawab dari dokumen yang baru diunggah
- **[LULUS]** replace=true -> 202
- **[LULUS]** job pengganti INDEXED
- **[LULUS]** job lama menjadi SUPERSEDED
- **[LULUS]** DELETE dokumen -> 200
- **[LULUS]** status DELETED & chunks_removed > 0
- **[LULUS]** DELETE kedua kali -> 409

## 9. Ingest SOP (PDF uji)

- **[LULUS]** POST SOP -> 202
- **[LULUS]** jenis terdeteksi sop dari header 'Nomor SOP'
- **[LULUS]** job SOP INDEXED
- **[LULUS]** chunks SOP > 0
- **[LULUS]** DELETE SOP uji -> 200

## Ringkasan

```

================================================================
RINGKASAN: 68 lulus | 0 gagal | 0 perlu dicek manual | 0 dilewati

HASIL: SEMUA LULUS. Layanan RAG berperilaku sesuai KONTRAK_API_RAG.md.
Aman dipakai tim Hub untuk integrasi.
```
