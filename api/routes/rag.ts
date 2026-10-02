import { Hono } from "hono";
import { ragFetch, RagUnavailableError } from "../lib/rag";

const ragRoutes = new Hono();

/**
 * Nama file SOP asli memuat spasi dan kurung, mis.
 * "62551.11 SOP Penyusunan (Revisi) Unit Pengolahan_p3.png" (di URL jadi %20).
 * Jadi validasi TIDAK boleh memakai [A-Za-z0-9._-] saja.
 * Yang ditolak: pemisah path, karakter kontrol/NUL, awalan titik, ekstensi non-gambar.
 */
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

function hasForbiddenChar(name: string): boolean {
  if (name.includes("/") || name.includes("\\")) return true;
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function validImageName(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (name.startsWith(".")) return false;
  if (hasForbiddenChar(name)) return false;
  return IMAGE_EXT.test(name);
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

// Browser pegawai tidak boleh menembak Flask langsung: gambar SOP diteruskan lewat Hub.
ragRoutes.get("/sop-image/:name", async (c) => {
  const raw = c.req.param("name");
  // Hono sudah meng-decode sebagian versi; amankan bila belum.
  let name = raw;
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded !== raw) name = decoded;
  } catch {
    /* persen rusak: pakai apa adanya, validasi di bawah yang menolak */
  }

  if (!validImageName(name)) return c.json({ error: "Nama gambar tidak valid" }, 400);

  try {
    const up = await ragFetch(`/static/sop_images/${encodeURIComponent(name)}`, {}, false);
    if (!up.ok) return c.json({ error: "Gambar tidak ditemukan" }, up.status === 404 ? 404 : 502);
    const ext = name.split(".").pop()?.toLowerCase() ?? "png";
    return new Response(up.body, {
      headers: {
        "Content-Type": up.headers.get("content-type") ?? MIME[ext] ?? "application/octet-stream",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (e) {
    if (e instanceof RagUnavailableError)
      return c.json({ error: "Layanan RAG tidak terjangkau" }, 502);
    throw e;
  }
});

export { ragRoutes };
