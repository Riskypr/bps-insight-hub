// Utility functions used across the RAG document upload flow

export function categoryFromTitle(title: string) {
  const value = title.toLowerCase();
  if (value.includes("sop") || value.includes("prosedur")) return "SOP";
  if (value.includes("keuangan") || value.includes("anggaran") || value.includes("spj"))
    return "Keuangan";
  if (value.includes("pegawai") || value.includes("kepegawaian") || value.includes("sdm"))
    return "SDM";
  if (value.includes("statistik") || value.includes("sensus") || value.includes("survei"))
    return "Statistik";
  if (value.includes("pedoman") || value.includes("panduan")) return "Pedoman";
  return "Dokumen Umum";
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}
