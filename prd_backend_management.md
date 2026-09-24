# Product Requirement Document (PRD)

## PDF Management Backend Service (Hono + PostgreSQL)

## 1. Overview & Objectives

### 1.1 Summary

Dokumen ini mendefinisikan persyaratan teknis dan fungsional untuk **PDF Management Backend Service**. Layanan backend ini bertanggung jawab mengelola pengunggahan file PDF (baik secara individu/satuan maupun secara massal/bulk), mendeteksi duplikasi file berdasarkan algoritma pengkodean (*hashing*), menyimpan metadata ke database PostgreSQL, serta menyediakan mekanisme penghapusan file dan data terkait.

Sistem backend ini dibangun menggunakan **Hono** (dijalankan di atas Node.js/Bun/Edge runtime) untuk memberikan performa maksimal, *type safety* secara *end-to-end* dengan frontend (React/Next.js), serta integrasi yang mudah dengan Python Bot.

### 1.2 Objectives

* Menyediakan API endpoint yang cepat dan *lightweight* menggunakan Hono untuk upload PDF secara satuan maupun massal.
* Mencegah redundansi data melalui pengecekan duplikasi (*file integrity hashing* SHA-256) sebelum file disimpan.
* Menyediakan mekanisme penghapusan data PDF yang aman (menghapus record di database dan file fisik di storage).
* Menyediakan antarmuka REST API yang aman dan efisien untuk diakses oleh React Frontend dan Python Bot.

---

## 2. Tech Stack & Architecture

### 2.1 Core Technologies

* **Backend Framework:** **Hono** (`hono`)
* **Runtime Environment:** Node.js (v20+) atau Bun
* **Database:** PostgreSQL
* **ORM / Query Builder:** Prisma ORM atau Drizzle ORM
* **File Upload Handling:** Native Web Standard Forms & Body Parser (`c.req.parseBody()` / `c.req.formData()`) dari Hono
* **Storage Strategy:** Cloud Storage (AWS S3 / Supabase Storage / MinIO) atau Local Storage Adapter
* **Authentication & Authorization:** Hono JWT Middleware / API Key Header (khusus akses Python Bot)

### 2.2 System Architecture Diagram

```
  +-------------------+       +--------------------+
  |  React Frontend   |       |     Python Bot     |
  +---------+---------+       +---------+----------+
            |                           |
            | (REST API / Multi-part)   | (REST API / Service Token)
            v                           v
  +------------------------------------------------+
  |              Hono Backend Service              |
  |  - Web Standard Request/Response Engine        |
  |  - SHA-256 Duplicate Check Logic              |
  |  - Storage Manager & DB Handler                |
  +--------------------+---------------------------+
                       |
        +--------------+--------------+
        |                             |
        v                             v
+---------------+             +-----------------+
| PostgreSQL DB |             | Storage Service |
| (Metadata/Hash)             | (PDF Files)     |
+---------------+             +-----------------+
```

---

## 3. Database Schema Design (PostgreSQL)

Skema tabel utama menggunakan Prisma ORM Syntax:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model PdfFile {
  id           String   @id @default(uuid())
  filename     String   @db.VarChar(255)
  originalName String   @map("original_name") @db.VarChar(255)
  fileSize     Int      @map("file_size")
  mimeType     String   @default("application/pdf") @map("mime_type")
  fileHash     String   @unique @map("file_hash") @db.VarChar(64) // SHA-256
  fileUrl      String   @map("file_url")
  storageKey   String   @map("storage_key") // Identifier untuk hapus file di Cloud/Local Storage
  uploadedBy   String?  @map("uploaded_by") // ID user pembawa request
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @updatedAt @map("updated_at")

  @@index([fileHash])
  @@map("pdf_files")
}
```

---

## 4. Functional Requirements

### 4.1 Single & Bulk PDF Upload

* **FR-1.1:** Sistem harus menerima file dalam format `.pdf`.
* **FR-1.2:** Sistem harus dapat menerima upload tunggal (*solo*) maupun upload sekaligus (*massal/batch* - hingga 20 file per request) menggunakan `FormData` parsing bawaan Hono.
* **FR-1.3:** Batas maksimal ukuran file per PDF ditentukan sebesar 25 MB (configurable).

### 4.2 Duplicate File Prevention

* **FR-2.1:** Setiap file yang diunggah harus dihitung *checksum hash*-nya menggunakan algoritma **SHA-256** dari ArrayBuffer file sebelum disimpan ke storage permanen.
* **FR-2.2:** Hono route handler harus mencocokkan nilai `fileHash` dengan data di database PostgreSQL.
* **FR-2.3:** Jika hash ditemukan (duplikat), backend membatalkan penyimpanan file fisik dan memberikan respon status `409 Conflict` atau menandai file tersebut sebagai `SKIPPED` dalam respon batch.

### 4.3 Data Deletion

* **FR-3.1:** Sistem menyediakan endpoint penghapusan berdasarkan `id` file PDF (`DELETE /api/v1/pdfs/:id`).
* **FR-3.2:** Proses penghapusan dilakukan secara atomic:
  1. Menghapus file fisik dari Storage (Cloud/Local).
  2. Menghapus record metadata dari tabel `pdf_files` di PostgreSQL.
* **FR-3.3:** Jika file fisik gagal dihapus, transaksi DB dibatalkan (rollback) atau ditandai sebagai *failed status* untuk mencegah *orphan files*.

### 4.4 Python Bot Integration

* **FR-4.1:** Menyediakan endpoint khusus untuk Python Bot agar dapat mengambil daftar PDF terbaru atau mengunduh file PDF secara langsung.
* **FR-4.2:** Menggunakan skema autentikasi berbasis API Key Header (misal: `X-API-KEY`) atau Bearer Token khusus server-to-server yang divalidasi oleh Hono Middleware.

---

## 5. API Specification

### 5.1 Upload PDF (Single / Bulk)

* **Endpoint:** `POST /api/v1/pdfs/upload`
* **Content-Type:** `multipart/form-data`
* **Request Body:**
  * `files`: Array of Binary Files (PDF)

* **Success Response (200 OK / 207 Multi-Status):**

```json
{
  "success": true,
  "message": "Upload process completed",
  "summary": {
    "total": 2,
    "uploaded": 1,
    "skipped": 1
  },
  "data": [
    {
      "originalName": "Dokumen_A.pdf",
      "status": "SUCCESS",
      "id": "e4f8b1c2-9012-4a56-b789-123456789abc",
      "fileUrl": "https://storage.example.com/pdfs/Dokumen_A.pdf"
    },
    {
      "originalName": "Dokumen_Duplikat.pdf",
      "status": "SKIPPED",
      "reason": "Duplicate file detected",
      "existingFileId": "a1b2c3d4-5678-90ef-1234-567890abcdef"
    }
  ]
}
```

### 5.2 Cek Status Duplikasi File (Pre-upload Check / Optional)

* **Endpoint:** `POST /api/v1/pdfs/check-duplicate`
* **Content-Type:** `application/json`
* **Request Body:**

```json
{
  "hashes": [
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  ]
}
```

* **Success Response (200 OK):**

```json
{
  "duplicates": [
    {
      "hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "exists": true,
      "fileId": "a1b2c3d4-5678-90ef-1234-567890abcdef"
    }
  ]
}
```

### 5.3 Fetch PDF List (Pagination & Filtering)

* **Endpoint:** `GET /api/v1/pdfs?page=1&limit=10&search=Laporan`
* **Success Response (200 OK):**

```json
{
  "success": true,
  "data": [
    {
      "id": "e4f8b1c2-9012-4a56-b789-123456789abc",
      "filename": "Dokumen_A.pdf",
      "fileSize": 1048576,
      "fileUrl": "https://storage.example.com/pdfs/Dokumen_A.pdf",
      "createdAt": "2026-09-23T00:00:00.000Z"
    }
  ],
  "meta": {
    "currentPage": 1,
    "totalPages": 5,
    "totalItems": 45
  }
}
```

### 5.4 Delete PDF Data

* **Endpoint:** `DELETE /api/v1/pdfs/:id`
* **Success Response (200 OK):**

```json
{
  "success": true,
  "message": "PDF file and associated records successfully deleted",
  "deletedId": "e4f8b1c2-9012-4a56-b789-123456789abc"
}
```

---

## 6. Implementation Reference (Hono Router Example)

Berikut adalah gambaran implementasi endpoint upload & hash check menggunakan Hono:

```typescript
import { Hono } from 'hono'
import { crypto } from 'node:crypto' // Atau Web Crypto API
import { PrismaClient } from '@prisma/client'

const app = new Hono()
const prisma = new PrismaClient()

// Helper: SHA-256 Hashing
async function calculateHash(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

app.post('/api/v1/pdfs/upload', async (c) => {
  const body = await c.req.parseBody({ dot: true })
  const rawFiles = body['files']
  const files = Array.isArray(rawFiles) ? rawFiles : [rawFiles]

  const results = []

  for (const item of files) {
    if (!(item instanceof File) || item.type !== 'application/pdf') {
      continue
    }

    const arrayBuffer = await item.arrayBuffer()
    const fileHash = await calculateHash(arrayBuffer)

    // Cek duplikasi di DB
    const existing = await prisma.pdfFile.findUnique({
      where: { fileHash }
    })

    if (existing) {
      results.push({
        originalName: item.name,
        status: 'SKIPPED',
        reason: 'Duplicate file detected',
        existingFileId: existing.id
      })
      continue
    }

    // TODO: Upload arrayBuffer ke Cloud/Local Storage -> dapatkan fileUrl & storageKey
    const fileUrl = `https://storage.local/${item.name}`
    const storageKey = `pdfs/${Date.now()}_${item.name}`

    const saved = await prisma.pdfFile.create({
      data: {
        filename: item.name,
        originalName: item.name,
        fileSize: item.size,
        fileHash,
        fileUrl,
        storageKey
      }
    })

    results.push({
      originalName: item.name,
      status: 'SUCCESS',
      id: saved.id,
      fileUrl: saved.fileUrl
    })
  }

  return c.json({
    success: true,
    message: 'Upload process completed',
    data: results
  })
})

export default app
```

---

## 7. Non-Functional Requirements & Security

### 7.1 Performance
* Memanfaatkan Web Standard APIs bawaan Hono (`Request`, `Response`, `File`, `ArrayBuffer`) untuk efisiensi memori.
* *Type RPC sharing* (`hono/client`) dapat digunakan langsung di React Frontend agar *request/response* berjenis *strictly typed*.

### 7.2 Security & Middleware
* **CORS Middleware:** Menggunakan `hono/cors` untuk membatasi origin dari React Frontend.
* **MIME Validation:** Validasi *magic bytes* PDF (`%PDF-`) pada buffer awal file.
* **Rate Limiting:** Membatasi jumlah request upload per IP / User token.

---

## 8. Next Steps & Timeline Implementation

1. **Phase 1:** Setup Project Hono (`npm create hono@latest`) + Prisma ORM PostgreSQL.
2. **Phase 2:** Implementasi Router Hono, Hashing Utility (SHA-256), dan Integration Storage.
3. **Phase 3:** Pembuatan Endpoint Upload (Single/Bulk) dengan Handling Duplikat.
4. **Phase 4:** Pembuatan Endpoint Delete dan List PDF.
5. **Phase 5:** Setup Hono RPC Client di React Frontend dan API Key Auth untuk Python Bot.