"""
chat.py (revisi)
Chatbot RAG untuk tanya-jawab isi publikasi BPS Kalteng.
Menggunakan data yang SUDAH ter-index di Qdrant (lewat ingest.py).

PERUBAHAN DIBANDING VERSI SEBELUMNYA:
  1. find_best_matching_title() dirombak total. Filter judul sekarang hanya
     nyala kalau pertanyaan BENAR-BENAR terlihat menyebut sebuah judul
     publikasi (minimal 2 kata isi cocok + syarat precision terhadap judul).
     difflib dibuang. Bonus tahun dibuang; tahun hanya dipakai sebagai
     diskualifikasi edisi yang salah. Pertanyaan multi-tahun (perbandingan)
     otomatis mematikan filter.
  2. Filter judul TIDAK LAGI mengunci pencarian ke satu dokumen. Retrieval
     dijalankan dua jalur (dengan filter + tanpa filter), hasilnya digabung,
     lalu re-ranker yang memutuskan. Filter jadi 'boost', bukan 'gate'.
  3. Re-ranker diganti BAAI/bge-reranker-v2-m3 (multilingual, jalan di GPU).
  4. Tampilan skor diperbaiki: skor mentah ditampilkan apa adanya, dan
     ambang peringatan dipisah antara relevansi absolut vs relatif.

Jalankan:
    .\\venv\\Scripts\\python.exe chat.py
"""

import re
import math
import json
import os
import time
import hashlib
from urllib.parse import quote, unquote

from llama_index.core import VectorStoreIndex, Settings, QueryBundle
from llama_index.core.retrievers import BaseRetriever
from llama_index.core.query_engine import RetrieverQueryEngine
from llama_index.core.postprocessor import SentenceTransformerRerank
from llama_index.core.postprocessor.types import BaseNodePostprocessor
from llama_index.llms.ollama import Ollama
from llama_index.embeddings.ollama import OllamaEmbedding
from llama_index.vector_stores.qdrant import QdrantVectorStore
import qdrant_client
from qdrant_client.models import Filter, FieldCondition, MatchText, MatchValue

# ============== KONFIGURASI (samakan dengan ingest.py) ==============
# Default "localhost" tetap dipertahankan supaya chat.py masih bisa dijalankan
# langsung di luar Docker (mis. lewat venv) seperti sebelumnya. Saat dijalankan
# lewat docker-compose, app.py/Dockerfile akan mengoper QDRANT_HOST=qdrant dan
# OLLAMA_BASE_URL=http://ollama:11434 sesuai nama service di docker-compose.yml.
QDRANT_HOST = os.environ.get("QDRANT_HOST", "localhost")
QDRANT_PORT = int(os.environ.get("QDRANT_PORT", "6333"))
COLLECTION_NAME = "bps_kalteng_publikasi"

OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")

# --- Model LLM: konfigurasi via env, bukan hardcode ---
# Mesin dev sekarang VRAM <=4GB -- hermes3 (basis Llama-3.1 8B) kegedean,
# bikin lambat/OOM. Default LLM_MODEL diturunkan ke model kecil yang muat di
# GPU 4GB. Nanti pindah ke server internal BPS (spek belum diketahui pasti),
# TIDAK PERLU ubah kode -- cukup set env var saat menjalankan container:
#   LLM_MODEL=hermes3            (atau model besar lain sesuai VRAM server)
# LLM_MODEL_FALLBACK dipakai otomatis kalau model utama gagal dimuat/dipanggil
# (mis. Ollama balas error OOM/model belum di-pull) -- lihat get_llm_with_fallback().
# Fallback sengaja model paling ringan (jalan meski CPU-only) supaya chatbot
# tetap bisa jawab (walau kualitas turun) daripada mati total.
LLM_MODEL = os.environ.get("LLM_MODEL", "qwen2.5:3b-instruct")
LLM_MODEL_FALLBACK = os.environ.get("LLM_MODEL_FALLBACK", "qwen2.5:1.5b-instruct")
EMBED_MODEL = "nomic-embed-text"

# Kandidat dari jalur TANPA filter judul (pencarian global ke seluruh korpus).
TOP_K_GLOBAL = 30
# Kandidat dari jalur DENGAN filter judul (kalau judul terdeteksi).
# Ini jalur 'boost': dokumen yang judulnya cocok dapat kesempatan ekstra,
# tapi tidak mematikan jalur global.
TOP_K_FILTERED = 30
# Jumlah chunk terbaik setelah re-rank yang benar-benar dikirim ke LLM.
# Diturunkan dari 8 -> 6 (optimisasi GPU/kecepatan): prompt lebih kecil
# tanpa mengubah CONTEXT_WINDOW (lihat catatan di bawah -- sempat dicoba
# turun ke 3072 dan CRASH "available context size not non-negative" karena
# prompt riil pernah tembus ~4000 token bahkan dgn TOP_K_FINAL=8 lama.
# TOP_K_FINAL=6 aman dikombinasi dgn CONTEXT_WINDOW=4096 karena cuma
# mengecilkan prompt, TIDAK mengecilkan context window yg jadi plafonnya).
TOP_K_FINAL = 6

# JANGAN diturunkan lagi di bawah 4096 tanpa cek dulu ukuran prompt riil
# (lihat n_tokens di `docker logs ollama`) -- pernah tembus ~4000 token
# untuk pertanyaan SOP, dan Ollama butuh context_window >= prompt_tokens +
# num_predict (512) + sedikit margin, kalau tidak akan crash dgn error
# "Calculated available context size ... was not non-negative".
CONTEXT_WINDOW = 4096  # samakan dengan num_ctx di bawah

# --- Re-ranker ---
# bge-reranker-v2-m3: multilingual (termasuk Bahasa Indonesia), jauh lebih
# akurat daripada ms-marco-MiniLM-L-2-v2 yang English-only. Ukurannya besar
# (~568M param) sehingga WAJIB di GPU supaya latensinya wajar.
RERANK_MODEL = "BAAI/bge-reranker-v2-m3"
RERANK_DEVICE = "cpu"   # VRAM terbatas (4GB) -- reranker dipindah ke CPU supaya
                        # LLM (hermes3) tidak rebutan VRAM dan tidak ter-offload
                        # sebagian ke CPU (yang jauh lebih lambat untuk generation).
                        # Ganti "cuda" balik kalau nanti VRAM sudah lega (mis. LLM
                        # diganti model lebih kecil, atau upgrade GPU).

# Batas keras jumlah chunk per dokumen untuk mode ringkasan.
MAX_FULL_DOC_CHUNKS = 4000
SUMMARY_BATCH_SIZE = 20

TITLES_CACHE_FILE = "titles_cache.json"

# --- Ambang-ambang pencocokan judul ---
# Skor F1 minimum (0-1) antara kata-isi pertanyaan dan kata-isi judul supaya
# sebuah judul dianggap "memang disebut user". Dinaikkan drastis dari 0.35
# karena versi lama terlalu gampang nyala untuk pertanyaan yang sama sekali
# tidak menyebut judul.
TITLE_MATCH_THRESHOLD = 0.55
# Minimal berapa kata isi (non-stopword) harus cocok persis.
TITLE_MIN_OVERLAP_WORDS = 2
# Minimal proporsi kata-isi JUDUL yang muncul di pertanyaan. Ini yang mencegah
# judul panjang ("Pengeluaran dan Konsumsi Penduduk ... Maret 2020") menang
# hanya karena satu kata ("penduduk") kebetulan nyambung.
TITLE_MIN_PRECISION = 0.5

DEBUG_SHOW_RETRIEVED_CHUNKS = True

# Ambang peringatan pada skor mentah re-ranker (logit bge-reranker-v2-m3).
# Nilai < 0 berarti model menilai pasangan (pertanyaan, chunk) TIDAK relevan.
RERANK_SCORE_WARN_THRESHOLD = 0.0

# Kalau selisih skor mentah antara publikasi #1 dan #2 di bawah ini, sistem
# menganggap keduanya "sama-sama kandidat" dan TIDAK akan membiarkan
# response_synthesizer bawaan llama_index membaurkan chunk dua dokumen begitu
# saja ke satu jawaban tanpa penjelasan. Sebagai gantinya, jawaban disusun
# ulang lewat answer_combined_from_multiple_documents(): tetap SATU jawaban,
# tapi tiap potongan konteks diberi label tegas sumber & halamannya, dan LLM
# diinstruksikan untuk menampilkan semua angka yang berbeda antar sumber
# secara eksplisit -- bukan diam-diam memilih salah satu (kasus nyata: TPT
# Kalteng 2023 versi "Dalam Infografis" = 4,10%, versi "Potret TPB" = 3,78%,
# keduanya publikasi resmi BPS yang sah, jadi keduanya harus disebutkan).
AMBIGUITY_MARGIN = 0.5
# Kalau skor mentah publikasi teratas masih di bawah ini, jangan repot bikin
# jawaban per-dokumen sama sekali -> semuanya dianggap tidak relevan.
AMBIGUITY_MIN_RAW_SCORE = -2.0

# --- Jalur tambahan "SOP boost" ---
# Pertanyaan bernada prosedural ("instruksi/cara/langkah/prosedur/SOP ...")
# mendapat 1 jalur retrieval EKSTRA yang dibatasi ke jenis_dokumen == "sop".
# BOOST, bukan gate: jalur global tetap jalan dan re-ranker tetap yang
# memutuskan. Latar belakang (bukti nyata dari log): "bagaimana instruksi
# untuk cuti pegawai" -> 5 dokumen yang lolos re-rank semuanya publikasi
# statistik (Indeks Tendensi Konsumen dst), TIDAK ADA SOP sama sekali, karena
# tanpa kata "SOP" embedding pertanyaan lebih dekat ke teks publikasi.
SOP_DOC_TYPE = "sop"          # samakan dgn DOC_TYPE di ingest/sop.py
# Lokasi & URL gambar halaman SOP -- samakan dgn SOP_IMAGE_DIR / SOP_IMAGE_URL_PREFIX
# di ingest/sop.py (static/ sejajar folder ingest/, chat.py ada di root proyek).
SOP_IMAGE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "sop_images")
SOP_IMAGE_URL_PREFIX = "/static/sop_images"
SOP_BOOST_TOP_K = 12
PROCEDURAL_RE = re.compile(
    r"\b(?:sop|prosedur|instruksi|intruksi|tata cara|cara|langkah|alur|"
    r"tahapan|mekanisme|petunjuk|panduan|pedoman|proses|syarat|persyaratan|"
    # Kata kerja pengajuan/pengurusan: "bagaimana mengajukan cuti pegawai?"
    # tidak memuat satupun kata di atas, jadi jalur SOP-boost tidak menyala dan
    # SOP cuti tak pernah jadi kandidat (yang keluar malah publikasi pertanian,
    # skor negatif). \b + kata utuh, jadi "mengajukan" tidak cocok dgn "ajukan".
    r"ajukan|mengajukan|diajukan|pengajuan|urus|mengurus|pengurusan|"
    r"permohonan|memohon|mohon|usulan|mengusulkan|pengusulan)\b",
    re.IGNORECASE,
)


def is_procedural_request(question: str) -> bool:
    """True kalau pertanyaan memakai kata bernada prosedur. Hanya dipakai untuk
    MENAMBAH kandidat SOP (boost); salah-positif cuma menambah kandidat yang
    nanti dinilai re-ranker, bukan mengunci hasil."""
    return bool(PROCEDURAL_RE.search(question or ""))


# Filter relevansi RELATIF antar-dokumen, dijalankan SETELAH re-rank dan SEBELUM
# chunk dikirim ke LLM (lihat RelativeScoreDocFilter). Sebuah dokumen (title)
# dibuang seluruhnya kalau skor chunk terbaiknya lebih rendah dari
# (skor chunk terbaik keseluruhan - RELEVANCE_DROP_MARGIN).
#
# Latar belakang bug: "berikan SOP cuti pegawai" ikut membawa SOP "Pelayanan
# Tamu Disabilitas" ke LLM krn top_n re-ranker (TOP_K_FINAL) cuma memotong
# JUMLAH, bukan menilai relevansi -- 6 chunk teratas selalu diteruskan
# walau sebagian jelas dari dokumen lain, dan LLM ikut memakainya.
#
# Nilai 2.0 dicek ke 2 log nyata (skala logit): 4 SOP satu keluarga berskor
# 4.57/4.39/4.06/3.64 lolos, dokumen tak relevan 0.47/0.07 terbuang; kasus
# tanpa jawaban: top -2.38, sisanya -4.9 ke bawah terbuang. Masih boleh
# disetel bila ada kasus baru. Setiap
# query mencetak skor terbaik per dokumen + mana yang dibuang ke log
# ("[FILTER-RELEVANSI]") -- pakai itu untuk menyetel angkanya. Harus
# >= AMBIGUITY_MARGIN supaya deteksi "dua dokumen sama kuat" tidak terganggu.
RELEVANCE_DROP_MARGIN = 2.0
assert RELEVANCE_DROP_MARGIN >= AMBIGUITY_MARGIN

PAYLOAD_TEXT_FIELD_CANDIDATES = ["text", "content", "chunk_text", "_node_content"]
PAYLOAD_CHUNK_INDEX_FIELD = "chunk_index"

SUMMARY_KEYWORDS = ["ringkas", "rangkum", "ikhtisar", "summary", "rangkuman", "ringkasan"]

# Kata kunci yang menandakan user minta DAFTAR publikasi/link yang berhubungan
# dengan suatu topik -- ini permintaan "cari semua dokumen relevan", beda
# tujuan dengan pertanyaan QA biasa ("cari SATU jawaban paling tepat").
LIST_PUBLICATIONS_KEYWORDS = [
    "link publikasi", "link-link publikasi", "semua link", "semua publikasi",
    "daftar publikasi", "daftar link", "list publikasi", "list link",
    "publikasi apa saja", "publikasi mana saja", "publikasi yang berhubungan",
    "publikasi yang berkaitan", "publikasi terkait", "sebutkan publikasi",
    "publikasi tentang", "link-link yang berhubungan",
]

# Retrieval untuk mode ini sengaja jauh lebih LUAS daripada TOP_K_FINAL (8)
# yang dipakai jalur QA biasa, karena tujuannya mendaftar SEMUA dokumen yang
# relevan, bukan memilih satu jawaban terbaik.
LIST_PUBLICATIONS_TOP_K = 100        # kandidat chunk mentah (vector search)
LIST_PUBLICATIONS_MAX_TITLES = 40    # BUKAN target jumlah -- cuma batas pengaman kalau
                                      # publikasi yang genuinely lolos dua gerbang relevansi
                                      # (lihat list_related_publications) ternyata sangat banyak.
                                      # Kalau yang lolos cuma 4, ya cuma 4 itu yang ditampilkan --
                                      # tidak ada logika padding di sistem ini.
# Skor embedding cosine similarity mentah TERLALU LONGGAR untuk memutuskan
# relevansi topik di korpus ini: dokumen BPS mana pun sama-sama membahas
# "Kalimantan Tengah" dan istilah statistik umum, jadi skornya cenderung
# tetap tinggi walau topik spesifiknya (mis. "jagung") sama sekali tidak
# dibahas. Karena itu daftar publikasi TIDAK memakai ambang embedding --
# semua kandidat diskor ulang lewat re-ranker (sama seperti jalur QA biasa)
# dan dipakai ambang skor re-ranker di bawah ini.
LIST_PUBLICATIONS_RERANK_MIN_SCORE = RERANK_SCORE_WARN_THRESHOLD  # 0.0: re-ranker sendiri menilai relevan

# Kata-kata "cangkang permintaan" yang muncul di pertanyaan mode daftar-
# publikasi tapi BUKAN bagian dari topik yang dicari (mis. "berikan saya
# link publikasi yang membahas X" -> kata topiknya cuma "X"). Dipisah dari
# STOPWORDS_ID karena kata-kata ini spesifik untuk pola permintaan "daftar
# publikasi", bukan untuk pencocokan judul.
LIST_MODE_EXTRA_STOPWORDS = {
    "berikan", "berikanlah", "saya", "carikan", "carilah", "membahas",
    "berhubungan", "berkaitan", "terkait", "mengenai", "daftar", "list",
    "link", "publikasi", "publikasinya",
}


def extract_topic_keywords(question: str):
    """
    Kata-isi TOPIK dari pertanyaan mode daftar-publikasi, setelah membuang
    STOPWORDS_ID umum DAN kata-kata cangkang permintaan di atas. Dipakai
    sebagai gerbang wajib: kalau tidak ada satu pun kata ini yang benar-benar
    tertulis di teks chunk, publikasi itu TIDAK dianggap relevan, walau
    skor semantik/embedding-nya tinggi (lihat catatan di
    LIST_PUBLICATIONS_RERANK_MIN_SCORE kenapa skor semantik saja tidak cukup
    tajam untuk korpus BPS yang topik-topiknya saling berdekatan).
    """
    return [w for w in extract_title_keywords(question) if w not in LIST_MODE_EXTRA_STOPWORDS]


# ======================================================================
# Deteksi pertanyaan yang butuh KONTEKS LEBIH LEBAR daripada QA biasa:
# tren/deret waktu, perbandingan antar entitas (kabupaten/kota/wilayah),
# dan multi-topik dalam satu kalimat. TOP_K_FINAL=8 bawaan dirancang untuk
# "satu jawaban paling tepat" -- untuk ketiga jenis pertanyaan ini, chunk
# yang relevan justru TERSEBAR (di tahun berbeda / entitas berbeda / topik
# berbeda), jadi 8 slot besar kemungkinan keburu penuh oleh satu
# tahun/entitas/topik saja yang skornya kebetulan tertinggi. Solusinya BUKAN
# jalur retrieval terpisah, cukup lebarkan top_n re-ranker untuk pertanyaan
# ini + instruksikan LLM eksplisit lewat SYSTEM_PROMPT (ATURAN #12 utk tren,
# #13 utk perbandingan) untuk menyusun sendiri deret/daftar-nya dari
# potongan-potongan konteks yang lebih banyak itu.
# ======================================================================
WIDE_RETRIEVAL_TOP_N = 24  # vs TOP_K_FINAL=8 bawaan

TREND_KEYWORDS = [
    "tren", "trend", "perkembangan", "naik turun", "dari tahun",
    "antar tahun", "tahun ke tahun", "setiap tahun", "beberapa tahun terakhir",
]

COMPARISON_KEYWORDS = [
    "kabupaten mana", "kota mana", "wilayah mana", "per kabupaten",
    "tiap kabupaten", "setiap kabupaten", "seluruh kabupaten",
    "masing-masing kabupaten", "antar kabupaten", "dibandingkan",
    "perbandingan", "tertinggi", "terendah", "paling tinggi",
    "paling rendah", "ranking", "peringkat",
]

# Kata sambung yang menandakan kemungkinan >1 topik berbeda dalam satu
# kalimat, mis. "penduduk miskin DAN tingkat pengangguran".
_MULTI_TOPIC_CONNECTOR_RE = re.compile(r"\s+(?:dan|serta)\s+", re.IGNORECASE)


def extract_years_mentioned(question: str):
    """Semua tahun 4-digit (1900-2099) yang disebut eksplisit di pertanyaan."""
    return sorted(set(re.findall(r"\b(?:19|20)\d{2}\b", question)))


def is_trend_request(question: str) -> bool:
    q_lower = question.lower()
    if any(kw in q_lower for kw in TREND_KEYWORDS):
        return True
    return len(extract_years_mentioned(question)) >= 2


def is_comparison_request(question: str) -> bool:
    q_lower = question.lower()
    return any(kw in q_lower for kw in COMPARISON_KEYWORDS)


def is_multi_topic_request(question: str) -> bool:
    """
    Heuristik kasar: pertanyaan terbagi >=2 klausa oleh kata sambung
    "dan"/"serta", dan klausa-klausa itu punya kata kunci topik
    (extract_topic_keywords) yang BENAR-BENAR BERBEDA satu sama lain --
    bukan cuma pecahan kalimat wajar (mis. "kemiskinan dan ketimpangan"
    seringnya memang 1 topik gabungan yang lumrah, sedangkan "penduduk
    miskin dan tingkat pengangguran" adalah 2 topik yang jelas berbeda).
    Heuristik ini sengaja longgar: false positive (dianggap multi-topik
    padahal bukan) cuma berakibat retrieval lebih lebar, tidak merusak
    jawaban seperti false negative pada kasus sebaliknya.
    """
    parts = [p.strip() for p in _MULTI_TOPIC_CONNECTOR_RE.split(question) if p.strip()]
    if len(parts) < 2:
        return False
    keyword_sets = [frozenset(extract_topic_keywords(p)) for p in parts]
    keyword_sets = [s for s in keyword_sets if s]
    return len(set(keyword_sets)) >= 2


def needs_wide_retrieval(question: str):
    """Return salah satu dari 'trend' / 'comparison' / 'multi_topic' / None."""
    if is_trend_request(question):
        return "trend"
    if is_comparison_request(question):
        return "comparison"
    if is_multi_topic_request(question):
        return "multi_topic"
    return None


# Kata umum yang diabaikan saat menyusun kata kunci judul dari pertanyaan.
STOPWORDS_ID = {
    "ringkas", "ringkasan", "rangkum", "rangkuman", "ikhtisar", "summary",
    "isi", "dari", "yang", "dan", "atau", "ini", "itu",
    "berapa", "apa", "bagaimana", "provinsi", "di", "pada", "tahun",
    "publikasi", "dokumen", "tentang", "adalah", "untuk", "dengan",
    "jelaskan", "sebutkan", "kalimantan", "tengah", "kalteng",
    # tambahan: kata-kata yang sering muncul di pertanyaan statistik tapi
    # tidak membedakan judul satu dengan yang lain.
    "jumlah", "menurut", "bps", "data", "angka", "banyak", "besar",
    "total", "rata", "berapakah", "sebanyak", "mohon", "tolong",
    "bandingkan", "perbandingan", "hitung", "carikan", "cari",
}
# ======================================================================

SYSTEM_PROMPT = """Kamu adalah asisten resmi BPS (Badan Pusat Statistik) Provinsi Kalimantan Tengah.
Tugasmu menjawab pertanyaan pegawai internal berdasarkan HANYA pada isi publikasi resmi BPS yang diberikan sebagai konteks.

ATURAN PENTING:
1. Jawab HANYA dalam Bahasa Indonesia yang baku dan formal.
2. Gunakan istilah statistik resmi BPS dengan benar (contoh: PDRB = Produk Domestik Regional Bruto, ADHB = Atas Dasar Harga Berlaku, ADHK = Atas Dasar Harga Konstan).
3. Jawab HANYA berdasarkan konteks/dokumen yang diberikan. Jangan menambahkan informasi dari pengetahuan umummu sendiri, terutama untuk angka dan data statistik.
4. Kalau informasi yang ditanyakan TIDAK ADA di dalam konteks yang diberikan, katakan dengan jujur bahwa informasi tersebut tidak ditemukan dalam publikasi yang tersedia. JANGAN mengarang angka atau data.
5. Kalau relevan, sebutkan angka persis seperti yang tertulis di dokumen sumber, jangan dibulatkan atau diubah.
5b. Setiap potongan konteks yang diberikan disertai metadata `page_label` (nomor halaman asal potongan itu di dokumen PDF). Kalau memungkinkan, sebutkan nomor halaman sumber angka/kutipan penting langsung di dalam jawaban (contoh: "...sebesar 2.189.000 jiwa (hal. 37)"), supaya pembaca bisa memverifikasi langsung ke dokumen aslinya.
6. Jawaban ringkas, jelas, dan langsung ke inti pertanyaan.
7. SEBELUM memberi angka apa pun, pastikan angka itu memang tertulis secara eksplisit di potongan teks konteks yang diberikan, BUKAN hasil tebakan atau ekstrapolasi dari topik dokumen. Kalau ragu apakah suatu angka benar-benar ada di konteks, jangan sebutkan angka itu — katakan informasi tidak ditemukan.
8. Kalau konteks yang diberikan terlihat TIDAK berkaitan dengan topik pertanyaan (misalnya pertanyaan tentang PDRB tapi konteks berisi survei kehutanan atau kliping pers), katakan bahwa dokumen yang tersedia tampaknya tidak membahas topik tersebut, JANGAN tetap memberi jawaban seolah-olah relevan.
9. WASPADA TERTUKAR INDIKATOR YANG MIRIP. Publikasi BPS sering membahas beberapa indikator berbeda untuk topik yang sama dalam satu dokumen (contoh: Tingkat Penghunian Kamar vs Tingkat Pemakaian Tempat Tidur; ADHB vs ADHK; ekspor vs impor). Sebelum menjawab, pastikan angka yang kamu ambil BENAR-BENAR berasal dari kalimat/tabel yang secara eksplisit menyebut NAMA INDIKATOR yang sama persis dengan yang ditanyakan pengguna, kata per kata. Kalau konteks yang diberikan hanya membahas indikator lain yang mirip topiknya tapi BUKAN indikator yang ditanya, JANGAN memakai angka indikator itu — katakan bahwa angka untuk indikator yang ditanyakan secara spesifik tidak ditemukan di konteks yang diberikan.
10. WASPADA TAHUN DAN PERIODE. Pastikan angka yang kamu kutip benar-benar untuk TAHUN/PERIODE yang ditanyakan. Judul publikasi yang memuat suatu tahun TIDAK berarti seluruh angka di dalamnya untuk tahun tersebut. Kalau pengguna menanyakan beberapa tahun sekaligus dan hanya sebagian yang tersedia di konteks, sebutkan mana yang ditemukan dan nyatakan sisanya tidak ditemukan.
11. WASPADA CAKUPAN/LINGKUP OBJEK YANG BERBEDA (bukan cuma indikator atau tahun). Pastikan angka yang kamu ambil benar-benar untuk OBJEK/WILAYAH/UNIT yang ditanyakan, bukan sekadar topik yang terdengar mirip. Contoh: "wisatawan mancanegara ke Provinsi Kalimantan Tengah" TIDAK SAMA DENGAN "pengunjung Taman Nasional Tanjung Puting"; "penduduk Kabupaten X" TIDAK SAMA DENGAN "penduduk Kecamatan Y di Kabupaten X"; "ekspor Kalimantan Tengah" TIDAK SAMA DENGAN "ekspor lewat Pelabuhan Z". Kalau konteks yang tersedia hanya membahas objek/wilayah/unit yang LEBIH SEMPIT, LEBIH LUAS, atau SEKADAR BERKAITAN TOPIK dengan yang ditanyakan pengguna — dan bukan objek yang sama persis — JANGAN memakai angka itu sebagai jawaban, sekalipun dengan tambahan catatan/disclaimer di akhir. Nyatakan dengan TEGAS DAN YAKIN bahwa angka untuk objek/wilayah yang ditanyakan secara spesifik TIDAK DITEMUKAN dalam publikasi yang tersedia, baru boleh (opsional) menyebutkan data terdekat yang ada sebagai informasi tambahan yang jelas dinyatakan BUKAN jawaban atas pertanyaan tersebut.
12. PERTANYAAN TREN/DERET WAKTU (mis. "bagaimana tren X dari tahun A sampai B", "perkembangan Y beberapa tahun terakhir"): jangan tuntut adanya satu kalimat eksplisit di konteks yang membahas kata "tren"/"perkembangan" itu sendiri. Sebagai gantinya, KUMPULKAN angka indikator yang sama (indikator dan objek/wilayah yang sama persis, sesuai aturan #9 dan #11) untuk MASING-MASING TAHUN yang disebutkan di berbagai potongan konteks yang tersedia (boleh berasal dari beberapa halaman atau bahkan beberapa publikasi berbeda, misalnya edisi tahunan yang berbeda), lalu SUSUN SENDIRI deret angka per tahun tersebut sebagai jawaban (contoh format: "2018: [angka] (hal. X), 2019: [angka] (hal. Y), ..."), dan simpulkan arah trennya (naik/turun/fluktuatif) berdasarkan deret angka itu. Sebutkan sumber & halaman untuk tiap titik data. Kalau sebagian tahun dalam rentang yang ditanyakan memang tidak ada angkanya di konteks manapun, sebutkan secara eksplisit tahun-tahun mana yang datanya tidak ditemukan, TAPI tetap sajikan tren dari tahun-tahun yang datanya tersedia — jangan langsung menyimpulkan seluruh pertanyaan "tidak ditemukan" hanya karena tidak ada satu kalimat naratif yang merangkum trennya.
13. PERTANYAAN PERBANDINGAN/ENUMERASI ANTAR ENTITAS (mis. "kabupaten/kota mana yang X-nya tertinggi", "bandingkan Y antar kabupaten", "sebutkan Z tiap kabupaten/kota di Kalimantan Tengah"): JANGAN hanya menyebutkan SATU entitas (mis. satu kabupaten) lalu berhenti. Sisir SELURUH potongan konteks yang diberikan, kumpulkan angka untuk SETIAP kabupaten/kota/wilayah yang datanya tersedia di sana (bukan cuma yang kebetulan ada di potongan pertama), lalu sajikan sebagai daftar per entitas (contoh format: "Kabupaten A: [angka] (hal. X), Kabupaten B: [angka] (hal. Y), ..."). Kalau pertanyaannya spesifik minta "mana yang tertinggi/terendah", urutkan/soroti entitas yang dimaksud SETELAH menyajikan datanya, jangan langsung memberi 1 nama tanpa menunjukkan angka pembandingnya. Kalau konteks yang tersedia ternyata hanya memuat sebagian kabupaten/kota (tidak lengkap semua wilayah), sebutkan itu secara eksplisit — jangan diam-diam hanya menjawab yang datanya kebetulan ada tanpa penjelasan.
14. PERTANYAAN YANG MENGANDUNG BEBERAPA TOPIK SEKALIGUS dalam satu kalimat (mis. "berapa penduduk miskin DAN tingkat pengangguran Kalimantan Tengah tahun 2020?"): jawab SETIAP topik secara terpisah dan jelas berlabel (mis. "Penduduk miskin: ... (hal. X). Tingkat pengangguran: ... (hal. Y)."), jangan cuma menjawab salah satu topik dan mengabaikan yang lain. Kalau salah satu topik memang tidak ada datanya di konteks yang diberikan, katakan topik mana yang tidak ditemukan, tapi tetap jawab topik lain yang datanya tersedia.

Contoh gaya jawaban yang benar:
Pertanyaan: "Berapa PDRB Kalimantan Tengah tahun 2024 atas dasar harga berlaku?"
Jawaban: "Berdasarkan publikasi yang tersedia, PDRB Provinsi Kalimantan Tengah tahun 2024 Atas Dasar Harga Berlaku (ADHB) tercatat sebesar [angka sesuai dokumen]."

Contoh kasus cakupan objek berbeda (rujuk aturan #11):
Pertanyaan: "Berapa jumlah kunjungan wisatawan mancanegara ke Kalimantan Tengah tahun 2023?"
Konteks yang tersedia: hanya berisi jumlah pengunjung Taman Nasional Tanjung Puting tahun 2023.
Jawaban yang BENAR: "Informasi mengenai jumlah wisatawan mancanegara ke Provinsi Kalimantan Tengah tahun 2023 tidak ditemukan dalam publikasi yang tersedia. Yang tersedia hanya data jumlah pengunjung Taman Nasional Tanjung Puting tahun 2023 (termasuk wisatawan mancanegara sebanyak [angka] orang), namun ini merupakan data satu destinasi wisata, bukan angka wisatawan mancanegara untuk seluruh provinsi."
Jawaban yang SALAH (jangan ditiru): menjawab seolah angka pengunjung Taman Nasional Tanjung Puting adalah jawaban atas jumlah wisatawan mancanegara ke Kalimantan Tengah, meski disertai catatan "datanya mungkin tidak identik karena beda definisi/metodologi" di akhir.

Contoh kasus pertanyaan tren (rujuk aturan #12):
Pertanyaan: "Bagaimana tren PDRB per kapita Kalimantan Tengah dari 2018 sampai 2022?"
Konteks yang tersedia: potongan dari "PDRB ... 2014-2018" menyebut angka 2018, dan potongan dari "... Dalam Angka 2025" menyebut angka 2019-2022.
Jawaban yang BENAR: "Berdasarkan data yang tersedia, PDRB per kapita Kalimantan Tengah menunjukkan tren [naik/turun/fluktuatif]: 2018 sebesar [angka] (hal. X, publikasi A), 2019 sebesar [angka] (hal. Y, publikasi B), 2020 sebesar [angka] (hal. Z, publikasi B), dst. [Sebutkan tahun yang tidak ditemukan datanya, jika ada]."
Jawaban yang SALAH (jangan ditiru): "Tren PDRB per kapita ... tidak disoroti dalam publikasi yang tersedia" padahal angka tiap tahunnya sebenarnya ada tersebar di beberapa potongan konteks, hanya saja tidak ada satu kalimat yang secara eksplisit menyebut kata "tren".
"""

SUMMARY_SYSTEM_PROMPT = """Kamu adalah asisten resmi BPS (Badan Pusat Statistik) Provinsi Kalimantan Tengah.
Kamu diberi seluruh (atau sebagian besar) isi SATU publikasi resmi BPS secara berurutan.
Tugasmu membuat RINGKASAN isi publikasi tersebut.

ATURAN PENTING:
1. Jawab HANYA dalam Bahasa Indonesia yang baku dan formal.
2. Ringkasan harus berdasarkan HANYA pada teks yang diberikan, jangan menambah informasi dari luar.
3. Sebutkan poin-poin utama: topik/cakupan publikasi, metodologi (kalau disebutkan), dan temuan/angka penting yang tertulis eksplisit di teks.
4. Jangan mengarang angka. Kalau suatu bagian teks terpotong atau tidak lengkap, jangan menebak isinya.
5. Susun ringkasan dalam beberapa paragraf singkat atau poin-poin, bukan menyalin ulang teks secara panjang lebar.
"""

BULAN_LIST = [
    "januari", "februari", "maret", "april", "mei", "juni",
    "juli", "agustus", "september", "oktober", "november", "desember",
]


def is_summary_request(question: str) -> bool:
    q_lower = question.lower()
    return any(kw in q_lower for kw in SUMMARY_KEYWORDS)


def is_list_publications_request(question: str) -> bool:
    """
    Deteksi kasar: user minta DAFTAR publikasi/link yang berhubungan dengan
    suatu topik (contoh: "berikan semua link publikasi yang berhubungan
    dengan penduduk miskin di Kalimantan Tengah tahun 2018"), bukan
    pertanyaan yang menuntut satu angka/jawaban spesifik.
    """
    q_lower = question.lower()
    return any(kw in q_lower for kw in LIST_PUBLICATIONS_KEYWORDS)


def _normalize(text: str) -> str:
    return re.sub(r"[^a-z0-9 ]", " ", text.lower()).strip()


def extract_title_keywords(question: str):
    """
    Ambil kata-kata "isi" dari pertanyaan: bukan stopword, bukan angka,
    panjang > 2 huruf. Ini kandidat kata yang mungkin bagian dari judul
    publikasi yang disebut user.
    """
    words = re.findall(r"[a-zA-Z]+", question.lower())
    return [w for w in words if w not in STOPWORDS_ID and len(w) > 2]


def _title_content_words(title: str):
    """Kata-isi dari sebuah judul publikasi, dengan aturan yang sama."""
    return {
        w for w in re.findall(r"[a-z]+", _normalize(title))
        if len(w) > 2 and w not in STOPWORDS_ID
    }


def build_or_load_title_index(client):
    """
    Bangun (atau muat dari cache) daftar semua judul publikasi unik yang ada
    di collection Qdrant, untuk fuzzy-matching judul yang disebut user.
    Hapus TITLES_CACHE_FILE kalau data di Qdrant sudah berubah.
    """
    if os.path.exists(TITLES_CACHE_FILE):
        try:
            with open(TITLES_CACHE_FILE, "r", encoding="utf-8") as f:
                titles = json.load(f)
            print(f"Memuat {len(titles)} judul publikasi dari cache ({TITLES_CACHE_FILE}).")
            return titles
        except Exception:
            pass  # cache korup -> bangun ulang

    print("Membangun daftar judul publikasi unik dari Qdrant (sekali saja, mungkin butuh waktu)...")
    titles_seen = {}
    next_offset = None
    scanned = 0
    while True:
        points, next_offset = client.scroll(
            collection_name=COLLECTION_NAME,
            limit=2000,
            offset=next_offset,
            with_payload=["title", "link_publikasi"],
        )
        if not points:
            break
        for p in points:
            title = (p.payload.get("title") or "").strip()
            link = (p.payload.get("link_publikasi") or "").strip()
            if title and title not in titles_seen:
                titles_seen[title] = link
        scanned += len(points)
        if next_offset is None:
            break

    titles = [{"title": t, "link_publikasi": l} for t, l in titles_seen.items()]
    print(f"Ditemukan {len(titles)} judul publikasi unik dari {scanned} chunk.")

    try:
        with open(TITLES_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(titles, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[PERINGATAN] Gagal menyimpan cache judul: {e}")

    return titles


# ======================================================================
# PERBAIKAN #1 — pencocokan judul yang jauh lebih ketat
# ======================================================================

def find_best_matching_title(question: str, titles_index):
    """
    Cari judul publikasi yang BENAR-BENAR disebut oleh user.

    Filosofinya berubah dari versi lama: dulu fungsi ini berusaha selalu
    menemukan "judul paling mirip" dan hampir selalu berhasil menemukan
    sesuatu di atas ambang. Sekarang fungsi ini defaultnya MENOLAK, dan hanya
    mengembalikan judul kalau ada bukti kuat user memang menyebutnya.

    Perubahan konkret:
      - difflib.SequenceMatcher DIBUANG. Kemiripan karakter antara kalimat
        pertanyaan dan judul adalah sinyal sampah untuk Bahasa Indonesia:
        dua teks apa pun dapat ~0.3-0.5 hanya karena sama-sama banyak
        imbuhan "an"/"kan"/"nya".
      - Skor = F1 antara kata-isi pertanyaan dan kata-isi judul, bukan
        recall sepihak. Judul panjang yang sebagian besar katanya TIDAK
        disebut user akan jatuh sendiri lewat komponen precision.
      - Syarat keras: minimal TITLE_MIN_OVERLAP_WORDS kata isi cocok DAN
        precision >= TITLE_MIN_PRECISION.
      - Bonus tahun DIBUANG. Dulu +0.15 diberikan hampir gratis karena
        hampir semua pertanyaan statistik menyebut tahun dan hampir semua
        judul BPS mengandung tahun. Sekarang tahun HANYA dipakai untuk
        mendiskualifikasi edisi yang salah.
      - Pertanyaan yang menyebut LEBIH DARI SATU tahun dianggap permintaan
        perbandingan lintas publikasi -> filter dimatikan total.

    Return: (title, link, score) atau (None, None, skor_terbaik).
    """
    q_words = set(extract_title_keywords(question))
    if len(q_words) < TITLE_MIN_OVERLAP_WORDS:
        return None, None, 0.0

    tahun_all = set(re.findall(r"\b(?:19|20)\d{2}\b", question))
    if len(tahun_all) > 1:
        # "Bandingkan ... 2014, 2019, dan 2020" -> mustahil dijawab dari satu
        # publikasi. Versi lama hanya menangkap tahun pertama lewat re.search
        # lalu mengunci ke edisi 2014.
        return None, None, 0.0
    tahun_found = next(iter(tahun_all), None)

    best = (None, None, 0.0)

    for entry in titles_index:
        title = entry["title"]
        title_words = _title_content_words(title)
        if not title_words:
            continue

        inter = q_words & title_words
        if len(inter) < TITLE_MIN_OVERLAP_WORDS:
            continue

        recall = len(inter) / len(q_words)        # seberapa banyak pertanyaan tercakup judul
        precision = len(inter) / len(title_words)  # seberapa banyak judul tercakup pertanyaan
        if precision < TITLE_MIN_PRECISION:
            continue

        score = 2 * recall * precision / (recall + precision)

        # Tahun hanya sebagai diskualifikasi, bukan bonus.
        if tahun_found:
            tt = re.search(r"\b(?:19|20)\d{2}\b", title)
            if tt and tt.group(0) != tahun_found:
                continue  # edisi tahun yang salah

        if score > best[2]:
            best = (title, entry.get("link_publikasi"), score)

    if best[2] < TITLE_MATCH_THRESHOLD:
        return None, None, best[2]
    return best


def extract_keyword_filter(question: str, titles_index=None):
    """
    Tentukan filter metadata 'title' Qdrant dari pertanyaan, dengan prioritas:
      1. Fuzzy match ketat ke daftar judul asli (find_best_matching_title).
      2. Pola bulan+tahun (khas publikasi berkala), HANYA kalau pertanyaan
         menyebut tepat satu tahun.
      3. Tidak memfilter sama sekali.

    Return: (Filter|None, judul/keyword untuk ditampilkan|None, link|None)
    """
    if titles_index:
        matched_title, matched_link, _score = find_best_matching_title(question, titles_index)
        if matched_title:
            return (
                Filter(must=[FieldCondition(key="title", match=MatchText(text=matched_title))]),
                matched_title,
                matched_link,
            )

    q_lower = question.lower()
    tahun_all = set(re.findall(r"\b(?:19|20)\d{2}\b", question))
    if len(tahun_all) != 1:
        return None, None, None
    tahun_found = next(iter(tahun_all))

    bulan_found = next((b for b in BULAN_LIST if b in q_lower), None)
    if bulan_found:
        keyword = f"{bulan_found} {tahun_found}"
        return (
            Filter(must=[FieldCondition(key="title", match=MatchText(text=keyword))]),
            keyword,
            None,
        )

    return None, None, None


# ======================================================================
# PERBAIKAN #2 — filter judul jadi 'boost', bukan 'gate'
# ======================================================================

class HybridTitleBoostRetriever(BaseRetriever):
    """
    Menjalankan dua retrieval lalu menggabungkan hasilnya:

      - Jalur GLOBAL   : vector search ke seluruh korpus, tanpa filter apa pun.
      - Jalur FILTERED : vector search yang dibatasi ke dokumen dengan judul
                         yang terdeteksi (kalau ada).

    Versi lama hanya menjalankan jalur FILTERED dan mengunci pencarian ke satu
    dokumen. Akibatnya kalau tebakan judulnya meleset, 975 publikasi lain tidak
    pernah punya kesempatan di-retrieve, dan re-ranker cuma bisa memilih chunk
    terbaik DARI DOKUMEN YANG SALAH — yang lalu ditampilkan dengan skor tinggi.

    Sekarang dokumen yang judulnya cocok hanya mendapat kesempatan EKSTRA untuk
    masuk daftar kandidat. Keputusan akhir tetap di tangan re-ranker, yang
    melihat kandidat dari kedua jalur secara bersamaan.
    """

    def __init__(self, index, qdrant_filter=None,
                 top_k_global=TOP_K_GLOBAL, top_k_filtered=TOP_K_FILTERED,
                 sop_boost=False, top_k_sop=SOP_BOOST_TOP_K):
        self._index = index
        self._qdrant_filter = qdrant_filter
        self._top_k_global = top_k_global
        self._top_k_filtered = top_k_filtered
        self._sop_boost = sop_boost
        self._top_k_sop = top_k_sop
        super().__init__()

    def _retrieve(self, query_bundle: QueryBundle):
        # Embed pertanyaan SEKALI, dipakai ulang semua jalur (global/judul/SOP).
        # Tanpa ini tiap as_retriever().retrieve() meng-embed ulang pertanyaan
        # yang sama (2-3x panggilan Ollama embedding utk 1 pertanyaan).
        t0 = time.perf_counter()
        if query_bundle.embedding is None:
            try:
                query_bundle.embedding = Settings.embed_model.get_query_embedding(
                    query_bundle.query_str)
            except Exception as e:
                print(f"[PERINGATAN] Embed-sekali gagal ({type(e).__name__}: {e}) -- "
                      f"tiap jalur meng-embed sendiri.")
        t_embed = time.perf_counter() - t0
        try:
            return self._retrieve_paths(query_bundle)
        finally:
            _LAST_RETRIEVAL_TIMING["embed"] = t_embed
            _LAST_RETRIEVAL_TIMING["search"] = time.perf_counter() - t0 - t_embed

    def _retrieve_paths(self, query_bundle: QueryBundle):
        nodes_by_id = {}

        global_retriever = self._index.as_retriever(similarity_top_k=self._top_k_global)
        for n in global_retriever.retrieve(query_bundle):
            nodes_by_id[n.node.node_id] = n

        if self._qdrant_filter is not None:
            filtered_retriever = self._index.as_retriever(
                similarity_top_k=self._top_k_filtered,
                vector_store_kwargs={"qdrant_filters": self._qdrant_filter},
            )
            for n in filtered_retriever.retrieve(query_bundle):
                # kalau sudah ada dari jalur global, pertahankan yang skornya
                # lebih tinggi (skor ini toh akan ditimpa re-ranker)
                prev = nodes_by_id.get(n.node.node_id)
                if prev is None or (n.score or 0) > (prev.score or 0):
                    nodes_by_id[n.node.node_id] = n

        if self._sop_boost:
            # Jalur SOP: kandidat ekstra dari dokumen jenis "sop" saja. Dibungkus
            # try/except supaya kegagalan jalur tambahan ini TIDAK PERNAH
            # menggagalkan retrieval utama di atas.
            try:
                sop_filter = Filter(must=[FieldCondition(
                    key="jenis_dokumen", match=MatchValue(value=SOP_DOC_TYPE))])
                sop_retriever = self._index.as_retriever(
                    similarity_top_k=self._top_k_sop,
                    vector_store_kwargs={"qdrant_filters": sop_filter},
                )
                n_added = 0
                sop_hits = sop_retriever.retrieve(query_bundle)
                for n in sop_hits:
                    if n.node.node_id not in nodes_by_id:
                        n_added += 1
                    prev = nodes_by_id.get(n.node.node_id)
                    if prev is None or (n.score or 0) > (prev.score or 0):
                        nodes_by_id[n.node.node_id] = n
                print(f"[INFO] Jalur SOP-boost aktif: {n_added} kandidat SOP baru ditambahkan.")
                # Diagnostik: judul kandidat SOP SEBELUM re-rank (skor = kemiripan
                # vektor, BUKAN skor re-ranker). Membedakan "SOP yang dicari tidak
                # pernah ter-retrieve" (masalah embedding/teks chunk) dari "ter-retrieve
                # tapi dinilai rendah re-ranker" (masalah kualitas teks chunk).
                best_by_title = {}
                for n in sop_hits:
                    t = _doc_key(n.node.metadata)
                    if n.score is not None:
                        best_by_title[t] = max(best_by_title.get(t, n.score), n.score)
                cand = " | ".join(f"{sc:.3f} {t[:60]}"
                                  for t, sc in sorted(best_by_title.items(), key=lambda x: -x[1]))
                print(f"[KANDIDAT-SOP] sebelum re-rank: {cand}")
            except Exception as e:
                print(f"[PERINGATAN] Jalur SOP-boost gagal ({type(e).__name__}: {e}) -- "
                      f"dilanjutkan tanpa jalur SOP.")

        return list(nodes_by_id.values())


# Timeout khusus untuk test-ping model saat startup (get_llm_with_fallback).
# Sengaja jauh lebih pendek dari REQUEST_TIMEOUT (180s) supaya kalau model
# utama macet/OOM, sistem cepat pindah ke fallback -- bukan nunggu 180 detik
# dulu baru gagal.
LLM_HEALTHCHECK_TIMEOUT = 60.0


def get_llm_with_fallback():
    """Coba LLM_MODEL dulu; kalau gagal (OOM/model belum ada/dsb), otomatis
    turun ke LLM_MODEL_FALLBACK supaya chatbot tetap jalan."""
    for model_name in (LLM_MODEL, LLM_MODEL_FALLBACK):
        healthcheck_llm = Ollama(
            model=model_name,
            base_url=OLLAMA_BASE_URL,
            request_timeout=LLM_HEALTHCHECK_TIMEOUT,
            context_window=CONTEXT_WINDOW,
            additional_kwargs={"num_ctx": CONTEXT_WINDOW, "num_predict": 16},
        )
        try:
            healthcheck_llm.complete("test")  # ping ringan, timeout pendek
        except Exception as e:
            print(f"[PERINGATAN] Model '{model_name}' gagal dimuat/dipanggil: {e}")
            continue

        if model_name != LLM_MODEL:
            print(f"[PERINGATAN] '{LLM_MODEL}' gagal, memakai fallback '{model_name}'.")

        # Lolos healthcheck -> baru buat instance PAKAI request_timeout normal
        # (180s) untuk dipakai query sungguhan sepanjang sesi chatbot.
        return Ollama(
            model=model_name,
            base_url=OLLAMA_BASE_URL,
            request_timeout=180.0,
            system_prompt=SYSTEM_PROMPT,
            context_window=CONTEXT_WINDOW,
            additional_kwargs={"num_ctx": CONTEXT_WINDOW, "num_predict": 512},
        )
    raise SystemExit("[ERROR] Semua model LLM (utama & fallback) gagal. Cek Ollama.")


def use_raw_logit_scores(reranker) -> bool:
    """Paksa re-ranker mengeluarkan LOGIT MENTAH, bukan probabilitas sigmoid.

    Bukti dari log nyata: 5 dokumen berbeda semuanya berskor "0.00". Itu
    sifat sigmoid -- CrossEncoder.predict() dari sentence-transformers
    memakai nn.Sigmoid() otomatis untuk model 1-label seperti
    bge-reranker-v2-m3 (dicek di sumber sentence-transformers), jadi skor
    selalu 0..1, TIDAK PERNAH negatif, dan yang tak relevan menyusut ke
    ~0 sehingga tak bisa dibedakan. Padahal seluruh ambang di file ini
    (RERANK_SCORE_WARN_THRESHOLD, AMBIGUITY_MIN_RAW_SCORE, AMBIGUITY_MARGIN,
    RELEVANCE_DROP_MARGIN, LIST_PUBLICATIONS_RERANK_MIN_SCORE) dan
    score_to_percent() dirancang untuk skala logit (bisa negatif).

    Return True kalau aktivasi berhasil diganti ke Identity."""
    try:
        import torch
        model = getattr(reranker, "_model", None)
        if model is None:
            raise AttributeError("reranker._model tidak ditemukan")
        # sentence-transformers >=4: `activation_fn`; <4: `default_activation_function`
        for attr in ("activation_fn", "default_activation_function"):
            if hasattr(model, attr):
                setattr(model, attr, torch.nn.Identity())
                print(f"[INFO] Aktivasi re-ranker diganti ke Identity via '{attr}' "
                      f"-> skor = logit mentah (bisa negatif).")
                return True
        raise AttributeError("atribut aktivasi tidak ditemukan di model")
    except Exception as e:
        print(f"[PERINGATAN] Gagal memaksa skor re-ranker ke logit ({type(e).__name__}: {e}). "
              f"Skor kemungkinan masih 0..1 (sigmoid) -- semua ambang berbasis logit TIDAK valid.")
        return False


def build_index():
    print("Menghubungkan ke Ollama & Qdrant...")

    Settings.llm = get_llm_with_fallback()
    Settings.embed_model = OllamaEmbedding(
        model_name=EMBED_MODEL,
        base_url=OLLAMA_BASE_URL,
    )

    client = qdrant_client.QdrantClient(host=QDRANT_HOST, port=QDRANT_PORT)

    try:
        info = client.get_collection(COLLECTION_NAME)
        count = info.points_count
    except Exception as e:
        print(f"\n[ERROR] Tidak bisa mengakses collection '{COLLECTION_NAME}' di Qdrant.")
        print(f"Pastikan sudah dijalankan ingest.py terlebih dahulu. Detail error: {e}")
        raise SystemExit(1)

    if count == 0:
        print(f"\n[PERINGATAN] Collection '{COLLECTION_NAME}' ada tapi KOSONG (0 data).")
        print("Jalankan ingest.py dulu untuk mengisi data.")
        raise SystemExit(1)

    print(f"Collection '{COLLECTION_NAME}' ditemukan dengan {count} chunk data.\n")

    vector_store = QdrantVectorStore(client=client, collection_name=COLLECTION_NAME)
    index = VectorStoreIndex.from_vector_store(vector_store)

    # --- PERBAIKAN #3: re-ranker multilingual di GPU ---
    print(f"Memuat re-ranker {RERANK_MODEL} di {RERANK_DEVICE} "
          f"(unduhan pertama ~2,3 GB, sekali saja)...")
    try:
        reranker = SentenceTransformerRerank(
            model=RERANK_MODEL,
            top_n=TOP_K_FINAL,
            device=RERANK_DEVICE,
        )
    except Exception as e:
        print(f"[PERINGATAN] Gagal memuat re-ranker di '{RERANK_DEVICE}': {e}")
        print("Mencoba ulang di CPU (akan jauh lebih lambat)...")
        reranker = SentenceTransformerRerank(
            model=RERANK_MODEL,
            top_n=TOP_K_FINAL,
            device="cpu",
        )
    use_raw_logit_scores(reranker)
    print("Re-ranker siap.\n")

    return index, client, reranker


def _doc_key(metadata: dict) -> str:
    """Kunci identitas dokumen utk pengelompokan/log. Normalnya title. SOP yang
    title-nya KOSONG (ingest/sop.py: meta.get("judul", stem) mengembalikan ""
    kalau kunci 'judul' ada tapi kosong) TIDAK boleh digabung jadi satu
    'dokumen' bersama SOP kosong-judul lain -> pakai nama file sumber."""
    t = (metadata.get("title") or "").strip()
    if t:
        return t
    f = (metadata.get("source_file") or "").strip()
    return f"(TANPA JUDUL) {f}" if f else "(TANPA JUDUL)"


# Diisi HybridTitleBoostRetriever._retrieve, dibaca answer_question utk log
# rincian waktu. Aman krn server berjalan threaded=False (lihat app.py).
_LAST_RETRIEVAL_TIMING = {"embed": 0.0, "search": 0.0}


class RelativeScoreDocFilter(BaseNodePostprocessor):
    """Buang dokumen (per title, bukan per chunk) yang skor chunk terbaiknya
    tertinggal lebih dari `margin` dari skor terbaik keseluruhan.

    Per-DOKUMEN, bukan per-chunk, supaya SOP yang benar tetap utuh: chunk
    lanjutan langkah prosedur yang skornya rendah tapi dari SOP yang sama
    dengan chunk teratas TIDAK ikut terbuang. Urutan node dipertahankan, dan
    chunk teratas selalu lolos (hasil tidak pernah kosong). Node tanpa skor
    tidak pernah dibuang."""

    margin: float = RELEVANCE_DROP_MARGIN

    @classmethod
    def class_name(cls) -> str:
        return "RelativeScoreDocFilter"

    def _postprocess_nodes(self, nodes, query_bundle=None):
        scored = [n for n in nodes if n.score is not None]
        if len(nodes) < 2 or not scored:
            return nodes

        top = max(n.score for n in scored)
        cutoff = top - self.margin

        best_by_title = {}
        for n in scored:
            t = _doc_key(n.metadata)
            best_by_title[t] = max(best_by_title.get(t, n.score), n.score)

        kept, dropped_titles = [], set()
        for n in nodes:
            t = _doc_key(n.metadata)
            best = best_by_title.get(t)
            if best is None or best >= cutoff:
                kept.append(n)
            else:
                dropped_titles.add(t)

        summary = "; ".join(
            f"{'DIBUANG' if t in dropped_titles else 'lolos'} {b:.2f} {t[:45]}"
            for t, b in sorted(best_by_title.items(), key=lambda x: -x[1])
        )
        print(f"[FILTER-RELEVANSI] top={top:.2f} batas={cutoff:.2f} | {summary}")
        return kept


def get_query_engine_for_question(index, reranker, question: str, titles_index=None):
    """
    Bangun query engine dengan retriever hybrid. Filter judul (kalau terdeteksi)
    dipakai sebagai jalur tambahan, BUKAN sebagai pembatas tunggal.
    """
    qdrant_filter, keyword, _link = extract_keyword_filter(question, titles_index)

    if qdrant_filter is not None:
        print(f"[INFO] Judul terdeteksi: '{keyword}' -> dipakai sebagai BOOST "
              f"(pencarian global tetap berjalan).")
    else:
        print("[INFO] Tidak ada judul publikasi spesifik yang terdeteksi di "
              "pertanyaan -> pencarian global ke seluruh korpus.")

    retriever = HybridTitleBoostRetriever(
        index, qdrant_filter=qdrant_filter,
        sop_boost=is_procedural_request(question),
    )

    postprocessors = [reranker]
    # Pertanyaan tren/perbandingan/multi-topik SENGAJA butuh banyak dokumen
    # dgn skor beragam (retrieval dilebarkan, lihat needs_wide_retrieval) --
    # filter relatif di sini akan membuang dokumen yg memang dibutuhkan.
    if needs_wide_retrieval(question) is None:
        postprocessors.append(RelativeScoreDocFilter())

    return RetrieverQueryEngine.from_args(
        retriever=retriever,
        response_mode="compact",
        node_postprocessors=postprocessors,
    )


# ======================================================================
# Mode ringkasan dokumen penuh (tidak berubah secara fungsional)
# ======================================================================

def _extract_payload_text(payload: dict) -> str:
    for field in PAYLOAD_TEXT_FIELD_CANDIDATES:
        if field in payload and payload[field]:
            return str(payload[field])
    return ""


def fetch_full_document_chunks(client, qdrant_filter, limit=MAX_FULL_DOC_CHUNKS):
    """
    Ambil SEMUA (sampai batas `limit`) chunk milik dokumen yang cocok dengan
    qdrant_filter lewat scroll, diurutkan sesuai urutan asli dokumen kalau
    field urutannya tersedia.
    """
    points, _ = client.scroll(
        collection_name=COLLECTION_NAME,
        scroll_filter=qdrant_filter,
        limit=limit,
        with_payload=True,
    )

    if not points:
        return [], None

    if all(PAYLOAD_CHUNK_INDEX_FIELD in p.payload for p in points):
        points.sort(key=lambda p: p.payload.get(PAYLOAD_CHUNK_INDEX_FIELD, 0))

    title = points[0].payload.get("title", "").strip()
    link = points[0].payload.get("link_publikasi", "").strip()

    texts = [t for t in (_extract_payload_text(p.payload) for p in points) if t]

    return texts, {"title": title, "link_publikasi": link, "n_chunks": len(points)}


def _chunk_list(items, batch_size):
    for i in range(0, len(items), batch_size):
        yield items[i:i + batch_size]


def summarize_full_document(question: str, qdrant_filter):
    """
    Jalur khusus permintaan ringkasan, memakai strategi MAP-REDUCE:
      MAP    : pecah chunk dokumen jadi batch kecil, ringkas tiap batch.
      REDUCE : gabungkan semua ringkasan batch jadi satu ringkasan akhir.
    """
    texts, doc_meta = fetch_full_document_chunks(Settings._qdrant_client, qdrant_filter)

    if not texts:
        return None, None

    batches = list(_chunk_list(texts, SUMMARY_BATCH_SIZE))
    n_batches = len(batches)

    if n_batches == 1:
        full_text = "\n\n".join(batches[0])
        prompt = (
            f"{SUMMARY_SYSTEM_PROMPT}\n\n"
            f"Berikut isi publikasi \"{doc_meta['title']}\" "
            f"({doc_meta['n_chunks']} bagian teks, disusun berurutan):\n\n"
            f"{full_text}\n\n"
            f"Pertanyaan pengguna: {question}\n\n"
            f"Buat ringkasan sesuai instruksi di atas."
        )
        return Settings.llm.complete(prompt).text, doc_meta

    print(
        f"[INFO] Dokumen berisi {doc_meta['n_chunks']} bagian teks -> "
        f"diproses dalam {n_batches} batch (map-reduce). Ini bisa memakan waktu."
    )
    batch_summaries = []
    for idx, batch in enumerate(batches, start=1):
        print(f"  Meringkas batch {idx}/{n_batches}...")
        batch_text = "\n\n".join(batch)
        map_prompt = (
            f"Kamu meringkas SEBAGIAN dari publikasi resmi BPS berjudul "
            f"\"{doc_meta['title']}\" (bagian {idx} dari {n_batches}).\n"
            "Tulis poin-poin penting (topik, angka, temuan) yang ADA secara "
            "eksplisit di teks berikut, dalam Bahasa Indonesia baku, "
            "singkat dan padat. Jangan menambah informasi dari luar teks.\n\n"
            f"Teks:\n{batch_text}\n\nPoin-poin penting:"
        )
        try:
            batch_summaries.append(Settings.llm.complete(map_prompt).text.strip())
        except Exception as e:
            print(f"  [PERINGATAN] Batch {idx} gagal diringkas: {e}")

    if not batch_summaries:
        return None, doc_meta

    print("  Menggabungkan seluruh ringkasan batch menjadi ringkasan akhir...")
    combined = "\n\n---\n\n".join(
        f"[Bagian {i+1}]\n{s}" for i, s in enumerate(batch_summaries)
    )
    reduce_prompt = (
        f"{SUMMARY_SYSTEM_PROMPT}\n\n"
        f"Berikut kumpulan ringkasan per-bagian dari publikasi "
        f"\"{doc_meta['title']}\" ({n_batches} bagian):\n\n"
        f"{combined}\n\n"
        f"Pertanyaan pengguna: {question}\n\n"
        "Gabungkan semua poin di atas menjadi SATU ringkasan akhir yang koheren, "
        "hilangkan duplikasi antar-bagian, susun sesuai instruksi di atas."
    )
    return Settings.llm.complete(reduce_prompt).text, doc_meta


# ======================================================================
# PERBAIKAN #6 — tampilan skor yang jujur
# ======================================================================

_CITED_PAGE_RE = re.compile(r"\bhal(?:\.|aman)?\s*([0-9][0-9,\-–\s]*)", re.IGNORECASE)


def extract_cited_pages(answer_text: str):
    """
    Tarik semua nomor halaman yang benar-benar disebut LLM di teks jawaban
    (pola "hal. X", "halaman X", termasuk daftar "hal. 12, 14" dan rentang
    "hal. 12-14"). Dipakai supaya UI bisa meng-highlight, di daftar
    "Sumber publikasi", halaman mana saja yang benar-benar dikutip di jawaban
    -- bukan sekadar seluruh halaman tempat chunk diambil.
    """
    if not answer_text:
        return set()

    cited = set()
    for m in _CITED_PAGE_RE.finditer(answer_text):
        segment = m.group(1)
        for part in segment.split(","):
            part = part.strip()
            if not part:
                continue
            range_m = re.match(r"^(\d+)\s*[-–]\s*(\d+)$", part)
            if range_m:
                a, b = int(range_m.group(1)), int(range_m.group(2))
                if 0 <= b - a < 50:  # jaga-jaga salah tangkap rentang liar
                    for p in range(a, b + 1):
                        cited.add(str(p))
                continue
            num_m = re.match(r"^(\d+)", part)
            if num_m:
                cited.add(num_m.group(1))
    return cited


def score_to_percent(raw_score):
    """
    bge-reranker-v2-m3 dilatih dengan binary cross-entropy, jadi sigmoid atas
    logit-nya JAUH lebih bermakna dibanding pada ms-marco-MiniLM (yang dipakai
    versi lama). Meski begitu angka ini tetap bukan probabilitas terkalibrasi,
    jadi selalu tampilkan berdampingan dengan skor mentahnya.
    """
    if raw_score is None:
        return None
    try:
        return round((1 / (1 + math.exp(-raw_score))) * 100, 1)
    except OverflowError:
        return 0.0 if raw_score < 0 else 100.0


def format_sources(source_nodes):
    """
    Daftar unik (title, link, skor_mentah, halaman, gambar) dari chunk yang
    dipakai menjawab, memakai skor TERTINGGI per publikasi, diurutkan menurun.
    `halaman` adalah daftar nomor halaman (sorted, unik) tempat chunk-chunk
    dari publikasi itu diambil -- diisi dari metadata `page_label` yang
    disematkan per-halaman saat ingest (lihat build_nodes_from_extraction
    di ingest.py). Kalau field itu tidak ada (data lama sebelum field ini
    ditambahkan), daftar halamannya kosong.

    `gambar` (`images`): list of {"page": page_label, "url": image_url},
    HANYA berisi halaman yang punya metadata `image_url` (lihat
    ingest/sop.py: save_sop_page_image/_sop_fallback_to_image -- disuntik
    saat visual/tabel di halaman itu gagal direkonstruksi jadi teks secara
    andal, jadi frontend perlu tampilkan gambar asli halamannya). Kosong
    untuk publikasi/dokumen yang tidak punya field ini sama sekali.
    """
    best_per_key = {}   # (title, link) -> skor tertinggi
    pages_per_key = {}  # (title, link) -> set nomor halaman
    images_per_key = {}  # (title, link) -> dict {page_label: (image_url, text_reliable)}

    for node in source_nodes:
        title = node.metadata.get("title", "").strip()
        link = node.metadata.get("link_publikasi", "").strip()
        if not title:
            continue
        key = (title, link)
        # dipaksa ke float Python biasa -- node.score dari SentenceTransformerRerank
        # bertipe numpy.float32/torch scalar, yang TIDAK bisa di-JSON-kan langsung
        # oleh json.dumps (dipakai app.py lewat jsonify). CLI tidak kena masalah
        # ini karena print() otomatis meng-konversinya ke string, tapi web API perlu
        # tipe primitif Python murni.
        raw_score = getattr(node, "score", None)
        score = float(raw_score) if raw_score is not None else None
        prev = best_per_key.get(key)
        if prev is None or (score is not None and (prev is None or score > prev)):
            best_per_key[key] = score

        page_label = str(node.metadata.get("page_label", "")).strip()
        if page_label:
            pages_per_key.setdefault(key, set()).add(page_label)

        image_url = str(node.metadata.get("image_url", "")).strip()
        if image_url and page_label:
            # text_reliable: False HANYA kalau metadata secara eksplisit bilang
            # begitu (ingest/sop.py menyuntik ini utk halaman yg teks tabelnya
            # gagal direkonstruksi andal). Default True -- data lama sebelum
            # field ini ada TIDAK tiba-tiba dianggap "gambar-saja".
            text_reliable = node.metadata.get("text_reliable", True) is not False
            images_per_key.setdefault(key, {})[page_label] = (image_url, text_reliable)

    def _page_sort_key(p):
        # nomor halaman biasanya numerik ("12"), tapi jaga-jaga kalau ada
        # label non-numerik (mis. "iv", "cover") supaya tidak error saat sort
        return (0, int(p)) if p.isdigit() else (1, p)

    sources = []
    for (t, l), s in best_per_key.items():
        pages = sorted(pages_per_key.get((t, l), set()), key=_page_sort_key)
        images = [
            {
                "page": p,
                "url": images_per_key.get((t, l), {})[p][0],
                "text_reliable": images_per_key.get((t, l), {})[p][1],
            }
            for p in sorted(images_per_key.get((t, l), {}).keys(), key=_page_sort_key)
        ]
        sources.append((t, l, s, pages, images))

    sources.sort(key=lambda x: (x[2] if x[2] is not None else -1e9), reverse=True)
    return sources


def _top_chunk_is_image_only(response_source_nodes) -> bool:
    """
    True kalau chunk PERINGKAT #1 hasil rerank (chunk yang paling menentukan
    isi jawaban LLM) berasal dari halaman yang text_reliable=False --
    artinya teks tabel/kontennya gagal direkonstruksi andal saat ingest
    (lihat ingest/sop.py). Kalau ini True, JANGAN percaya teks jawaban LLM
    apa adanya -- kemungkinan besar itu hasil karangan dari sisa teks yang
    sudah disuppress, bukan rangkuman konten asli. Dicek dari chunk
    SUMBERNYA langsung (metadata), bukan ditebak dari panjang/isi jawaban
    LLM -- lebih akurat drpd heuristik "jawaban pendek = trivial".
    """
    if not response_source_nodes:
        return False
    top = response_source_nodes[0]
    return top.metadata.get("text_reliable", True) is False


_IMAGE_HASH_CACHE = {}


def _image_content_hash(url: str) -> str:
    """MD5 isi file gambar SOP (dari URL /static/sop_images/...). Dipakai frontend
    untuk membuang gambar yang ISINYA sama persis: beberapa SOP satu keluarga
    (mis. sub-SOP Analisis Isu Terkini) punya halaman diagram identik tapi
    file PNG-nya berbeda nama, jadi dedupe berdasar URL tidak menangkapnya.
    "" kalau file tidak terbaca (frontend lalu jatuh ke URL). Di-cache karena
    file PNG tidak berubah selama server hidup."""
    if url in _IMAGE_HASH_CACHE:
        return _IMAGE_HASH_CACHE[url]
    h = ""
    if url.startswith(SOP_IMAGE_URL_PREFIX + "/"):
        path = os.path.join(SOP_IMAGE_DIR, unquote(url[len(SOP_IMAGE_URL_PREFIX) + 1:]))
        try:
            with open(path, "rb") as f:
                h = hashlib.md5(f.read()).hexdigest()
        except OSError:
            h = ""
    _IMAGE_HASH_CACHE[url] = h
    return h


def find_sop_page_images(source_file: str, image_dir: str = None) -> list:
    """Cari gambar halaman SOP di disk berdasar nama file sumber.

    Kenapa perlu: gambar halaman tabel disimpan ingest/sop.py dgn nama
    DETERMINISTIK "<nama-pdf-tanpa-ekstensi>_p<halaman>.png" dan hanya
    ditempel ke metadata chunk HALAMAN ITU. Kalau yang ter-retrieve cuma
    chunk halaman lain (mis. hal. 1 = header/metadata), SOP-nya tampil tanpa
    gambar padahal gambar tabelnya ada. Fungsi ini menemukannya lewat nama file.

    Sengaja os.listdir + cocokkan nama (BUKAN glob): nama SOP sering memuat
    '[', ']', '(' yang bermakna khusus di pola glob.
    Return list {page, url, text_reliable} urut halaman; [] kalau tidak ada.
    text_reliable=True: gambar di sini pelengkap, bukan pengganti teks."""
    image_dir = image_dir or SOP_IMAGE_DIR
    source_file = (source_file or "").strip()
    if not source_file:
        return []
    stem = os.path.splitext(source_file)[0]
    pat = re.compile(r"^" + re.escape(stem) + r"_p(\d+)\.png$")
    try:
        names = os.listdir(image_dir)
    except OSError:
        return []
    found = []
    for name in names:
        m = pat.match(name)
        if m:
            found.append((int(m.group(1)), name))
    found.sort()
    return [
        {"page": str(p), "url": f"{SOP_IMAGE_URL_PREFIX}/{quote(name)}", "text_reliable": True}
        for p, name in found
    ]


def _titles_are_all_sop(nodes, titles) -> bool:
    """True kalau SETIAP judul di `titles` punya chunk di `nodes` dan semua chunk
    berjudul itu bermetadata jenis_dokumen == "sop". Metadata hilang -> False
    (konservatif: perilaku lama tetap dipakai)."""
    for t in titles:
        docs = [n for n in nodes if n.metadata.get("title", "").strip() == t.strip()]
        if not docs or any(n.metadata.get("jenis_dokumen") != SOP_DOC_TYPE for n in docs):
            return False
    return True


def _strip_year(title: str) -> str:
    return re.sub(r"\b(?:19|20)\d{2}\b", "", title).strip()


def find_all_editions_by_base_title(reference_title: str, titles_index):
    """
    Cari semua judul di titles_index yang merupakan EDISI TAHUN berbeda dari
    reference_title (judul sama persis setelah tahunnya dibuang). Dipakai
    untuk menyusun daftar pilihan saat menanyakan klarifikasi tahun ke user.
    Diurutkan tahun terbaru dulu.
    """
    base_norm = _normalize(_strip_year(reference_title))
    if not base_norm:
        return []

    results = []
    for entry in titles_index:
        t = entry["title"]
        if _normalize(_strip_year(t)) == base_norm:
            year_m = re.search(r"\b(?:19|20)\d{2}\b", t)
            results.append({
                "title": t,
                "link": entry.get("link_publikasi"),
                "year": year_m.group(0) if year_m else None,
            })
    results.sort(key=lambda r: r["year"] or "", reverse=True)
    return results


def detect_ambiguous_top_titles(sources):
    """
    Cek apakah publikasi #1 dan #2 di `sources` (output format_sources, sudah
    terurut menurun) cukup berdekatan skornya untuk dianggap sama-sama
    kandidat yang valid.

    Return: (title1, title2) kalau ambigu, atau None kalau tidak.
    Sengaja TIDAK menganggap ambigu kalau skor teratas sudah di bawah
    AMBIGUITY_MIN_RAW_SCORE -- itu kasus "tidak ada yang relevan sama sekali",
    beda penanganan (lihat print_sources), bukan "dua kandidat sama kuat".
    """
    if len(sources) < 2:
        return None
    (t1, _l1, s1, _p1, _i1), (t2, _l2, s2, _p2, _i2) = sources[0], sources[1]
    if s1 is None or s2 is None:
        return None
    if t1 == t2:
        return None
    if s1 < AMBIGUITY_MIN_RAW_SCORE:
        return None
    if (s1 - s2) < AMBIGUITY_MARGIN:
        return (t1, t2)
    return None


def _page_sort_key(p: str):
    return (0, int(p)) if p.isdigit() else (1, p)


def _title_year_disqualified(title: str, target_year: str) -> bool:
    """
    True kalau judul publikasi memuat tahun EKSPLISIT yang BUKAN target_year
    (mis. judul "... 2020" saat user menanyakan tahun 2017). Judul yang sama
    sekali tidak memuat tahun tidak didiskualifikasi oleh fungsi ini (tetap
    lolos, karena tidak ada bukti publikasi itu salah tahun).
    """
    tt = re.search(r"\b(?:19|20)\d{2}\b", title)
    return bool(tt) and tt.group(0) != target_year


def list_related_publications(question: str, index, reranker, titles_index=None):
    """
    Jalur khusus untuk pertanyaan "berikan semua link publikasi yang
    berhubungan dengan X". BEDA tujuan dengan jalur QA biasa:

      - QA biasa   : retrieval luas -> re-rank -> ambil TOP_K_FINAL=8 chunk
                     TERBAIK -> LLM merangkai SATU jawaban paling tepat dari
                     situ.
      - Jalur ini  : retrieval SANGAT luas (banyak kandidat chunk, lihat
                     LIST_PUBLICATIONS_TOP_K), SEMUA kandidat itu diskor ulang
                     oleh re-ranker (bukan skor embedding mentah -- lihat
                     catatan di LIST_PUBLICATIONS_RERANK_MIN_SCORE di atas
                     kenapa embedding mentah tidak cukup tajam), lalu
                     dikelompokkan per JUDUL DOKUMEN UNIK. Publikasi lolos ke
                     hasil akhir hanya kalau DUA syarat sekaligus terpenuhi:
                     (1) skor re-rank tertinggi >= LIST_PUBLICATIONS_RERANK_MIN_SCORE,
                     DAN (2) minimal satu kata kunci topik dari pertanyaan
                     benar-benar tertulis literal di salah satu chunk-nya
                     (extract_topic_keywords). Syarat #2 ini yang mencegah
                     publikasi yang topiknya cuma "berdekatan" secara
                     semantik (mis. kemiskinan vs pengangguran) ikut nyangkut
                     hanya karena re-ranker menilainya "cukup mirip".
                     GERBANG TAMBAHAN #3: kalau pertanyaan menyebut TEPAT
                     SATU tahun (mis. "...tahun 2017"), publikasi yang
                     judulnya memuat tahun LAIN (mis. edisi "...2020")
                     didiskualifikasi -- judul yang tidak memuat tahun sama
                     sekali tetap lolos (lihat _title_year_disqualified).
                     Pertanyaan yang menyebut LEBIH dari satu tahun (mis.
                     permintaan tren/perbandingan) TIDAK difilter tahun sama
                     sekali, supaya publikasi dari berbagai edisi tahun tetap
                     ikut terdaftar.

    Return: list of {title, link, score, percent, pages} terurut skor
    menurun, dibatasi LIST_PUBLICATIONS_MAX_TITLES entri.
    """
    retriever = index.as_retriever(similarity_top_k=LIST_PUBLICATIONS_TOP_K)
    nodes = retriever.retrieve(question)
    if not nodes:
        return []

    # Skor ulang SEMUA kandidat pakai re-ranker yang sama dengan jalur QA,
    # bukan cuma top_n bawaannya (top_n konstruksi reranker = TOP_K_FINAL=8,
    # terlalu sedikit untuk kebutuhan "daftar semua publikasi"). top_n
    # dinaikkan sementara lalu dikembalikan supaya jalur QA lain yang
    # memakai instance reranker yang sama tidak ikut berubah.
    query_bundle = QueryBundle(query_str=question)
    original_top_n = reranker.top_n
    try:
        reranker.top_n = len(nodes)
        reranked_nodes = reranker.postprocess_nodes(nodes, query_bundle=query_bundle)
    finally:
        reranker.top_n = original_top_n

    best_per_title = {}  # title -> {"link", "score", "pages": set(), "keyword_hit": bool}

    topic_keywords = extract_topic_keywords(question)

    # Gerbang tahun: hanya aktif kalau pertanyaan menyebut TEPAT SATU tahun.
    # Kalau menyebut 0 atau >1 tahun (mis. "bandingkan 2017 dan 2019"),
    # jangan filter tahun sama sekali -- lebih aman menampilkan lebih banyak
    # daripada salah membuang publikasi yang justru dibutuhkan user.
    years_in_question = set(re.findall(r"\b(?:19|20)\d{2}\b", question))
    target_year = next(iter(years_in_question)) if len(years_in_question) == 1 else None

    for n in reranked_nodes:
        title = n.metadata.get("title", "").strip()
        if not title:
            continue
        if target_year and _title_year_disqualified(title, target_year):
            continue
        link = n.metadata.get("link_publikasi", "").strip()
        score = float(n.score) if getattr(n, "score", None) is not None else -1e9
        page = str(n.metadata.get("page_label", "")).strip()
        chunk_text_lower = n.node.get_content().lower()

        entry = best_per_title.setdefault(
            title, {"link": link, "score": score, "pages": set(), "keyword_hit": not topic_keywords}
        )
        if score > entry["score"]:
            entry["score"] = score
        if link and not entry["link"]:
            entry["link"] = link
        if page:
            entry["pages"].add(page)
        if topic_keywords and any(kw in chunk_text_lower for kw in topic_keywords):
            entry["keyword_hit"] = True

    # Dua gerbang HARUS lolos bersamaan (gerbang tahun sudah diterapkan di
    # atas, sebelum grouping, jadi publikasi tahun salah tidak pernah masuk
    # best_per_title sama sekali):
    #  1. Skor re-rank tertinggi publikasi itu >= ambang (relevansi semantik).
    #  2. Minimal satu kata kunci topik dari pertanyaan BENAR-BENAR tertulis
    #     di salah satu chunk publikasi itu (relevansi literal). Ini yang
    #     menyaring kasus seperti "Potret Kemiskinan" ikut nyangkut untuk
    #     pertanyaan "pengangguran" -- topiknya berdekatan secara semantik
    #     tapi kata "pengangguran" sendiri tidak pernah disebut di dokumennya.
    #     Kalau topic_keywords kosong (mis. pertanyaan cuma kata umum yang
    #     semuanya stopword), gerbang #2 otomatis dianggap lolos.
    items = [
        (title, e["link"], e["score"], e["pages"])
        for title, e in best_per_title.items()
        if e["score"] >= LIST_PUBLICATIONS_RERANK_MIN_SCORE and e["keyword_hit"]
    ]
    items.sort(key=lambda x: x[2], reverse=True)
    items = items[:LIST_PUBLICATIONS_MAX_TITLES]

    results = []
    for title, link, score, pages in items:
        results.append({
            "title": title,
            "link": link or None,
            "score": round(score, 3),
            "percent": score_to_percent(score),
            "pages": sorted(pages, key=_page_sort_key),
        })
    return results


def format_publications_list_answer(pubs: list) -> str:
    """Susun teks jawaban berupa daftar bernomor dari list_related_publications()."""
    if not pubs:
        return (
            "Tidak ditemukan publikasi yang secara jelas berhubungan dengan "
            "topik pertanyaan Anda di korpus yang tersedia. Coba gunakan kata "
            "kunci topik yang berbeda, atau periksa apakah publikasinya sudah "
            "ter-index."
        )

    lines = ["Berikut publikasi yang berhubungan dengan topik yang Anda tanyakan:", ""]
    for i, p in enumerate(pubs, start=1):
        page_str = f" (hal. {', '.join(p['pages'])})" if p["pages"] else ""
        if p["link"]:
            lines.append(f"{i}. {p['title']}{page_str} — {p['link']}")
        else:
            lines.append(f"{i}. {p['title']}{page_str} (link tidak tersedia)")
    return "\n".join(lines)


_NOT_FOUND_MARKERS = (
    "tidak ditemukan", "tidak disediakan", "tidak tersedia",
    "tidak dapat disajikan", "tidak dibahas", "tidak ada informasi",
    "tidak ada data", "tidak memuat",
)


def _answer_says_not_found(answer_text: str) -> bool:
    """
    Deteksi kasar apakah jawaban (termasuk jawaban gabungan multi-sumber)
    pada dasarnya menyatakan informasinya TIDAK ADA di publikasi yang
    tersedia -- misalnya karena sumber-sumber yang berdekatan skornya
    ternyata sama-sama membahas objek/cakupan yang berbeda dari yang
    ditanyakan (lihat ATURAN #11 di SYSTEM_PROMPT).

    Kalau ini True, badge/catatan "jawaban memadukan beberapa sumber"
    TIDAK relevan lagi ditampilkan -- LLM tidak sedang memadukan dua angka
    yang berbeda, melainkan menyimpulkan tidak ada jawaban sama sekali.
    """
    if not answer_text:
        return False
    lower = answer_text.lower()
    return any(marker in lower for marker in _NOT_FOUND_MARKERS)


def answer_combined_from_multiple_documents(question: str, titles, source_nodes):
    """
    Susun SATU jawaban yang memadukan chunk dari beberapa publikasi teratas
    (yang skornya berdekatan / sama-sama kandidat kuat), dengan setiap
    potongan konteks diberi label tegas publikasi & halaman asalnya.

    Bedanya dengan sekadar menggabung context begitu saja ke satu prompt:
    LLM diinstruksikan secara eksplisit untuk TIDAK diam-diam memilih salah
    satu sumber kalau angkanya berbeda antar publikasi (kasus nyata: TPT
    Kalteng 2023 versi "... Dalam Infografis 2023" = 4,10%, sedangkan versi
    "Potret Tujuan Pembangunan Berkelanjutan ... 2023" = 3,78% -- keduanya
    valid, kemungkinan beda definisi/cakupan/periode rilis, sehingga harus
    ditampilkan berdampingan, bukan salah satunya dibuang).
    """
    blocks = []
    for title in titles:
        own_nodes = [n for n in source_nodes if n.metadata.get("title", "").strip() == title]
        if not own_nodes:
            continue
        own_nodes.sort(key=lambda n: getattr(n, "score", None) or -1e9, reverse=True)
        chunk_text = "\n\n".join(
            f"[Halaman {n.metadata.get('page_label', '?')}]\n{n.node.get_content().strip()}"
            for n in own_nodes[:TOP_K_FINAL]
        )
        blocks.append(f"=== SUMBER: \"{title}\" ===\n{chunk_text}")

    if not blocks:
        return None

    combined_context = "\n\n".join(blocks)

    prompt = (
        f"{SYSTEM_PROMPT}\n\n"
        "Konteks di bawah berasal dari BEBERAPA publikasi berbeda yang skor "
        "relevansinya berdekatan, dipisahkan dengan penanda \"=== SUMBER: ... ===\". "
        "Tiap potongan juga diberi penanda halaman.\n\n"
        f"{combined_context}\n\n"
        f"Pertanyaan pengguna: {question}\n\n"
        "ATURAN KHUSUS untuk kasus banyak sumber ini:\n"
        "- Kalau semua sumber sepakat pada satu angka/informasi yang sama, "
        "cukup jawab sekali dan boleh sebutkan didukung oleh publikasi mana saja.\n"
        "- Kalau angka/informasi ANTAR SUMBER BERBEDA (meski topiknya sama-sama "
        "relevan dengan pertanyaan), JANGAN diam-diam memilih salah satu. "
        "Sebutkan KEDUA (atau semua) angka tersebut secara eksplisit, masing-masing "
        "dengan nama publikasi dan nomor halamannya, dan -- kalau memungkinkan dari "
        "konteks yang ada -- jelaskan kemungkinan sebab perbedaannya (misalnya beda "
        "definisi indikator, beda periode rilis/data, atau beda cakupan wilayah). "
        "Kalau konteksnya tidak menjelaskan sebabnya, cukup nyatakan bahwa terdapat "
        "perbedaan angka antar sumber tanpa mengarang alasannya.\n"
        "- Kalau salah satu sumber sama sekali tidak membahas topik yang ditanyakan, "
        "abaikan sumber itu saja dari jawaban, jangan dipaksakan.\n"
        "- SEBELUM menyusun jawaban gabungan, cek dulu tiap sumber sesuai ATURAN #11 "
        "di atas (cakupan/lingkup objek): sumber yang hanya membahas objek/wilayah/unit "
        "yang LEBIH SEMPIT, LEBIH LUAS, atau sekadar SATU TOPIK YANG TERKAIT (mis. data "
        "satu destinasi wisata saat yang ditanya angka tingkat provinsi) BUKAN dianggap "
        "sebagai jawaban yang valid untuk pertanyaan ini, sekalipun kedua sumber sama-sama "
        "lolos re-ranking dengan skor tinggi. Kalau SEMUA sumber yang tersedia ternyata "
        "termasuk kategori ini (tidak ada satu pun yang benar-benar membahas objek/cakupan "
        "persis yang ditanyakan), JANGAN menyusun jawaban gabungan dengan disclaimer di "
        "akhir. Sebagai gantinya, nyatakan dengan TEGAS bahwa informasi untuk objek/cakupan "
        "yang ditanyakan tidak ditemukan dalam publikasi yang tersedia, dan hanya boleh "
        "menyebutkan data terdekat yang ada sebagai catatan tambahan yang jelas dinyatakan "
        "BUKAN jawaban atas pertanyaan tersebut.\n"
        "- KASUS KHUSUS PERTANYAAN TREN/DERET WAKTU (rujuk ATURAN #12 di atas): kalau "
        "pertanyaan menanyakan tren/perkembangan suatu indikator sepanjang rentang tahun, "
        "dan sumber-sumber di atas masing-masing menyumbang angka untuk TAHUN YANG BERBEDA "
        "(bukan angka yang bertentangan untuk tahun yang sama), ini BUKAN kasus konflik -- "
        "GABUNGKAN titik data dari semua sumber menjadi satu deret angka per tahun (urutkan "
        "berdasarkan tahun), sebutkan publikasi & halaman tiap titik, lalu simpulkan arah "
        "trennya. Jangan menyatakan 'tidak ditemukan' hanya karena datanya tersebar di lebih "
        "dari satu publikasi/halaman -- itu justru tujuan mode gabungan-sumber ini."
    )
    return Settings.llm.complete(prompt).text.strip()


def print_sources(sources):
    if not sources:
        print("\n(Tidak ada metadata sumber yang tercatat untuk jawaban ini)")
        return

    print("\nSumber publikasi terkait (skor mentah re-ranker; makin tinggi makin relevan):")
    for title, link, raw, pages in sources:
        if raw is None:
            label = "skor N/A"
        else:
            label = f"skor {raw:+.2f} (~{score_to_percent(raw)}%)"

        if pages:
            if len(pages) == 1:
                page_str = f"hal. {pages[0]}"
            else:
                page_str = "hal. " + ", ".join(pages)
        else:
            page_str = "halaman tidak tercatat"

        if link:
            print(f"  - [{label}] {title} ({page_str})\n    {link}")
        else:
            print(f"  - [{label}] {title} ({page_str}) (link tidak tersedia)")

    top_raw = sources[0][2]
    if top_raw is not None and top_raw < RERANK_SCORE_WARN_THRESHOLD:
        print(
            "\n[PERINGATAN] Skor tertinggi bernilai negatif — re-ranker menilai "
            "TIDAK ADA chunk yang benar-benar menjawab pertanyaan ini. Besar "
            "kemungkinan informasi yang dicari memang tidak ada di korpus, atau "
            "tertulis dengan istilah yang berbeda. Jangan pakai jawaban di atas "
            "tanpa verifikasi ke dokumen aslinya."
        )
    elif detect_ambiguous_top_titles(sources):
        print(
            "\n[CATATAN] Dua publikasi teratas skornya berdekatan -> jawaban di "
            "atas dipecah dan dibuat terpisah untuk masing-masing publikasi "
            "(lihat di atas), bukan dibaurkan jadi satu jawaban. Kalau salah "
            "satu tetap tidak sesuai, sebutkan judul publikasi/bulan/tahun "
            "secara eksplisit di pertanyaan berikutnya."
        )


def answer_question(question: str, index, reranker, titles_index):
    """
    Jalankan satu pertanyaan lewat seluruh pipeline (deteksi mode ringkasan,
    filter judul, retrieval hybrid, re-rank, penanganan sumber ambigu) dan
    kembalikan hasilnya sebagai dict terstruktur -- TANPA mencetak apa pun.

    Dipakai bersama oleh main() (CLI) dan app.py (backend web), supaya kedua
    antarmuka selalu memakai logika yang persis sama, tidak ada duplikasi
    aturan yang bisa mulai berbeda seiring waktu.

    Return dict dengan kunci:
      mode            : "summary" | "qa" | "summary_not_found" | "list_publications" | "needs_clarification"
      answer          : str | None
      sources         : list of {title, link, raw_score, percent, pages, cited_pages}
      combined        : bool  -- True kalau jawaban memadukan >1 publikasi
      combined_titles : list[str] -- judul-judul yang dipadukan (kalau combined)
      warning         : str | None -- pesan peringatan (skor rendah dkk.)
      note            : str | None -- catatan non-kritis (skor berdekatan dkk.)
      breadth_hint    : "trend" | "comparison" | "multi_topic" | None -- alasan
                        retrieval dilebarkan (lihat needs_wide_retrieval), buat
                        transparansi UI, bukan penentu logika lebih lanjut.
      debug_chunks    : list of {rank, score, page, title, snippet}
      doc_meta        : dict | None -- metadata dokumen (khusus mode ringkasan)
      image_only      : bool -- True kalau chunk sumber utama gambar-saja
                        (text_reliable=False) -> `answer` sudah ditimpa
                        pesan jujur (bukan hasil sintesis LLM dari teks yg
                        tak andal), dan `featured_image` HARUS ditampilkan
                        sebagai rujukan utama, bukan cuma pelengkap.
      featured_image  : dict {url, page, title} | None -- gambar halaman
                        paling relevan untuk ditampilkan besar langsung di
                        bubble jawaban (lihat catatan di atas).
      error           : str | None
    """
    result = {
        "mode": "qa",
        "answer": None,
        "sources": [],
        "combined": False,
        "combined_titles": [],
        "warning": None,
        "note": None,
        "breadth_hint": None,
        "debug_chunks": [],
        "doc_meta": None,
        "image_only": False,
        "featured_image": None,
        "error": None,
    }

    if is_list_publications_request(question):
        result["mode"] = "list_publications"
        try:
            pubs = list_related_publications(question, index, reranker, titles_index)
        except Exception as e:
            result["error"] = f"Gagal mencari daftar publikasi: {e}"
            return result

        result["answer"] = format_publications_list_answer(pubs)
        result["sources"] = [
            {
                "title": p["title"],
                "link": p["link"],
                "raw_score": p["score"],
                "percent": p["percent"],
                "pages": p["pages"],
                # semua halaman di sini memang dasar publikasi ini masuk daftar
                # -> semuanya relevan, tandai semua untuk di-highlight di UI.
                "cited_pages": p["pages"],
            }
            for p in pubs
        ]
        if not pubs:
            result["warning"] = (
                "Tidak ditemukan publikasi yang jelas berhubungan dengan topik "
                "ini di korpus yang tersedia. Coba gunakan kata kunci yang berbeda."
            )
        return result

    qdrant_filter, keyword, _matched_link = extract_keyword_filter(question, titles_index)
    summary_mode = is_summary_request(question) and qdrant_filter is not None

    if summary_mode:
        result["mode"] = "summary"
        try:
            answer, doc_meta = summarize_full_document(question, qdrant_filter)
        except Exception as e:
            result["error"] = f"Gagal membuat ringkasan: {e}"
            return result

        if answer is None:
            result["mode"] = "summary_not_found"
            result["warning"] = (
                f"Tidak ditemukan chunk dokumen yang cocok dengan judul '{keyword}' "
                "untuk diringkas. Coba sebutkan judul publikasi lebih lengkap/persis."
            )
            return result

        result["answer"] = answer.strip()
        result["doc_meta"] = doc_meta
        return result

    if is_summary_request(question) and qdrant_filter is None:
        result["note"] = (
            "Permintaan ringkasan terdeteksi, tapi judul publikasinya tidak "
            "dikenali. Sebutkan judul publikasi secara lebih lengkap kalau "
            "ingin ringkasan dokumen penuh. Untuk sekarang, dijawab lewat "
            "pencarian biasa."
        )

    result["breadth_hint"] = needs_wide_retrieval(question)

    # ALUR SATU-KALI-SINTESIS: retrieve (+re-rank +filter) dulu, putuskan
    # jalur (ambigu / gambar-saja / normal) dari chunk-nya, dan HANYA jalur
    # normal yang memanggil LLM sintesis. Sebelumnya pipeline selalu
    # menyintesis jawaban LLM dulu, lalu jawabannya DIBUANG kalau ternyata
    # ambigu (LLM ke-2 dipanggil utk jawaban gabungan) atau ditimpa kalau
    # chunk #1 gambar-saja -- panggilan LLM yang terbuang percuma.
    t_start = time.perf_counter()
    try:
        query_engine = get_query_engine_for_question(index, reranker, question, titles_index)
        query_bundle = QueryBundle(question)
        if result["breadth_hint"] is not None:
            # Widen sementara -- lihat catatan panjang di needs_wide_retrieval().
            # Dikembalikan lagi di finally supaya pertanyaan berikutnya (QA biasa)
            # tidak ikut kebawa lebar. (Re-ranker hanya jalan di retrieve(),
            # jadi widen cukup membungkus retrieve, tidak perlu sintesis.)
            original_top_n = reranker.top_n
            try:
                reranker.top_n = max(reranker.top_n, WIDE_RETRIEVAL_TOP_N)
                nodes = query_engine.retrieve(query_bundle)
            finally:
                reranker.top_n = original_top_n
        else:
            nodes = query_engine.retrieve(query_bundle)
    except Exception as e:
        result["error"] = f"Gagal memproses pertanyaan: {e}"
        return result
    t_retrieved = time.perf_counter()

    for i, node in enumerate(nodes, start=1):
        raw_score = getattr(node, "score", None)
        score = float(raw_score) if raw_score is not None else None  # lihat catatan di format_sources()
        snippet = node.node.get_content().strip().replace("\n", " ")
        if len(snippet) > 400:
            snippet = snippet[:400] + " ...(dipotong)"
        result["debug_chunks"].append({
            "rank": i,
            "score": score,
            "page": node.metadata.get("page_label", "?"),
            "title": node.metadata.get("title", "?"),
            "snippet": snippet,
        })

    sources = format_sources(nodes)
    ambiguous_titles = detect_ambiguous_top_titles(sources)

    # Dua dokumen teratas sama-sama SOP (mis. SOP Penyusunan / Persiapan /
    # Penulisan Publikasi Analisis Isu Terkini) BUKAN kasus "dua publikasi
    # sama kuat": prompt jawaban gabungan dirancang utk memadukan publikasi
    # statistik dan terbukti menghasilkan jawaban ngawur utk SOP (log/screenshot
    # nyata). Lewati -> jatuh ke sintesis normal, jalur yang sudah terbukti
    # baik utk pertanyaan SOP (mis. "prosedur cuti pegawai").
    if ambiguous_titles and _titles_are_all_sop(nodes, ambiguous_titles):
        print("[INFO] Dua dokumen teratas sama-sama SOP -> jawaban gabungan dilewati, "
              "memakai sintesis normal.")
        ambiguous_titles = None

    if ambiguous_titles:
        title1, title2 = ambiguous_titles
        same_series = _normalize(_strip_year(title1)) == _normalize(_strip_year(title2))
        years_in_question = extract_years_mentioned(question)

        # Klarifikasi HANYA kalau ambiguitasnya murni karena user tidak
        # menyebut tahun edisi mana yang dimaksud (same_series) DAN ini
        # BUKAN pertanyaan tren (tren justru sengaja mau memadukan banyak
        # edisi tahun -- lihat is_trend_request). Kalau bukan same_series
        # (dua publikasi beda topik/seri yang kebetulan skornya berdekatan),
        # tetap pakai jalur combined-answer lama, bukan klarifikasi.
        if same_series and not years_in_question and not is_trend_request(question):
            editions = find_all_editions_by_base_title(title1, titles_index) if titles_index else []
            if len(editions) < 2:
                editions = [
                    {"title": title1, "link": next((l for t, l, _, _, _ in sources if t == title1), None), "year": None},
                    {"title": title2, "link": next((l for t, l, _, _, _ in sources if t == title2), None), "year": None},
                ]

            result["mode"] = "needs_clarification"
            lines = [
                "Pertanyaan Anda cocok dengan beberapa EDISI TAHUN dari publikasi yang "
                "sama, dan tahun yang dimaksud tidak disebutkan. Silakan ulangi "
                "pertanyaan dengan menyebutkan tahun publikasi yang dimaksud, "
                "misalnya salah satu dari edisi berikut:",
                "",
            ]
            for e in editions:
                year_label = f" ({e['year']})" if e["year"] else ""
                if e["link"]:
                    lines.append(f"- {e['title']}{year_label} — {e['link']}")
                else:
                    lines.append(f"- {e['title']}{year_label}")
            result["answer"] = "\n".join(lines)
            result["sources"] = [
                {
                    "title": e["title"], "link": e["link"], "raw_score": None,
                    "percent": None, "pages": [], "cited_pages": [],
                }
                for e in editions
            ]
            return result

        answer = answer_combined_from_multiple_documents(
            question, [title1, title2], nodes
        )
        result["answer"] = answer or "(gagal menyusun jawaban gabungan)"

        if answer and _answer_says_not_found(answer):
            # LLM sendiri menyimpulkan tidak ada jawaban yang valid dari
            # kedua sumber (mis. keduanya cuma "terkait topik" tapi beda
            # objek/cakupan) -> ini BUKAN kasus "memadukan sumber", jadi
            # jangan tandai sebagai combined.
            result["combined"] = False
            result["combined_titles"] = []
        else:
            result["combined"] = True
            result["combined_titles"] = [title1, title2]
    elif result["mode"] == "qa" and _top_chunk_is_image_only(nodes):
        # Jawaban akan DITIMPA total dgn pesan jujur + gambar di bawah, jadi
        # sintesis LLM dilewati (hemat 1 panggilan LLM penuh).
        result["answer"] = ""
    else:
        try:
            response = query_engine.synthesize(query_bundle, nodes)
        except Exception as e:
            result["error"] = f"Gagal menyusun jawaban: {e}"
            return result
        result["answer"] = str(response).strip()
    t_answered = time.perf_counter()
    _emb = _LAST_RETRIEVAL_TIMING["embed"]
    _srch = _LAST_RETRIEVAL_TIMING["search"]
    _rerank = max(0.0, (t_retrieved - t_start) - _emb - _srch)
    print(f"[WAKTU] embed={_emb:.1f}s pencarian-vektor={_srch:.1f}s "
          f"rerank+filter={_rerank:.1f}s | jawaban(LLM)={t_answered - t_retrieved:.1f}s "
          f"| total={t_answered - t_start:.1f}s")

    # Kalau chunk PERINGKAT #1 (yang paling menentukan isi jawaban LLM)
    # berasal dari halaman gambar-saja (text_reliable=False), teks jawaban
    # LLM apa pun isinya TIDAK dipercaya -- ditimpa total dengan pesan jujur
    # + gambar halaman asli. Ini beda dari kasus "gambar sekadar pelengkap"
    # (text_reliable=True/tidak ada): di kasus itu teks jawaban LLM tetap
    # dipakai normal, gambar cuma tampil kecil di panel sumber sebagai
    # pelengkap visual (lihat format_sources() & app.js renderSources()).
    #
    # Dicek dari `nodes` (chunk asli hasil rerank, SEBELUM
    # dedup per-publikasi di format_sources()) supaya "peringkat #1" benar2
    # merujuk chunk tunggal yang mendominasi sintesis LLM, bukan publikasi
    # gabungan yang mungkin campur beberapa halaman.
    result["image_only"] = (
        result["mode"] == "qa"
        and not ambiguous_titles
        and _top_chunk_is_image_only(nodes)
    )
    if result["image_only"]:
        top_node = nodes[0]
        img_page = str(top_node.metadata.get("page_label", "")).strip()
        img_url = str(top_node.metadata.get("image_url", "")).strip()
        img_title = top_node.metadata.get("title", "").strip()
        result["answer"] = (
            f"Konten halaman {img_page or '?'} pada dokumen \"{img_title}\" "
            "berupa tabel/format yang tidak bisa direkonstruksi jadi teks "
            "secara andal saat pemrosesan. Silakan lihat gambar halaman "
            "asli di bawah untuk detail lengkapnya."
        )

    cited_pages = extract_cited_pages(result.get("answer") or "")

    # title -> nama file sumber, hanya utk chunk SOP (dipakai mencari gambar
    # halaman SOP yang chunk-nya tidak ikut ter-retrieve; lihat find_sop_page_images).
    sop_file_by_title = {}
    for _n in nodes:
        _md = _n.metadata
        if _md.get("jenis_dokumen") == SOP_DOC_TYPE and _md.get("source_file"):
            sop_file_by_title.setdefault((_md.get("title") or "").strip(), _md["source_file"])

    for title, link, raw, pages, images in sources:
        if not images and title in sop_file_by_title:
            images = find_sop_page_images(sop_file_by_title[title])
        images = [{**im, "hash": _image_content_hash(im.get("url", ""))} for im in images]
        result["sources"].append({
            "title": title,
            "link": link or None,
            "raw_score": raw,
            "percent": score_to_percent(raw) if raw is not None else None,
            "pages": pages,
            # halaman dari 'pages' yang benar-benar disebut di teks jawaban --
            # dipakai frontend untuk highlight.
            "cited_pages": sorted(set(pages) & cited_pages, key=_page_sort_key),
            # halaman yang visualnya di-fallback ke gambar saat ingest (lihat
            # ingest/sop.py: save_sop_page_image) -- frontend render <img>
            # utk tiap entry di sini. Kosong utk dokumen tanpa gambar sama sekali.
            "images": images,
        })

    # featured_image: satu gambar paling relevan untuk ditampilkan BESAR
    # langsung di dalam bubble jawaban (bukan cuma di panel "Sumber
    # publikasi" yang collapsed) -- diambil dari publikasi skor tertinggi
    # (result["sources"][0]), dan HANYA gambar yang text_reliable=False
    # (artinya gambar itu satu-satunya rujukan andal, bukan pelengkap).
    # None kalau publikasi teratas tidak punya gambar semacam itu.
    result["featured_image"] = None
    if result["mode"] == "qa" and result["sources"]:
        top_source = result["sources"][0]
        unreliable_imgs = [
            img for img in top_source.get("images", [])
            if img.get("text_reliable") is False
        ]
        if unreliable_imgs:
            img = unreliable_imgs[0]
            result["featured_image"] = {
                "url": img["url"],
                "page": img["page"],
                "title": top_source["title"],
            }

    if sources:
        top_raw = sources[0][2]
        if top_raw is not None and top_raw < RERANK_SCORE_WARN_THRESHOLD:
            result["warning"] = (
                "Skor tertinggi bernilai negatif -- re-ranker menilai TIDAK ADA "
                "chunk yang benar-benar menjawab pertanyaan ini. Besar kemungkinan "
                "informasi yang dicari memang tidak ada di korpus, atau tertulis "
                "dengan istilah yang berbeda. Jangan pakai jawaban di atas tanpa "
                "verifikasi ke dokumen aslinya."
            )
        elif ambiguous_titles and result["combined"]:
            result["note"] = (
                f"Publikasi teratas ('{title1}') dan kedua ('{title2}') skornya "
                "berdekatan -> jawaban dibuat memadukan kedua sumber sekaligus, "
                "bukan dipilih salah satu."
            )

    return result


def main():
    index, client, reranker = build_index()
    Settings._qdrant_client = client

    titles_index = build_or_load_title_index(client)

    print("=" * 70)
    print("CHATBOT PUBLIKASI BPS PROVINSI KALIMANTAN TENGAH")
    print("Ketik pertanyaan, atau 'exit' / 'keluar' untuk berhenti.")
    print("=" * 70)

    while True:
        try:
            question = input("\nPertanyaan Anda: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nSampai jumpa.")
            break

        if not question:
            continue
        if question.lower() in ("exit", "quit", "keluar", "/bye"):
            print("Sampai jumpa.")
            break

        print("\nMencari jawaban...\n")

        r = answer_question(question, index, reranker, titles_index)

        if r["error"]:
            print(f"[ERROR] {r['error']}")
            continue

        if r["note"]:
            print(f"[INFO] {r['note']}")

        if r["mode"] == "summary_not_found":
            print(f"[PERINGATAN] {r['warning']}")
            print("-" * 70)
            continue

        if r["mode"] == "needs_clarification":
            print("Jawaban (butuh klarifikasi tahun/edisi):")
            print(r["answer"])
            print("-" * 70)
            continue

        if r["mode"] == "list_publications":
            print("Jawaban (daftar publikasi terkait):")
            print(r["answer"])
            if r["warning"]:
                print(f"\n[PERINGATAN] {r['warning']}")
            print_sources([(s["title"], s["link"] or "", s["raw_score"], s["pages"]) for s in r["sources"]])
            print("-" * 70)
            continue

        if r["mode"] == "summary":
            print("Jawaban (ringkasan dokumen penuh):")
            print(r["answer"])
            dm = r["doc_meta"]
            print(f"\nSumber: {dm['title']} ({dm['n_chunks']} bagian teks digunakan)")
            if dm["link_publikasi"]:
                print(dm["link_publikasi"])
            print("-" * 70)
            continue

        if DEBUG_SHOW_RETRIEVED_CHUNKS and r["debug_chunks"]:
            print("[DEBUG] Chunk yang di-retrieve & dikirim ke LLM (setelah re-rank):")
            for c in r["debug_chunks"]:
                score_str = f"{c['score']:+.4f}" if c["score"] is not None else "N/A"
                print(f"  [{c['rank']}] skor={score_str} | hal. {c['page']} | {c['title'][:70]}")
                print(f"      {c['snippet']}")
            print()

        if r["combined"]:
            pass  # catatan sudah dicetak di atas lewat r["note"]

        print("Jawaban:")
        print(r["answer"])

        print_sources([(s["title"], s["link"] or "", s["raw_score"], s["pages"]) for s in r["sources"]])
        print("-" * 70)


if __name__ == "__main__":
    main()