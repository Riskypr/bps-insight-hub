import { createHash } from "node:crypto";
import { Hono } from "hono";
import { prisma } from "../lib/prisma";
import { pdfStorage } from "../lib/pdf-storage";

const MAX_FILES = 20;
const MAX_FILE_SIZE = Number(process.env.PDF_MAX_FILE_SIZE_BYTES ?? 25 * 1024 * 1024);
const BOT_API_KEY = process.env.PDF_BOT_API_KEY;
const uploadRequests = new Map<string, number[]>();

// ── In-memory search cache (TTL 30s) ─────────────────────────────────────────
const CACHE_TTL_MS = 30_000;
type CacheEntry = { data: unknown; meta: unknown; expires: number };
const searchCache = new Map<string, CacheEntry>();

function cacheGet(key: string): CacheEntry | undefined {
  const entry = searchCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) { searchCache.delete(key); return undefined; }
  return entry;
}

function cacheSet(key: string, data: unknown, meta: unknown) {
  // Evict oldest entries if cache grows beyond 200 keys
  if (searchCache.size >= 200) {
    const oldest = [...searchCache.entries()].sort((a, b) => a[1].expires - b[1].expires)[0];
    if (oldest) searchCache.delete(oldest[0]);
  }
  searchCache.set(key, { data, meta, expires: Date.now() + CACHE_TTL_MS });
}

function cacheClear() { searchCache.clear(); }
// ─────────────────────────────────────────────────────────────────────────────

type FileMetadata = { title?: string; category?: string };

function downloadUrl(origin: string, id: string) {
  return `${origin}/api/v1/pdfs/${id}/download`;
}

function isPdf(content: Uint8Array) {
  return content.length >= 5 && new TextDecoder().decode(content.slice(0, 5)) === "%PDF-";
}

function sanitizeFilename(name: string) {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 255) || "document.pdf";
}

function isBotAuthorized(authorization?: string) {
  return Boolean(BOT_API_KEY && authorization === `Bearer ${BOT_API_KEY}`);
}

function allowUpload(client: string) {
  const now = Date.now();
  const recent = (uploadRequests.get(client) ?? []).filter((time) => now - time < 60_000);
  if (recent.length >= 20) return false;
  recent.push(now);
  uploadRequests.set(client, recent);
  return true;
}

const pdfRoutes = new Hono();

pdfRoutes.post("/upload", async (c) => {
  const client = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (!allowUpload(client)) return c.json({ success: false, error: "Too many upload requests" }, 429);

  const formData = await c.req.formData();
  const files = formData.getAll("files").filter((value): value is File => value instanceof File);
  if (!files.length) return c.json({ success: false, error: "At least one PDF is required" }, 400);
  if (files.length > MAX_FILES) return c.json({ success: false, error: `Maximum ${MAX_FILES} files per upload` }, 400);

  let metadata: FileMetadata[] = [];
  const rawMetadata = formData.get("metadata");
  if (typeof rawMetadata === "string") {
    try {
      const parsed: unknown = JSON.parse(rawMetadata);
      if (Array.isArray(parsed)) metadata = parsed as FileMetadata[];
    } catch {
      return c.json({ success: false, error: "Invalid upload metadata" }, 400);
    }
  }

  const origin = new URL(c.req.url).origin;
  const results: Array<Record<string, unknown>> = [];
  for (const [index, file] of files.entries()) {
    if (file.size > MAX_FILE_SIZE) {
      results.push({ originalName: file.name, status: "FAILED", reason: "File exceeds the 25 MB limit" });
      continue;
    }
    const content = new Uint8Array(await file.arrayBuffer());
    if (!isPdf(content)) {
      results.push({ originalName: file.name, status: "FAILED", reason: "File is not a valid PDF" });
      continue;
    }

    const fileHash = createHash("sha256").update(content).digest("hex");
    const existing = await prisma.pdfFile.findUnique({ where: { fileHash } });
    if (existing) {
      results.push({ originalName: file.name, status: "SKIPPED", reason: "Duplicate file detected", existingFileId: existing.id });
      continue;
    }

    const id = crypto.randomUUID();
    const storageKey = `${id}.pdf`;
    try {
      await pdfStorage.put(storageKey, content);
      const record = await prisma.pdfFile.create({
        data: {
          id,
          filename: sanitizeFilename(file.name),
          originalName: file.name,
          title: metadata[index]?.title?.trim() || null,
          category: metadata[index]?.category?.trim() || "Dokumen Umum",
          fileSize: file.size,
          mimeType: "application/pdf",
          fileHash,
          fileUrl: downloadUrl(origin, id),
          storageKey,
          uploadedBy: c.req.header("x-user-id") ?? null,
        },
      });
      results.push({ originalName: file.name, status: "SUCCESS", id: record.id, fileUrl: record.fileUrl });
    } catch (error: unknown) {
      await pdfStorage.remove(storageKey);
      const duplicate = (error as { code?: string }).code === "P2002";
      if (duplicate) {
        const racedRecord = await prisma.pdfFile.findUnique({ where: { fileHash } });
        results.push({ originalName: file.name, status: "SKIPPED", reason: "Duplicate file detected", existingFileId: racedRecord?.id });
      } else {
        console.error("PDF upload failed", error);
        results.push({ originalName: file.name, status: "FAILED", reason: "Unable to store file" });
      }
    }
  }

  const uploaded = results.filter((item) => item.status === "SUCCESS").length;
  const skipped = results.filter((item) => item.status === "SKIPPED").length;
  const failed = results.length - uploaded - skipped;
  cacheClear(); // invalidate list cache after upload
  return c.json({ success: failed === 0, message: "Upload process completed", summary: { total: files.length, uploaded, skipped, failed }, data: results }, failed ? 207 : 200);
});

pdfRoutes.post("/check-duplicate", async (c) => {
  const body = await c.req.json<{ hashes?: unknown }>().catch(() => ({}));
  if (!Array.isArray(body.hashes) || body.hashes.some((hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/i.test(hash))) {
    return c.json({ error: "hashes must be an array of SHA-256 values" }, 400);
  }
  const records = await prisma.pdfFile.findMany({ where: { fileHash: { in: body.hashes } }, select: { id: true, fileHash: true } });
  const byHash = new Map(records.map((record) => [record.fileHash, record.id]));
  return c.json({ duplicates: body.hashes.map((hash) => ({ hash, exists: byHash.has(hash), ...(byHash.has(hash) ? { fileId: byHash.get(hash) } : {}) })) });
});

type SearchRow = {
  id: string; filename: string; original_name: string; title: string | null;
  category: string; file_size: number; mime_type: string; file_hash: string;
  file_url: string; storage_key: string; uploaded_by: string | null;
  created_at: Date; updated_at: Date; total_count: bigint;
};

function mapRow(r: SearchRow) {
  return {
    id: r.id, filename: r.filename, originalName: r.original_name, title: r.title,
    category: r.category, fileSize: r.file_size, mimeType: r.mime_type,
    fileHash: r.file_hash, fileUrl: r.file_url, storageKey: r.storage_key,
    uploadedBy: r.uploaded_by, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

pdfRoutes.get("/", async (c) => {
  const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 10) || 10));
  const search = c.req.query("search")?.trim();
  const offset = (page - 1) * limit;

  // ── Cache lookup ────────────────────────────────────────────────────────────
  const cacheKey = `${search ?? ""}:${page}:${limit}`;
  const cached = cacheGet(cacheKey);
  if (cached) return c.json({ success: true, cached: true, data: cached.data, meta: cached.meta });

  if (search) {
    // Single query: data + count in one round-trip via window function.
    // GIN trigram index (pg_trgm) makes ILIKE fast even with leading wildcard.
    const pattern = `%${search.replace(/[%_\\]/g, "\\$&")}%`;
    const rows = await prisma.$queryRaw<SearchRow[]>`
      SELECT *, COUNT(*) OVER() AS total_count
      FROM pdf_files
      WHERE original_name ILIKE ${pattern}
         OR title        ILIKE ${pattern}
         OR category     ILIKE ${pattern}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const totalItems = rows.length > 0 ? Number(rows[0].total_count) : 0;
    const data = rows.map(mapRow);
    const meta = { currentPage: page, totalPages: Math.max(1, Math.ceil(totalItems / limit)), totalItems };
    cacheSet(cacheKey, data, meta);
    return c.json({ success: true, data, meta });
  }

  // No search — use Prisma ORM path (still gets cached)
  const [data, totalItems] = await Promise.all([
    prisma.pdfFile.findMany({ orderBy: { createdAt: "desc" }, skip: offset, take: limit }),
    prisma.pdfFile.count(),
  ]);
  const meta = { currentPage: page, totalPages: Math.max(1, Math.ceil(totalItems / limit)), totalItems };
  cacheSet(cacheKey, data, meta);
  return c.json({ success: true, data, meta });
});

pdfRoutes.get("/bot/latest", async (c) => {
  if (!isBotAuthorized(c.req.header("authorization"))) return c.json({ error: "Unauthorized" }, 401);
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20) || 20));
  const data = await prisma.pdfFile.findMany({ orderBy: { createdAt: "desc" }, take: limit });
  return c.json({ success: true, data });
});

pdfRoutes.get("/:id/download", async (c) => {
  const record = await prisma.pdfFile.findUnique({ where: { id: c.req.param("id") } });
  if (!record) return c.json({ error: "PDF not found" }, 404);
  try {
    const content = await pdfStorage.get(record.storageKey);
    return new Response(content, { headers: { "Content-Type": "application/pdf", "Content-Length": String(content.length), "Content-Disposition": `inline; filename="${sanitizeFilename(record.originalName)}"` } });
  } catch {
    return c.json({ error: "Stored PDF is unavailable" }, 410);
  }
});

pdfRoutes.delete("/:id", async (c) => {
  const record = await prisma.pdfFile.findUnique({ where: { id: c.req.param("id") } });
  if (!record) return c.json({ error: "PDF not found" }, 404);
  try {
    await pdfStorage.remove(record.storageKey);
    await prisma.pdfFile.delete({ where: { id: record.id } });
    cacheClear(); // invalidate list cache after delete
    return c.json({ success: true, message: "PDF file and associated records successfully deleted", deletedId: record.id });
  } catch (error) {
    console.error("PDF deletion failed", error);
    return c.json({ success: false, error: "Unable to delete PDF and metadata" }, 500);
  }
});

export { pdfRoutes };
