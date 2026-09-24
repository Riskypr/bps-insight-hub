import { ChangeEvent, DragEvent, useRef, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { FileText, FileUp, LoaderCircle, UploadCloud, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader } from "@/components/common";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { categoryFromTitle, formatFileSize } from "@/lib/rag-document-store";

export const Route = createFileRoute("/_shell/rag-documents")({ component: RagDocuments });

const categories = ["SOP", "Pedoman", "Statistik", "Keuangan", "SDM", "Dokumen Umum"];

type PendingFile = {
  id: string;
  file: File;
  title: string;
  category: string;
  categoryMode: "auto" | "manual";
  progress: number;
  status: "Siap diunggah" | "Mengunggah" | "Mengindeks";
};

function RagDocuments() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  const addFiles = (files: FileList | File[]) => {
    const allFiles = Array.from(files);
    const pdfFiles = allFiles.filter(
      (file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"),
    );
    if (pdfFiles.length !== allFiles.length)
      toast.error("Beberapa berkas dilewati", {
        description: "Hanya dokumen PDF yang dapat diunggah.",
      });
    setPendingFiles((current) => [
      ...current,
      ...pdfFiles.map((file) => {
        const title = file.name.replace(/\.pdf$/i, "");
        return {
          id: crypto.randomUUID(),
          file,
          title,
          category: categoryFromTitle(title),
          categoryMode: "auto" as const,
          progress: 0,
          status: "Siap diunggah" as const,
        };
      }),
    ]);
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) addFiles(event.target.files);
    event.target.value = "";
  };
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
  };
  const updateFile = (id: string, changes: Partial<PendingFile>) =>
    setPendingFiles((current) =>
      current.map((item) => (item.id === id ? { ...item, ...changes } : item)),
    );

  const uploadBatch = async () => {
    if (!pendingFiles.length) return;
    setIsUploading(true);

    // Show uploading state immediately
    setPendingFiles((current) =>
      current.map((item) => ({ ...item, status: "Mengunggah" as const, progress: 10 })),
    );

    try {
      const files = pendingFiles.map((item) => item.file);
      const metadata = pendingFiles.map((item) => ({
        title: item.title.trim() || item.file.name.replace(/\.pdf$/i, ""),
        category: item.category,
      }));

      // Show indexing state while waiting for server
      setPendingFiles((current) =>
        current.map((item) => ({ ...item, status: "Mengindeks" as const, progress: 60 })),
      );

      const response = await api.pdfs.upload(files, metadata);

      // Mark 100%
      setPendingFiles((current) =>
        current.map((item) => ({ ...item, progress: 100 })),
      );

      const { summary } = response;

      // Inform user with summary toast
      if (summary.uploaded > 0 && summary.skipped === 0 && summary.failed === 0) {
        toast.success("Unggahan selesai", {
          description: `${summary.uploaded} dokumen berhasil diunggah dan siap digunakan AI.`,
        });
      } else if (summary.uploaded === 0 && summary.skipped > 0 && summary.failed === 0) {
        toast.warning("Semua file sudah ada", {
          description: `${summary.skipped} file terdeteksi sebagai duplikat dan dilewati.`,
        });
      } else {
        const parts: string[] = [];
        if (summary.uploaded) parts.push(`${summary.uploaded} berhasil`);
        if (summary.skipped) parts.push(`${summary.skipped} duplikat`);
        if (summary.failed) parts.push(`${summary.failed} gagal`);
        toast.info("Unggahan selesai", { description: parts.join(", ") + "." });
      }

      // Individual FAILED toasts
      for (const item of response.data) {
        if (item.status === "FAILED") {
          toast.error(`Gagal: ${item.originalName}`, { description: item.reason });
        }
      }
    } catch (error: unknown) {
      toast.error("Upload gagal", {
        description: error instanceof Error ? error.message : "Terjadi kesalahan server.",
      });
    } finally {
      // Small delay so progress bar reaches 100% before clearing
      await new Promise((resolve) => window.setTimeout(resolve, 400));
      setPendingFiles([]);
      setIsUploading(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-8 overflow-y-auto px-6 py-8">
      <PageHeader
        title="Unggah Dokumen RAG"
        subtitle="Tambahkan satu atau beberapa PDF sebagai sumber pengetahuan AI Assistant."
        action={
          <Button variant="outline" asChild>
            <Link to="/rag-document-collection">Koleksi dokumen</Link>
          </Button>
        }
      />
      <section className="panel p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-bps-blue-soft text-bps-blue">
            <UploadCloud className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-base font-semibold">Pilih dokumen PDF</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Anda dapat mengunggah beberapa dokumen sekaligus.
            </p>
          </div>
        </div>
        <div
          role="button"
          tabIndex={0}
          onClick={() => !isUploading && inputRef.current?.click()}
          onKeyDown={(event) => event.key === "Enter" && inputRef.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          className={cn(
            "mt-6 flex min-h-44 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed px-5 text-center transition-colors",
            isDragging
              ? "border-bps-blue bg-bps-blue-soft/60"
              : "border-bps-blue/30 bg-surface-2/40 hover:border-bps-blue/60 hover:bg-bps-blue-soft/30",
            isUploading && "pointer-events-none opacity-70",
          )}
        >
          <input
            ref={inputRef}
            type="file"
            multiple
            accept="application/pdf,.pdf"
            onChange={handleFileChange}
            className="hidden"
          />
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-bps-blue-soft text-bps-blue">
            <FileUp className="h-5 w-5" />
          </div>
          <p className="mt-3 text-sm font-medium">Tarik beberapa PDF ke sini atau pilih berkas</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Hanya format PDF, maksimal 25 MB per berkas
          </p>
        </div>
      </section>
      {pendingFiles.length > 0 && (
        <section className="panel overflow-hidden">
          <div className="flex items-center justify-between gap-4 border-b p-5">
            <div>
              <h2 className="text-base font-semibold">Siap diunggah</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Judul dibuat dari nama berkas dan dapat Anda ubah.
              </p>
            </div>
            <Badge variant="secondary">{pendingFiles.length} PDF</Badge>
          </div>
          <div className="divide-y">
            {pendingFiles.map((item) => (
              <div key={item.id} className="p-5">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
                    <FileText className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{item.file.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatFileSize(item.file.size)}
                    </p>
                  </div>
                  {!isUploading && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() =>
                        setPendingFiles((current) => current.filter((file) => file.id !== item.id))
                      }
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_190px]">
                  <label className="space-y-1.5">
                    <span className="text-xs font-medium text-muted-foreground">Judul dokumen</span>
                    <Input
                      value={item.title}
                      disabled={isUploading}
                      onChange={(event) =>
                        updateFile(item.id, {
                          title: event.target.value,
                          category:
                            item.categoryMode === "auto"
                              ? categoryFromTitle(event.target.value)
                              : item.category,
                        })
                      }
                    />
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-xs font-medium text-muted-foreground">Kategori</span>
                    <Select
                      value={item.categoryMode === "auto" ? "auto" : item.category}
                      disabled={isUploading}
                      onValueChange={(value) =>
                        updateFile(
                          item.id,
                          value === "auto"
                            ? { categoryMode: "auto", category: categoryFromTitle(item.title) }
                            : { categoryMode: "manual", category: value },
                        )
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">
                          Otomatis: {categoryFromTitle(item.title)}
                        </SelectItem>
                        {categories.map((category) => (
                          <SelectItem key={category} value={category}>
                            {category}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                </div>
                {isUploading && (
                  <div className="mt-4">
                    <div className="mb-1.5 flex justify-between text-xs text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                        {item.status}
                      </span>
                      <span>{item.progress}%</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-bps-blue transition-all duration-300"
                        style={{ width: `${item.progress}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="flex justify-end border-t p-5">
            <Button onClick={uploadBatch} disabled={isUploading}>
              {isUploading ? (
                <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <UploadCloud className="mr-2 h-4 w-4" />
              )}
              {isUploading ? "Mengunggah batch" : `Unggah ${pendingFiles.length} dokumen`}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
