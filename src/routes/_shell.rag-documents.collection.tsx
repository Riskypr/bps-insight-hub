import { useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  Search,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/common";
import { api, type PdfFile } from "@/lib/api";
import { formatFileSize } from "@/lib/rag-document-store";

export const Route = createFileRoute("/_shell/rag-documents/collection")({
  component: RagDocumentCollection,
});

const LIMIT = 15;

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function RagDocumentCollection() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  // Reset to page 1 when search changes
  const handleSearch = (value: string) => {
    setSearch(value);
    setPage(1);
  };

  const {
    data,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ["pdfs", { page, search }],
    queryFn: () => {
      const params: { page: number; limit: number; search?: string } = { page, limit: LIMIT };
      if (search) params.search = search;
      return api.pdfs.list(params);
    },
    placeholderData: (prev) => prev,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.pdfs.delete(id),
    onSuccess: (_, id) => {
      toast.success("Dokumen dihapus dari koleksi.");
      // Optimistically remove from cache before refetch
      queryClient.setQueryData<{ success: boolean; data: PdfFile[]; meta: { currentPage: number; totalPages: number; totalItems: number } }>(
        ["pdfs", { page, search }],
        (old) => old ? { ...old, data: old.data.filter((d) => d.id !== id) } : old,
      );
      void queryClient.invalidateQueries({ queryKey: ["pdfs"] });
    },
    onError: (err: Error) => {
      toast.error("Gagal menghapus dokumen.", { description: err.message });
    },
  });

  const documents = data?.data ?? [];
  const meta = data?.meta;
  const totalPages = meta?.totalPages ?? 1;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-8 overflow-y-auto px-6 py-8">
      <PageHeader
        title="Koleksi Dokumen"
        subtitle="Kelola dokumen yang digunakan sebagai konteks jawaban AI."
        action={
          <Button asChild>
            <Link to="/rag-documents">
              <UploadCloud className="mr-2 h-4 w-4" />
              Unggah dokumen
            </Link>
          </Button>
        }
      />
      <section className="panel overflow-hidden">
        <div className="flex flex-col gap-4 border-b p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold">Semua dokumen</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {meta ? `${meta.totalItems} dokumen tersimpan di basis pengetahuan.` : "Memuat…"}
            </p>
          </div>
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => handleSearch(event.target.value)}
              placeholder="Cari dokumen..."
              className="h-9 pl-9"
            />
          </div>
        </div>

        {/* Loading */}
        {isLoading && (
          <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Memuat dokumen…
          </div>
        )}

        {/* Error */}
        {isError && (
          <div className="flex flex-col items-center gap-2 py-12 text-sm text-destructive">
            <AlertCircle className="h-6 w-6" />
            <span>Gagal memuat dokumen.</span>
            <span className="text-xs text-muted-foreground">{(error as Error).message}</span>
          </div>
        )}

        {/* Empty */}
        {!isLoading && !isError && documents.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-14 text-sm text-muted-foreground">
            <FileText className="h-8 w-8 opacity-40" />
            {search ? (
              <span>Tidak ada dokumen yang cocok dengan pencarian.</span>
            ) : (
              <>
                <span>Belum ada dokumen yang diunggah.</span>
                <Button asChild variant="outline" size="sm">
                  <Link to="/rag-documents">
                    <UploadCloud className="mr-1.5 h-3.5 w-3.5" />
                    Unggah sekarang
                  </Link>
                </Button>
              </>
            )}
          </div>
        )}

        {/* Document list */}
        {!isLoading && !isError && documents.length > 0 && (
          <div className="divide-y">
            {documents.map((document) => (
              <div
                key={document.id}
                className="flex items-center gap-3 px-5 py-4 transition-colors hover:bg-muted/30"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-bps-blue-soft text-bps-blue">
                  <FileText className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {document.title ?? document.originalName}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {formatFileSize(document.fileSize)} · Diunggah {formatDate(document.createdAt)}
                  </p>
                </div>
                <div className="hidden items-center gap-2 sm:flex">
                  <Badge variant="secondary" className="rounded-md">
                    {document.category}
                  </Badge>
                  <span className="flex items-center gap-1 text-xs text-bps-green">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Siap digunakan
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 text-muted-foreground"
                    aria-label={`Unduh ${document.originalName}`}
                    asChild
                  >
                    <a
                      href={api.pdfs.downloadUrl(document.id)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Download className="h-4 w-4" />
                    </a>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 text-muted-foreground"
                    aria-label={`Lihat ${document.originalName}`}
                    asChild
                  >
                    <a
                      href={api.pdfs.downloadUrl(document.id)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label={`Hapus ${document.originalName}`}
                    disabled={deleteMutation.isPending}
                    onClick={() => deleteMutation.mutate(document.id)}
                  >
                    {deleteMutation.isPending && deleteMutation.variables === document.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t px-5 py-3 text-sm">
            <span className="text-muted-foreground">
              Halaman {meta?.currentPage ?? page} dari {totalPages}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Sebelumnya
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Selanjutnya
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
