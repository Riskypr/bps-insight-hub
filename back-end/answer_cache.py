"""
answer_cache.py
Cache jawaban dua lapis (Exact Match + Semantic Match) untuk Chatbot BPS Kalteng.

Fitur:
  1. Exact match: hash/string normalisasi untuk pertanyaan identik (O(1)).
  2. Semantic match: cosine similarity antar vector embedding pertanyaan (O(N) in-memory).
  3. TTL (Time-To-Live) dan LRU eviction saat kapasitas penuh.
  4. Thread-safe dengan threading.Lock.
"""

import math
import re
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple


def _normalize(text: str) -> str:
    """Normalisasi teks untuk exact matching."""
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", (text or "").lower())).strip()


def _cosine_similarity(vec_a: List[float], vec_b: List[float]) -> float:
    """Hitung cosine similarity antara dua vector."""
    if not vec_a or not vec_b or len(vec_a) != len(vec_b):
        return 0.0
    dot = sum(a * b for a, b in zip(vec_a, vec_b))
    norm_a = math.sqrt(sum(a * a for a in vec_a))
    norm_b = math.sqrt(sum(b * b for b in vec_b))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)


class CacheEntry:
    def __init__(self, question: str, payload: Dict[str, Any], embedding: Optional[List[float]], ttl_seconds: float):
        self.question = question
        self.norm_question = _normalize(question)
        self.payload = payload
        self.embedding = embedding
        self.created_at = time.time()
        self.last_accessed_at = self.created_at
        self.ttl_seconds = ttl_seconds

    @property
    def is_expired(self) -> bool:
        return (time.time() - self.created_at) > self.ttl_seconds


class AnswerCache:
    """
    Cache jawaban dengan dua level:
      - Exact Match
      - Semantic Match (cosine threshold >= 0.95)
    """

    def __init__(
        self,
        embed_fn: Optional[Callable[[str], List[float]]] = None,
        max_size: int = 500,
        similarity_threshold: float = 0.94,
        ttl_seconds: float = 21600,  # 6 jam
    ):
        self.embed_fn = embed_fn
        self.max_size = max_size
        self.similarity_threshold = similarity_threshold
        self.ttl_seconds = ttl_seconds

        self._lock = threading.Lock()
        self._exact_map: Dict[str, CacheEntry] = {}
        self._entries: List[CacheEntry] = []

        self._stats = {
            "exact_hits": 0,
            "semantic_hits": 0,
            "misses": 0,
            "evictions": 0,
        }

    def get(self, question: str) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
        """
        Cari pertanyaan di cache.
        Return: (cached_payload, match_type) di mana match_type adalah "exact" | "semantic" | None.
        """
        norm_q = _normalize(question)
        if not norm_q:
            return None, None

        with self._lock:
            # 1. Exact match
            entry = self._exact_map.get(norm_q)
            if entry is not None:
                if entry.is_expired:
                    self._remove_entry(entry)
                else:
                    entry.last_accessed_at = time.time()
                    self._stats["exact_hits"] += 1
                    return dict(entry.payload), "exact"

            # 2. Semantic match
            if self.embed_fn is not None and self._entries:
                try:
                    q_vec = self.embed_fn(question)
                except Exception:
                    q_vec = None

                if q_vec:
                    best_sim = -1.0
                    best_entry: Optional[CacheEntry] = None

                    expired_entries = []
                    for e in self._entries:
                        if e.is_expired:
                            expired_entries.append(e)
                            continue
                        if e.embedding is not None:
                            sim = _cosine_similarity(q_vec, e.embedding)
                            if sim > best_sim:
                                best_sim = sim
                                best_entry = e

                    for exp in expired_entries:
                        self._remove_entry(exp)

                    if best_entry is not None and best_sim >= self.similarity_threshold:
                        best_entry.last_accessed_at = time.time()
                        self._stats["semantic_hits"] += 1
                        return dict(best_entry.payload), f"semantic ({best_sim:.2f})"

            self._stats["misses"] += 1
            return None, None

    def set(self, question: str, payload: Dict[str, Any]):
        """Simpan pertanyaan dan jawaban ke cache."""
        norm_q = _normalize(question)
        if not norm_q:
            return

        embedding = None
        if self.embed_fn is not None:
            try:
                embedding = self.embed_fn(question)
            except Exception:
                embedding = None

        with self._lock:
            # Kalau sudah ada, perbarui
            if norm_q in self._exact_map:
                old = self._exact_map[norm_q]
                self._remove_entry(old)

            # Evict if full
            while len(self._entries) >= self.max_size:
                # Evict oldest accessed
                self._entries.sort(key=lambda x: x.last_accessed_at)
                evicted = self._entries.pop(0)
                self._exact_map.pop(evicted.norm_question, None)
                self._stats["evictions"] += 1

            entry = CacheEntry(
                question=question,
                payload=dict(payload),
                embedding=embedding,
                ttl_seconds=self.ttl_seconds,
            )
            self._exact_map[norm_q] = entry
            self._entries.append(entry)

    def _remove_entry(self, entry: CacheEntry):
        self._exact_map.pop(entry.norm_question, None)
        if entry in self._entries:
            self._entries.remove(entry)

    def snapshot_stats(self) -> Dict[str, Any]:
        """Ambil snapshot statistik cache."""
        with self._lock:
            total_requests = self._stats["exact_hits"] + self._stats["semantic_hits"] + self._stats["misses"]
            hit_rate = 0.0
            if total_requests > 0:
                hit_rate = round(((self._stats["exact_hits"] + self._stats["semantic_hits"]) / total_requests) * 100, 2)

            return {
                **self._stats,
                "current_size": len(self._entries),
                "max_size": self.max_size,
                "hit_rate_pct": hit_rate,
            }
