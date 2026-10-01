"""
app.py -- Web API Server untuk Chatbot RAG BPS Kalimantan Tengah (chat.py).

Menghubungkan frontend TanStack / Hono ke model RAG publikasi BPS Kalteng.
Fitur:
  - Menginisialisasi VectorStoreIndex Qdrant & SentenceTransformer Reranker sekali saat startup.
  - Endpoint POST /api/ask (non-streaming) dengan AnswerCache (exact & semantic).
  - Endpoint POST /api/chat/stream (Server-Sent Events / SSE) untuk streaming ke chat UI.
  - Endpoint GET /api/health untuk healthcheck koneksi Ollama & Qdrant.
  - Endpoint GET /api/cache/stats untuk monitoring performa cache.
  - Serving file statis gambar SOP dari folder static/sop_images.

Jalankan:
  python back-end/app.py
"""

import json
import os
import sys
import time
import traceback
from flask import Flask, Response, jsonify, request, send_from_directory

try:
    from flask_cors import CORS
    HAS_CORS = True
except ImportError:
    HAS_CORS = False

# Enable line-buffered stdout for real-time logs
try:
    sys.stdout.reconfigure(line_buffering=True)
except Exception:
    pass

# Ensure back-end directory is in sys.path
backend_dir = os.path.dirname(os.path.abspath(__file__))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

try:
    import chat as rag
    from answer_cache import AnswerCache
except Exception as e:
    rag = None
    AnswerCache = None
    print(f"[PERINGATAN] Gagal mengimpor modul chat.py / answer_cache: {e}")

app = Flask(__name__, static_folder=os.path.join(backend_dir, "static"))
if HAS_CORS:
    CORS(app)
else:
    @app.after_request
    def add_cors_headers(response):
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
        return response

# Pipeline state
_index = None
_client = None
_reranker = None
_titles_index = None
_cache = None
_init_error = None
_is_initializing = False


def init_pipeline():
    global _index, _client, _reranker, _titles_index, _cache, _init_error, _is_initializing
    if rag is None:
        _init_error = "Modul chat.py tidak dapat diimpor. Pastikan dependencies di requirements.txt sudah terinstall."
        print(f"[ERROR] {_init_error}")
        return False

    _is_initializing = True
    print("\n" + "=" * 60)
    print("Menginisialisasi pipeline RAG BPS (Qdrant, Ollama, Re-ranker)...")
    print("=" * 60)

    try:
        _index, _client, _reranker = rag.build_index()
        rag.Settings._qdrant_client = _client
        _titles_index = rag.build_or_load_title_index(_client)

        if AnswerCache is not None:
            try:
                _cache = AnswerCache(embed_fn=lambda q: rag.Settings.embed_model.get_text_embedding(q))
            except Exception as e:
                print(f"[PERINGATAN] Cache semantik gagal: {e}, fallback ke exact-only cache.")
                _cache = AnswerCache(embed_fn=None)

        _init_error = None
        print("Pipeline RAG siap melayani pertanyaan.")
        return True
    except (Exception, SystemExit, BaseException) as e:
        _init_error = str(e)
        print(f"\n[ERROR INISIALISASI PIPELINE]: {_init_error}")
        print("Detail:")
        traceback.print_exc()
        print("\nServer tetap berjalan untuk healthcheck. Silakan pastikan Ollama dan Qdrant aktif, lalu reload/restart.\n")
        return False
    finally:
        _is_initializing = False


def _is_cacheable(payload: dict) -> bool:
    if payload.get("warning"):
        return False
    if payload.get("mode") in ("needs_clarification", "summary_not_found"):
        return False
    return bool((payload.get("answer") or "").strip())


# ── Static Images Route ──
@app.route("/static/sop_images/<path:filename>")
def serve_sop_image(filename):
    sop_dir = os.path.join(backend_dir, "static", "sop_images")
    return send_from_directory(sop_dir, filename)


# ── Healthcheck ──
@app.route("/health", methods=["GET"])
@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ready" if _index is not None else ("initializing" if _is_initializing else "error"),
        "ready": _index is not None,
        "is_initializing": _is_initializing,
        "error": _init_error,
        "llm_model": getattr(rag, "LLM_MODEL", None) if rag else None,
        "qdrant_host": getattr(rag, "QDRANT_HOST", None) if rag else None,
        "qdrant_port": getattr(rag, "QDRANT_PORT", None) if rag else None,
    })


# ── Trigger Re-Inisialisasi ──
@app.route("/api/init", methods=["GET", "POST"])
def trigger_init():
    if _is_initializing:
        return jsonify({"status": "initializing", "message": "Inisialisasi sedang berlangsung..."}), 202
    success = init_pipeline()
    return jsonify({
        "status": "ready" if success else "error",
        "ready": success,
        "error": _init_error,
    }), 200 if success else 503


# ── Cache Stats ──
@app.route("/api/cache/stats", methods=["GET"])
def cache_stats():
    if _cache is None:
        return jsonify({"error": "Cache belum diinisialisasi."}), 503
    return jsonify(_cache.snapshot_stats())


# ── POST /api/ask (Non-streaming) ──
@app.route("/api/ask", methods=["POST"])
def ask():
    if _index is None:
        err_msg = _init_error or "Server belum siap (sedang inisialisasi atau Ollama/Qdrant belum aktif)."
        return jsonify({
            "error": err_msg,
            "status": "not_ready",
            "hint": "Pastikan Ollama (http://localhost:11434) dan Qdrant (localhost:6333) sudah berjalan.",
        }), 503

    data = request.get_json(silent=True) or {}
    question = (data.get("question") or data.get("message") or "").strip()
    conversation_id = data.get("conversationId")

    if not question:
        return jsonify({"error": "Pertanyaan tidak boleh kosong."}), 400

    skip_cache = bool(data.get("no_cache"))

    if _cache is not None and not skip_cache:
        cached_payload, match_type = _cache.get(question)
        if cached_payload is not None:
            return jsonify({
                **cached_payload,
                "conversationId": conversation_id,
                "cached": True,
                "cache_match": match_type,
            })

    try:
        r = rag.answer_question(question, _index, _reranker, _titles_index)
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": f"Terjadi kesalahan saat memproses pertanyaan: {e}"}), 500

    if r.get("error"):
        return jsonify({"error": r["error"]}), 500

    payload = {
        "conversationId": conversation_id,
        "mode": r.get("mode"),
        "answer": r.get("answer"),
        "warning": r.get("warning"),
        "note": r.get("note"),
        "combined": r.get("combined"),
        "combined_titles": r.get("combined_titles"),
        "breadth_hint": r.get("breadth_hint"),
        "sources": r.get("sources"),
        "featured_image": r.get("featured_image"),
        "image_only": r.get("image_only"),
        "debug_chunks": r.get("debug_chunks"),
        "doc_meta": r.get("doc_meta"),
    }

    if _cache is not None and not skip_cache and _is_cacheable(payload):
        _cache.set(question, payload)

    return jsonify({**payload, "cached": False, "cache_match": None})


# ── POST /api/chat/stream (SSE Streaming) ──
@app.route("/api/chat/stream", methods=["POST"])
def stream_chat():
    if _index is None:
        err_msg = _init_error or "Server belum siap (sedang inisialisasi atau Ollama/Qdrant belum aktif)."
        return jsonify({
            "error": err_msg,
            "status": "not_ready",
            "hint": "Pastikan Ollama (http://localhost:11434) dan Qdrant (localhost:6333) sudah berjalan.",
        }), 503

    data = request.get_json(silent=True) or {}
    question = (data.get("question") or data.get("message") or "").strip()
    conversation_id = data.get("conversationId") or f"conv_{int(time.time()*1000)}"

    if not question:
        return jsonify({"error": "Pertanyaan tidak boleh kosong."}), 400

    skip_cache = bool(data.get("no_cache"))

    def generate_events():
        # 1. First event: Meta with conversationId
        yield f"data: {json.dumps({'conversationId': conversation_id})}\n\n"

        # Check cache first
        if _cache is not None and not skip_cache:
            cached_payload, match_type = _cache.get(question)
            if cached_payload is not None:
                text = cached_payload.get("answer") or ""
                # Stream cached answer in chunks
                chunk_size = 12
                words = text.split(" ")
                for i in range(0, len(words), chunk_size):
                    chunk = " ".join(words[i:i + chunk_size]) + (" " if i + chunk_size < len(words) else "")
                    yield f"data: {json.dumps({'choices': [{'delta': {'content': chunk}}]})}\n\n"
                    time.sleep(0.015)

                # Send final metadata
                meta_event = {
                    "conversationId": conversation_id,
                    "sources": cached_payload.get("sources"),
                    "featuredImage": cached_payload.get("featured_image"),
                    "warning": cached_payload.get("warning"),
                    "note": cached_payload.get("note"),
                    "mode": cached_payload.get("mode"),
                    "cached": True,
                    "cache_match": match_type,
                }
                yield f"data: {json.dumps(meta_event)}\n\n"
                yield "data: [DONE]\n\n"
                return

        try:
            r = rag.answer_question(question, _index, _reranker, _titles_index)
        except Exception as e:
            err_str = f"Maaf, terjadi kesalahan saat memproses jawaban: {e}"
            yield f"data: {json.dumps({'choices': [{'delta': {'content': err_str}}]})}\n\n"
            yield "data: [DONE]\n\n"
            return

        if r.get("error"):
            err_msg = f"Error: {r['error']}"
            yield f"data: {json.dumps({'choices': [{'delta': {'content': err_msg}}]})}\n\n"
            yield "data: [DONE]\n\n"
            return

        answer_text = r.get("answer") or ""

        # Stream the synthesized answer tokens
        chunk_size = 8
        words = answer_text.split(" ")
        for i in range(0, len(words), chunk_size):
            chunk = " ".join(words[i:i + chunk_size]) + (" " if i + chunk_size < len(words) else "")
            yield f"data: {json.dumps({'choices': [{'delta': {'content': chunk}}]})}\n\n"
            time.sleep(0.02)

        # Cache payload if valid
        payload_to_cache = {
            "conversationId": conversation_id,
            "mode": r.get("mode"),
            "answer": answer_text,
            "warning": r.get("warning"),
            "note": r.get("note"),
            "combined": r.get("combined"),
            "combined_titles": r.get("combined_titles"),
            "breadth_hint": r.get("breadth_hint"),
            "sources": r.get("sources"),
            "featured_image": r.get("featured_image"),
            "image_only": r.get("image_only"),
            "debug_chunks": r.get("debug_chunks"),
            "doc_meta": r.get("doc_meta"),
        }
        if _cache is not None and not skip_cache and _is_cacheable(payload_to_cache):
            _cache.set(question, payload_to_cache)

        # Send final rich metadata event
        meta_event = {
            "conversationId": conversation_id,
            "sources": r.get("sources"),
            "featuredImage": r.get("featured_image"),
            "warning": r.get("warning"),
            "note": r.get("note"),
            "mode": r.get("mode"),
        }
        yield f"data: {json.dumps(meta_event)}\n\n"
        yield "data: [DONE]\n\n"

    return Response(generate_events(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    })


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    init_pipeline()
    print(f"\nServer Flask berjalan di http://0.0.0.0:{port}")
    # threaded=False agar pipeline re-ranker GPU/CPU aman dari race conditions
    app.run(host="0.0.0.0", port=port, debug=False, threaded=False)
