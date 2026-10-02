#!/usr/bin/env python3
"""
uji_backend_rag.py - uji kontrak API layanan RAG BPS Kalteng.

Mengecek perilaku yang dijanjikan di KONTRAK_API_RAG.md terhadap layanan
Flask yang SEDANG BERJALAN (harus ada Ollama + Qdrant sungguhan).

Instal : pip install requests
Contoh :
  # aman (tidak menulis data): health, auth, validasi, tanya-jawab, SKIPPED
  python uji_backend_rag.py --key KUNCI_ANDA

  # + uji antrean serentak
  python uji_backend_rag.py --key KUNCI_ANDA --concurrent 4

  # + ingest sungguhan dengan PDF sintetis (menulis lalu menghapus dokumen uji,
  #   ikut mengosongkan cache jawaban; jalankan saat server sedang sepi)
  python uji_backend_rag.py --key KUNCI_ANDA --with-ingest --with-sop

Variabel lingkungan alternatif: RAG_BASE_URL, RAG_API_KEY.
Kode keluar: 0 = tidak ada FAIL, 1 = ada FAIL.
"""
import argparse
import os
import sys
import threading
import time
import uuid

try:
    import requests
except ImportError:
    sys.exit("Butuh paket requests:  pip install requests")

# ----------------------------------------------------------------- pelapor
RESULTS = []  # (bagian, status, nama, detail)
_BAGIAN = [""]
LAPORAN = [None]
LABEL = {"PASS": "[LULUS]", "FAIL": "[GAGAL]", "WARN": "[PERHATIAN]", "SKIP": "[DILEWATI]"}


def _rec(status, name, detail=""):
    RESULTS.append((_BAGIAN[0], status, name, detail))
    print(f"  {LABEL[status].ljust(11)} {name}", flush=True)
    if detail and status != "PASS":
        print(f"              -> {detail}", flush=True)


def check(name, cond, detail=""):
    _rec("PASS" if cond else "FAIL", name, "" if cond else detail)
    return bool(cond)


def warn(name, detail=""):
    _rec("WARN", name, detail)


def skip(name, reason=""):
    _rec("SKIP", name, reason)


def section(title, apa=""):
    _BAGIAN[0] = title
    print(f"\n=== {title} ===", flush=True)
    if apa:
        print(f"    Tujuan: {apa}", flush=True)


# ------------------------------------------------------------ pembuat PDF
def _esc(s):
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def make_pdf(pages):
    """PDF minimal (Helvetica, teks murni) tanpa pustaka tambahan.
    pages = list halaman; tiap halaman = list baris teks (ASCII)."""
    objs = []  # isi objek 1..n (tanpa 'n 0 obj')
    n_pages = len(pages)
    kids = " ".join(f"{4 + 2 * i} 0 R" for i in range(n_pages))
    objs.append("<< /Type /Catalog /Pages 2 0 R >>")
    objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {n_pages} >>")
    objs.append("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    for i, lines in enumerate(pages):
        content_id = 5 + 2 * i
        objs.append(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {content_id} 0 R >>"
        )
        stream = "BT /F1 11 Tf 50 790 Td 15 TL\n" + "\n".join(
            f"({_esc(l)}) Tj T*" for l in lines
        ) + "\nET"
        objs.append(f"<< /Length {len(stream.encode('latin-1'))} >>\nstream\n{stream}\nendstream")
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n{body}\nendobj\n".encode("latin-1")
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def pdf_publikasi(token, extra=""):
    p1 = [
        "BADAN PUSAT STATISTIK",
        "PROVINSI KALIMANTAN TENGAH",
        "Badan Pusat Statistik Provinsi Kalimantan Tengah",
        f"Laporan Uji Otomatis {token}",
        "ISSN 0000-0000",
        "No. Katalog 0000000.62",
        "Nomor Publikasi 62000.0000",
        "Ukuran Buku 21 x 29,7 cm",
        f"Ringkasan uji {extra}".strip(),
    ]
    p2 = [f"BAB 1 Pendahuluan {token}",
          "Dokumen ini dibuat otomatis oleh skrip uji dan akan dihapus setelah pengujian.",
          f"Pada tahun uji, indikator sintetis XYZ-{token} di Kalimantan Tengah adalah 12,34 persen.",
          "Angka ini hanya untuk memastikan dokumen dapat diindeks dan ditemukan kembali.",
          f"Kesimpulan uji {token}: indikator XYZ-{token} bernilai 12,34 persen.",
          ]
    return make_pdf([p1, p2])


def pdf_sop(token):
    p1 = [
        "STANDAR OPERASIONAL PROSEDUR",
        f"Nomor SOP : 999/UJI/{token}",
        "Tanggal Pembuatan : 01 Januari 2026",
        f"Judul SOP : Prosedur Uji Otomatis {token}",
        "Kegiatan 1 : Petugas menyiapkan berkas uji.",
        "Kegiatan 2 : Petugas memeriksa berkas uji.",
        "Kegiatan 3 : Petugas mengarsipkan berkas uji.",
    ]
    return make_pdf([p1])


def pdf_acak():
    return make_pdf([["Resep Nasi Goreng", "Bahan: nasi, bawang, kecap.",
                      "Tumis bawang, masukkan nasi, aduk rata."]])


# ------------------------------------------------------------------ klien
class Client:
    def __init__(self, base, key, timeout):
        self.base = base.rstrip("/")
        self.key = key
        self.timeout = timeout

    def _h(self, key="__default__"):
        k = self.key if key == "__default__" else key
        return {"Authorization": f"Bearer {k}"} if k else {}

    def get(self, path, key="__default__", **kw):
        return requests.get(self.base + path, headers=self._h(key),
                            timeout=kw.pop("timeout", self.timeout), **kw)

    def post(self, path, key="__default__", **kw):
        return requests.post(self.base + path, headers=self._h(key),
                             timeout=kw.pop("timeout", self.timeout), **kw)

    def delete(self, path, key="__default__", **kw):
        return requests.delete(self.base + path, headers=self._h(key),
                               timeout=kw.pop("timeout", self.timeout), **kw)

    def ask(self, q, no_cache=False, key="__default__", timeout=None):
        body = {"question": q}
        if no_cache:
            body["no_cache"] = True
        return self.post("/api/ask", key=key, json=body, timeout=timeout or self.timeout)

    def ingest(self, name, data, key="__default__", **fields):
        return self.post("/api/ingest", key=key,
                         files={"file": (name, data, "application/pdf")},
                         data={k: str(v) for k, v in fields.items()})


def jbody(r):
    try:
        return r.json()
    except Exception:
        return {}


TERMINAL = {"INDEXED", "FAILED", "SKIPPED", "DELETED", "SUPERSEDED"}


def poll(c, job_id, timeout):
    t0, last, seen = time.time(), None, []
    while time.time() - t0 < timeout:
        r = c.get(f"/api/ingest/{job_id}")
        j = jbody(r)
        st = j.get("status")
        if st != last:
            seen.append(st)
            print(f"        status: {st} {j.get('progress', '')}", flush=True)
            last = st
        if st in TERMINAL:
            return j, seen
        time.sleep(4)
    return jbody(c.get(f"/api/ingest/{job_id}")), seen


# ------------------------------------------------------------------ tes
def t_health(c, wait):
    section("1. Health", "memastikan layanan hidup dan pipeline sudah selesai dimuat")
    t0 = time.time()
    j = {}
    while time.time() - t0 < wait:
        try:
            r = c.get("/api/health", key=None, timeout=10)
            j = jbody(r)
            if j.get("ready"):
                break
        except requests.RequestException as e:
            j = {"err": str(e)}
        time.sleep(5)
    if not check("health: layanan siap (ready=true)", j.get("ready") is True,
                 f"tidak siap dalam {wait}s: {j}"):
        return False
    q = j.get("queue") or {}
    check("health: objek queue lengkap",
          all(k in q for k in ("active", "waiting", "max_concurrent", "max_waiting")), str(q))
    print(f"        queue = {q}")
    r = c.get("/", key=None)
    check("halaman / dan /static tanpa key tidak 401", r.status_code != 401, str(r.status_code))
    return True


def t_auth(c, have_key):
    section("2. Autentikasi", "memastikan hanya pemanggil yang membawa API key yang boleh masuk")
    r = c.get("/api/documents", key=None)
    if have_key:
        check("tanpa header -> 401 di /api/documents", r.status_code == 401, str(r.status_code))
        r = c.get("/api/documents", key="kunci-salah-xyz")
        check("key salah -> 401 di /api/documents", r.status_code == 401, str(r.status_code))
        r = c.ask("uji", key=None)
        check("tanpa header -> 401 di /api/ask", r.status_code == 401, str(r.status_code))
        r = c.ask("uji", key="kunci-salah-xyz")
        check("key salah -> 401 di /api/ask", r.status_code == 401, str(r.status_code))
        check("body 401 sesuai kontrak", jbody(r) == {"error": "Tidak diizinkan."}, r.text[:120])
        r = c.get("/api/documents")
        if r.status_code == 401:
            check("key yang diberikan diterima server", False, "server menolak --key Anda")
            return False
    else:
        if r.status_code == 401:
            check("server memakai key, tetapi --key tidak diberikan", False,
                  "jalankan lagi dengan --key")
            return False
        warn("RAG_API_KEY tampaknya kosong di server",
             f"/api/documents tanpa key -> {r.status_code} (503 = ingest dimatikan). "
             "Di produksi WAJIB isi key.")
    return True


def t_ask_validasi(c):
    section("3. /api/ask - validasi", "pertanyaan kosong harus ditolak dengan pesan yang benar")
    r = c.ask("")
    check("pertanyaan kosong -> 400", r.status_code == 400, str(r.status_code))
    check("pesan error 400 sesuai kontrak",
          jbody(r).get("error") == "Pertanyaan tidak boleh kosong.", r.text[:120])
    r = c.post("/api/ask", json={})
    check("tanpa field question -> 400", r.status_code == 400, str(r.status_code))


def _check_schema(name, j):
    ok = check(f"{name}: field wajib (mode, answer, sources)",
               all(k in j for k in ("mode", "answer", "sources")), f"kunci: {list(j)}")
    opt = ["warning", "note", "combined", "combined_titles", "image_only",
           "featured_image", "cached", "cache_match"]
    miss = [k for k in opt if k not in j]
    if miss:
        warn(f"{name}: field opsional tidak ada di respons", ", ".join(miss))
    mode_ok = j.get("mode") in ("qa", "list_publications", "summary",
                                "summary_not_found", "needs_clarification")
    check(f"{name}: nilai mode valid", mode_ok, str(j.get("mode")))
    check(f"{name}: sources berupa list", isinstance(j.get("sources"), list))
    if j.get("image_only") is True:
        check(f"{name}: image_only=true wajib disertai featured_image",
              isinstance(j.get("featured_image"), dict)
              and all(k in j["featured_image"] for k in ("url", "page", "title")),
              str(j.get("featured_image")))
    fi = j.get("featured_image")
    if isinstance(fi, dict):
        check(f"{name}: featured_image.url path relatif /static/",
              str(fi.get("url", "")).startswith("/static/"), str(fi.get("url")))
    for s in j.get("sources") or []:
        for im in s.get("images") or []:
            if not str(im.get("url", "")).startswith("/static/"):
                warn(f"{name}: url gambar tidak relatif /static/", str(im.get("url")))
                break
    return ok


def t_ask(c, question, sop_question):
    section("4. /api/ask - tanya-jawab sungguhan", "bentuk JSON jawaban sesuai kontrak, gambar SOP, dan cache berfungsi")
    t0 = time.time()
    r = c.ask(question, no_cache=True, timeout=240)
    dt = time.time() - t0
    if not check("pertanyaan publikasi -> 200", r.status_code == 200,
                 f"{r.status_code} {r.text[:200]}"):
        return
    j = jbody(r)
    print(f"        waktu jawab tanpa cache: {dt:.1f}s | mode={j.get('mode')} | "
          f"sumber={len(j.get('sources') or [])}")
    _check_schema("publikasi", j)
    check("publikasi: jawaban tidak kosong", bool((j.get("answer") or "").strip()))
    check("publikasi: no_cache=true -> cached=false", j.get("cached") in (False, None),
          str(j.get("cached")))

    r1 = c.ask(question, timeout=240)  # tulis ke cache (bila layak di-cache)
    j1 = jbody(r1)
    # app.py (_is_cacheable): jawaban dengan warning, mode needs_clarification /
    # summary_not_found, atau teks kosong SENGAJA tidak di-cache.
    cacheable = (r1.status_code == 200 and not j1.get("warning")
                 and j1.get("mode") not in ("needs_clarification", "summary_not_found")
                 and bool((j1.get("answer") or "").strip()))
    if not cacheable:
        skip("ulangan dari cache",
             "jawaban pertama tidak layak di-cache (ada warning / butuh klarifikasi). "
             "Pakai --question yang jawabannya jelas agar bagian ini teruji.")
    else:
        t1 = time.time()
        r2 = c.ask(question, timeout=240)  # harus dari cache
        dt2 = time.time() - t1
        j2 = jbody(r2)
        if check("pertanyaan sama dua kali -> 200", r2.status_code == 200, str(r2.status_code)):
            check("ulangan dari cache (cached=true, exact)",
                  j2.get("cached") is True and j2.get("cache_match") == "exact",
                  f"cached={j2.get('cached')} match={j2.get('cache_match')}")
            print(f"        waktu jawab dari cache: {dt2:.1f}s")

    if sop_question:
        r = c.ask(sop_question, no_cache=True, timeout=240)
        if check("pertanyaan SOP -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}"):
            j = jbody(r)
            _check_schema("SOP", j)
            n_img = sum(len(s.get("images") or []) for s in j.get("sources") or [])
            if n_img == 0 and not j.get("featured_image"):
                warn("SOP: tidak ada gambar halaman di respons",
                     "kebijakan: teks + gambar halaman selalu tampil. Cek apakah pertanyaan "
                     "benar-benar mengena SOP.")
            else:
                check("SOP: ada gambar halaman", True)
            print(f"        image_only={j.get('image_only')} gambar={n_img}")
    else:
        skip("pertanyaan SOP", "beri --sop-question untuk mengujinya")


def t_ingest_validasi(c):
    section("5. /api/ingest - validasi input", "input salah harus ditolak dengan kode yang benar (tidak menulis data)")
    r = c.post("/api/ingest", data={})
    check("tanpa field file -> 400", r.status_code == 400, str(r.status_code))
    r = c.ingest("catatan.txt", b"halo")
    check("ekstensi bukan .pdf -> 400", r.status_code == 400, str(r.status_code))
    r = c.ingest("palsu.pdf", b"ini bukan pdf")
    check("isi bukan PDF -> 400", r.status_code == 400, str(r.status_code))
    r = c.ingest("x.pdf", pdf_acak(), jenis="ngawur")
    check("jenis tidak valid -> 400", r.status_code == 400, str(r.status_code))
    r = c.ingest("x.pdf", pdf_acak(), force="true")
    check("force=true tanpa jenis eksplisit -> 400", r.status_code == 400, str(r.status_code))
    r = c.get("/api/ingest/tidak-ada-job-ini")
    check("GET job tidak ada -> 404", r.status_code == 404, str(r.status_code))
    r = c.delete("/api/documents/tidak-ada-job-ini")
    check("DELETE job tidak ada -> 404", r.status_code == 404, str(r.status_code))
    r = c.get("/api/documents", params={"limit": 5})
    if check("GET /api/documents -> 200", r.status_code == 200, str(r.status_code)):
        j = jbody(r)
        check("documents: {count, documents[]}",
              "count" in j and isinstance(j.get("documents"), list), str(list(j)))


def t_skipped(c):
    section("6. PDF acak -> SKIPPED", "PDF yang bukan publikasi/SOP BPS dilewati, bukan dianggap galat")
    name = f"ZZ_UJI_ACAK_{uuid.uuid4().hex[:8]}.pdf"
    data = pdf_acak()
    r = c.ingest(name, data)
    j = jbody(r)
    check("PDF acak -> HTTP 200 (bukan 202)", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    check("status = SKIPPED", j.get("status") == "SKIPPED", str(j.get("status")))
    check("catatan alasan skip terisi", bool(j.get("catatan")), "catatan kosong")
    r2 = c.ingest(name, data)
    check("kirim ulang file yang di-skip tidak 409 (bukan duplikat)",
          r2.status_code == 200 and jbody(r2).get("status") == "SKIPPED",
          f"{r2.status_code} {r2.text[:200]}")


def t_concurrent(c, n, question):
    section(f"7. Antrean: {n} pertanyaan serentak", "pertanyaan berbarengan antre rapi; yang kelebihan dijawab 503 server_sibuk, bukan error")
    out = [None] * n

    def work(i):
        try:
            r = c.ask(question, no_cache=True, timeout=300)
            out[i] = (r.status_code, jbody(r), r.headers)
        except Exception as e:  # noqa
            out[i] = (0, {"error": str(e)}, {})

    ths = [threading.Thread(target=work, args=(i,)) for i in range(n)]
    t0 = time.time()
    for t in ths:
        t.start()
    time.sleep(3)
    try:
        q = jbody(c.get("/api/health", key=None)).get("queue")
        print(f"        health saat antre: {q}")
        if q and n > q.get("max_concurrent", 1):
            check("health menunjukkan antrean terisi (waiting>0 atau active>0)",
                  (q.get("waiting", 0) + q.get("active", 0)) > 0, str(q))
    except Exception as e:  # noqa
        warn("health saat antre gagal", str(e))
    for t in ths:
        t.join()
    print(f"        selesai dalam {time.time() - t0:.0f}s; kode: {[o[0] for o in out]}")
    check("semua respons 200 atau 503-server_sibuk",
          all(o[0] == 200 or (o[0] == 503 and o[1].get("error") == "server_sibuk") for o in out),
          str([(o[0], o[1].get("error")) for o in out]))
    check("minimal satu pertanyaan terjawab (200)", any(o[0] == 200 for o in out))
    for code, body, hdr in out:
        if code == 503 and body.get("error") == "server_sibuk":
            check("503 server_sibuk: reason valid",
                  body.get("reason") in ("antrean_penuh", "timeout_antre"), str(body.get("reason")))
            check("503 server_sibuk: retry_after angka + header Retry-After",
                  isinstance(body.get("retry_after"), (int, float)) and "Retry-After" in hdr,
                  f"{body.get('retry_after')} / {dict(hdr)}")
            break
    else:
        print("        (tidak ada 503 - antrean cukup panjang; uji 503 butuh --concurrent "
              "> ASK_MAX_CONCURRENT + ASK_MAX_WAITING)")


def t_ingest_penuh(c, timeout, jenis_pub_ok=True):
    section("8. Ingest publikasi (PDF uji)", "unggah PDF uji, tunggu terindeks, cek duplikat/replace, lalu hapus kembali")
    token = uuid.uuid4().hex[:8]
    name = f"ZZ_UJI_OTOMATIS_{token}.pdf"
    data = pdf_publikasi(token)
    created = []
    try:
        r = c.ingest(name, data, title=f"Uji Otomatis {token}", uploader="test_script",
                     kategori="uji")
        j = jbody(r)
        if not check("POST /api/ingest -> 202", r.status_code == 202, f"{r.status_code} {r.text[:250]}"):
            if j.get("status") == "SKIPPED":
                warn("PDF sintetis dianggap bukan dokumen terdaftar",
                     j.get("catatan", "") + " -> periksa deteksi publikasi.")
            return
        jid = j.get("job_id")
        created.append(jid)
        check("respons 202 memuat field kontrak",
              all(k in j for k in ("job_id", "filename", "status", "jenis", "jenis_basis")),
              str(list(j)))
        check("filename = nama asli", j.get("filename") == name, str(j.get("filename")))
        check("jenis = publikasi", j.get("jenis") == "publikasi",
              f"{j.get('jenis')} ({j.get('jenis_basis')})")
        if j.get("status") == "MENUNGGU_PERSETUJUAN":
            print("        mode persetujuan aktif -> memanggil /approve")
            ra = c.post(f"/api/ingest/{jid}/approve")
            check("approve -> 202", ra.status_code == 202, f"{ra.status_code} {ra.text[:200]}")
        else:
            check("status awal PENDING", j.get("status") == "PENDING", str(j.get("status")))

        fin, seen = poll(c, jid, timeout)
        if not check("job selesai INDEXED", fin.get("status") == "INDEXED",
                     f"{fin.get('status')} error={fin.get('error')} urutan={seen}"):
            return
        check("chunks > 0", (fin.get("chunks") or 0) > 0, str(fin.get("chunks")))
        check("error kosong", not fin.get("error"), str(fin.get("error")))

        r = c.get("/api/documents", params={"limit": 1000})
        ids = [d.get("job_id") for d in jbody(r).get("documents", [])]
        check("dokumen muncul di GET /api/documents", jid in ids)
        r = c.get("/api/documents", params={"jenis": "publikasi", "limit": 1000})
        check("filter jenis=publikasi berfungsi", r.status_code == 200
              and all(d.get("jenis") == "publikasi" for d in jbody(r).get("documents", [])))

        r = c.ingest(name, data)
        j = jbody(r)
        check("upload identik -> 409", r.status_code == 409, f"{r.status_code} {r.text[:200]}")
        check("409 identik memuat existing_job_id yang benar",
              j.get("existing_job_id") == jid, str(j))
        r = c.ingest(name, pdf_publikasi(token, extra="versi-berbeda"))
        j = jbody(r)
        check("nama sama isi beda tanpa replace -> 409", r.status_code == 409,
              f"{r.status_code} {r.text[:200]}")
        check("409 nama sama memuat existing_chunks", "existing_chunks" in j, str(j))

        r = c.post(f"/api/ingest/{jid}/approve")
        check("approve pada job non-menunggu -> 409", r.status_code == 409,
              f"{r.status_code} {r.text[:200]}")

        # tanya-jawab atas dokumen uji
        r = c.ask(f"Berapa nilai indikator XYZ-{token} di Kalimantan Tengah?",
                  no_cache=True, timeout=240)
        if r.status_code == 200:
            a = jbody(r)
            hit = "12,34" in (a.get("answer") or "") or any(
                token in (s.get("title") or "") for s in a.get("sources") or [])
            if hit:
                check("chatbot menjawab dari dokumen yang baru diunggah", True)
            else:
                warn("dokumen baru belum terjawab oleh chatbot",
                     "bisa karena LLM kecil/skor rendah; periksa manual. "
                     f"warning={a.get('warning')}")
        else:
            warn("tanya-jawab atas dokumen uji gagal", f"{r.status_code} {r.text[:150]}")

        # replace
        r = c.ingest(name, pdf_publikasi(token, extra="versi-2"), replace="true",
                     title=f"Uji Otomatis {token} v2")
        if check("replace=true -> 202", r.status_code == 202, f"{r.status_code} {r.text[:200]}"):
            jid2 = jbody(r).get("job_id")
            created.append(jid2)
            fin2, _ = poll(c, jid2, timeout)
            check("job pengganti INDEXED", fin2.get("status") == "INDEXED",
                  f"{fin2.get('status')} {fin2.get('error')}")
            old = jbody(c.get(f"/api/ingest/{jid}"))
            check("job lama menjadi SUPERSEDED", old.get("status") == "SUPERSEDED",
                  str(old.get("status")))
            jid = jid2

        r = c.delete(f"/api/documents/{jid}")
        j = jbody(r)
        check("DELETE dokumen -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        check("status DELETED & chunks_removed > 0",
              j.get("status") == "DELETED" and (j.get("chunks_removed") or 0) > 0, str(j))
        r = c.delete(f"/api/documents/{jid}")
        check("DELETE kedua kali -> 409", r.status_code == 409, str(r.status_code))
        created = [x for x in created if x != jid]
        print("        catatan: PDF asli dan file di INGEST_DATA_DIR tetap tersimpan di server.")
    finally:
        for x in created:  # bersih-bersih bila tes gagal di tengah jalan
            try:
                st = jbody(c.get(f"/api/ingest/{x}")).get("status")
                if st == "INDEXED":
                    c.delete(f"/api/documents/{x}")
                    print(f"        pembersihan: dokumen uji {x} ditarik")
                elif st in ("PENDING", "PROCESSING", "MENUNGGU_PERSETUJUAN"):
                    warn("dokumen uji belum selesai saat tes berakhir",
                         f"job {x} status {st}; tarik manual lewat DELETE bila sudah INDEXED")
            except Exception:
                pass


def t_ingest_sop(c, timeout):
    section("9. Ingest SOP (PDF uji)", "PDF ber-header Nomor SOP dikenali sebagai SOP, lalu dihapus kembali")
    token = uuid.uuid4().hex[:8]
    name = f"ZZ_UJI_SOP_{token}.pdf"
    r = c.ingest(name, pdf_sop(token), uploader="test_script")
    j = jbody(r)
    if not check("POST SOP -> 202", r.status_code == 202, f"{r.status_code} {r.text[:250]}"):
        if j.get("status") == "SKIPPED":
            warn("PDF SOP sintetis di-skip", j.get("catatan", ""))
        return
    jid = j.get("job_id")
    check("jenis terdeteksi sop dari header 'Nomor SOP'", j.get("jenis") == "sop",
          f"{j.get('jenis')} ({j.get('jenis_basis')})")
    try:
        if j.get("status") == "MENUNGGU_PERSETUJUAN":
            c.post(f"/api/ingest/{jid}/approve")
        fin, seen = poll(c, jid, timeout)
        ok = check("job SOP INDEXED", fin.get("status") == "INDEXED",
                   f"{fin.get('status')} error={fin.get('error')}")
        if ok:
            if fin.get("catatan"):
                warn("catatan SOP (non-fatal)", fin["catatan"])
            check("chunks SOP > 0", (fin.get("chunks") or 0) > 0, str(fin.get("chunks")))
    finally:
        st = jbody(c.get(f"/api/ingest/{jid}")).get("status")
        if st == "INDEXED":
            r = c.delete(f"/api/documents/{jid}")
            check("DELETE SOP uji -> 200", r.status_code == 200, str(r.status_code))
            print("        catatan: gambar halaman SOP di static/sop_images TIDAK ikut terhapus "
                  "(sesuai kontrak).")


# ------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser(description="Uji kontrak API RAG BPS Kalteng")
    ap.add_argument("--base", default=os.getenv("RAG_BASE_URL", "http://localhost:5000"))
    ap.add_argument("--key", default=os.getenv("RAG_API_KEY", ""))
    ap.add_argument("--question", default="Berapa tingkat pengangguran terbuka di Kalimantan Tengah?",
                    help="pertanyaan publikasi untuk uji tanya-jawab")
    ap.add_argument("--sop-question", default="",
                    help="pertanyaan SOP nyata (mis. prosedur yang pasti ada di korpus)")
    ap.add_argument("--concurrent", type=int, default=0,
                    help="jumlah pertanyaan serentak untuk uji antrean (0 = lewati)")
    ap.add_argument("--with-ingest", action="store_true",
                    help="uji ingest sungguhan dgn PDF publikasi sintetis (menulis lalu menghapus)")
    ap.add_argument("--with-sop", action="store_true",
                    help="uji ingest SOP sintetis (menulis lalu menghapus)")
    ap.add_argument("--wait-ready", type=int, default=300, help="detik menunggu ready=true")
    ap.add_argument("--ingest-timeout", type=int, default=600, help="detik maks per job ingest")
    ap.add_argument("--timeout", type=int, default=60, help="timeout HTTP umum")
    ap.add_argument("--laporan", default="hasil_uji_backend.md",
                    help="berkas laporan (Markdown) untuk dikirim ke tim; kosongkan untuk mematikan")
    a = ap.parse_args()
    LAPORAN[0] = a.laporan or None
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    c = Client(a.base, a.key, a.timeout)
    print(f"Target: {c.base} | key: {'ada' if a.key else 'tidak ada'}")

    try:
        if not t_health(c, a.wait_ready):
            return summary()
        if not t_auth(c, bool(a.key)):
            return summary()
        t_ask_validasi(c)
        t_ask(c, a.question, a.sop_question)

        probe = c.get("/api/documents")
        ingest_on = probe.status_code != 503
        if not ingest_on:
            skip("uji ingest", "endpoint ingest 503 (RAG_API_KEY kosong & INGEST_ALLOW_NO_AUTH!=1)")
        else:
            t_ingest_validasi(c)
            t_skipped(c)
        if a.concurrent > 0:
            t_concurrent(c, a.concurrent, a.question)
        else:
            skip("uji antrean serentak", "beri --concurrent N (mis. 4)")
        if ingest_on and a.with_ingest:
            t_ingest_penuh(c, a.ingest_timeout)
        else:
            skip("ingest publikasi sintetis", "beri --with-ingest")
        if ingest_on and a.with_sop:
            t_ingest_sop(c, a.ingest_timeout)
        else:
            skip("ingest SOP sintetis", "beri --with-sop")
    except requests.RequestException as e:
        check("koneksi ke layanan", False, f"{type(e).__name__}: {e}")
    return summary()


def summary():
    n = {k: sum(1 for r in RESULTS if r[1] == k) for k in ("PASS", "FAIL", "WARN", "SKIP")}
    gagal = [r for r in RESULTS if r[1] == "FAIL"]
    perhatian = [r for r in RESULTS if r[1] == "WARN"]
    lewat = [r for r in RESULTS if r[1] == "SKIP"]
    out = ["", "=" * 64,
           f"RINGKASAN: {n['PASS']} lulus | {n['FAIL']} gagal | "
           f"{n['WARN']} perlu dicek manual | {n['SKIP']} dilewati", ""]
    if gagal:
        out.append(f"HASIL: BELUM SIAP. Ada {len(gagal)} pengujian yang gagal:")
        for b_, _, name, d in gagal:
            out.append(f"  - [{b_}] {name}")
            if d:
                out.append(f"      penyebab: {d}")
        out.append("Langkah: kirim SELURUH keluaran ini ke pembuat backend, jangan hanya potongannya.")
    elif lewat:
        out.append("HASIL: LULUS, tetapi belum lengkap. Semua yang dijalankan lulus,")
        out.append("namun bagian berikut BELUM diuji:")
        for b_, _, name, d in lewat:
            out.append(f"  - {name}" + (f" ({d})" if d else ""))
    else:
        out.append("HASIL: SEMUA LULUS. Layanan RAG berperilaku sesuai KONTRAK_API_RAG.md.")
        out.append("Aman dipakai tim Hub untuk integrasi.")
    if perhatian:
        out.append("")
        out.append("Perlu dicek manual (bukan kegagalan):")
        for b_, _, name, d in perhatian:
            out.append(f"  - {name}" + (f": {d}" if d else ""))
    text = "\n".join(out)
    print(text)
    if LAPORAN[0]:
        try:
            with open(LAPORAN[0], "w", encoding="utf-8") as f:
                f.write("# Laporan uji kontrak API RAG BPS Kalteng\n\n")
                f.write(f"Waktu: {time.strftime('%Y-%m-%d %H:%M:%S')}\n\n")
                cur = None
                for b_, st, name, d in RESULTS:
                    if b_ != cur:
                        f.write(f"\n## {b_}\n\n")
                        cur = b_
                    f.write(f"- **{LABEL[st]}** {name}" + (f"  \n  penyebab/catatan: {d}" if d and st != "PASS" else "") + "\n")
                f.write("\n## Ringkasan\n\n```\n" + text + "\n```\n")
            print(f"\nLaporan tersimpan: {LAPORAN[0]}")
        except OSError as e:
            print(f"(gagal menulis laporan: {e})")
    return 1 if gagal else 0


if __name__ == "__main__":
    sys.exit(main())
