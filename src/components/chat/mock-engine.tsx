import { datasets, growthSeries, povertySeries, regionMovers } from "@/lib/mock-data";
import type { ChatMessage } from "@/hooks/use-chat";

export type Source = { kind: string; title: string; meta: string };

export type BlockKind = "kpi" | "line" | "area" | "bar" | "table" | "dataset" | "summary";

export type AiAnswer = {
  text: string;
  blocks: BlockKind[];
  insight?: string;
  sources: Source[];
};

const SOURCE_PDRB: Source[] = [
  {
    kind: "Dataset",
    title: "BPS Provinsi Kalimantan Tengah",
    meta: "Dataset PDRB · Tabel Statistik",
  },
  {
    kind: "Publikasi",
    title: "Provinsi Kalimantan Tengah Dalam Angka",
    meta: "Publikasi tahunan · Tabel 9.1",
  },
];

const SOURCE_POVERTY: Source[] = [
  {
    kind: "Dataset",
    title: "Tingkat Kemiskinan Menurut Kabupaten/Kota",
    meta: "Dataset kemiskinan · Tabel Statistik",
  },
  {
    kind: "Dokumen",
    title: "Pedoman Pengolahan Data",
    meta: "Halaman 14 · Metodologi penghitungan",
  },
];

const SOURCE_GENERAL: Source[] = [
  {
    kind: "BPS",
    title: "Badan Pusat Statistik",
    meta: "Sumber referensi umum · Demo Reference",
  },
];

const SOURCE_INFLASI: Source[] = [
  {
    kind: "Dataset",
    title: "Inflasi Menurut Kelompok Pengeluaran",
    meta: "Seri Waktu · 2022–2026",
  },
  {
    kind: "Publikasi",
    title: "Berita Resmi Statistik — Inflasi",
    meta: "Bulanan · Demo Reference",
  },
];

const SOURCE_SURVEI: Source[] = [
  {
    kind: "Dokumen",
    title: "Pedoman Survei Sosial Ekonomi 2026",
    meta: "86 halaman · Metodologi",
  },
  {
    kind: "Dokumen",
    title: "Metodologi Statistik",
    meta: "132 halaman · Referensi",
  },
];

const SOURCE_PENDUDUK: Source[] = [
  {
    kind: "Dataset",
    title: "Jumlah Penduduk Menurut Kabupaten/Kota",
    meta: "Proyeksi · 2020–2025",
  },
  {
    kind: "Publikasi",
    title: "Statistik Kependudukan Indonesia",
    meta: "Tahunan · Demo Reference",
  },
];

export const quickPromptAnswers: Record<string, AiAnswer> = {
  "analisis-statistik": {
    text: "Berdasarkan data statistik yang tersedia, berikut adalah analisis tren utama dari dataset BPS Kalimantan Tengah. Pertumbuhan ekonomi menunjukkan pemulihan pasca-pandemi, dengan laju tertinggi pada tahun 2022.",
    blocks: ["kpi", "line"],
    insight:
      "Indikator utama menunjukkan tren positif untuk sebagian besar variabel sosial-ekonomi di Kalimantan Tengah selama 5 tahun terakhir.",
    sources: SOURCE_PDRB,
  },
  "konsep-statistik": {
    text: 'Statistik adalah ilmu yang berkaitan dengan pengumpulan, pengolahan, analisis, daninterpretasi data. Dalam konteks BPS, statistik digunakan untuk mengukur kondisi sosial-ekonomi penduduk seperti tingkat kemiskinan, pertumbuhan ekonomi, dan indeks pembangunan manusia.\n\nBeberapa konsep dasar yang perlu dipahami:\n\n• Populasi adalah seluruh individu atau objek yang menjadi sasaran pengamatan.\n• Sampel adalah bagian dari populasi yang dipilih untuk diobservasi.\n• Variabel adalah karakteristik yang diukur dari setiap unit observasi.\n• Ukuran tendensi sentral (mean, median, modus) menggambarkan nilai "pusat" dari data.\n• Ukuran penyebaran (standar deviasi, rentang) menunjukkan seberapa tersebarnya data.',
    blocks: [],
    insight:
      "Pemahaman konsep statistik sangat penting bagi pegawai BPS dalam menyusun dan menyajikan data kepada publik secara akurat.",
    sources: SOURCE_GENERAL,
  },
  "cari-informasi": {
    text: "Saya membantu Anda menemukan informasi yang relevan dari sumber data BPS. Berikut dataset yang tersedia terkait topik umum di wilayah Kalimantan Tengah.",
    blocks: ["dataset"],
    insight:
      "Anda dapat memilih dataset di atas untuk melakukan analisis lebih lanjut atau mengeksplorasi variabel spesifik.",
    sources: SOURCE_POVERTY,
  },
  "bantu-pekerjaan": {
    text: "Saya dapat membantu menyusun ringkasan atau draft berdasarkan informasi yang Anda berikan. Berikut adalah ringkasan otomatis dari data utama yang sedang Anda telaah.",
    blocks: ["summary"],
    insight:
      "Ringkasan ini bersifat demonstratif. Dalam penggunaan nyata, Anda dapat menyesuaikan konten dengan data aktual dari BPS.",
    sources: SOURCE_PDRB,
  },
};

export const suggestedQuestions = [
  "Bagaimana cara menjelaskan pertumbuhan ekonomi kepada masyarakat awam?",
  "Apa perbedaan inflasi dan pertumbuhan ekonomi?",
  "Cari data kemiskinan Kalimantan Tengah.",
  "Apa itu metode survei SUSENAS?",
  "Bagaimana tren jumlah penduduk di Kalimantan Tengah?",
];

export function answerFor(question: string): AiAnswer {
  const q = question.toLowerCase();

  // Scenario 1: Growth explanation for laypeople
  if (q.includes("menjelaskan") && q.includes("pertumbuhan") && q.includes("masyarakat")) {
    return {
      text: "Pertumbuhan ekonomi secara sederhana dapat dipahami sebagai peningkatan aktivitas ekonomi suatu wilayah dari waktu ke waktu. Jika nilai barang dan jasa yang dihasilkan meningkat dibandingkan periode sebelumnya, maka perekonomian dikatakan mengalami pertumbuhan.\n\nDalam konteks Kalimantan Tengah, pertumbuhan ekonomi diukur berdasarkan perubahan Produk Domestik Regional Bruto (PDRB). Pada tahun 2025, pertumbuhan ekonomi Kalimantan Tengah mencapai 5,42%, yang menunjukkan peningkatan dibandingkan tahun sebelumnya.",
      blocks: ["kpi", "line"],
      insight: "Ekonomi tumbuh ketika aktivitas produksi barang dan jasa meningkat.",
      sources: SOURCE_PDRB,
    };
  }

  // Scenario 2: Inflation vs growth
  if (q.includes("perbedaan") && q.includes("inflasi")) {
    return {
      text: "Inflasi dan pertumbuhan ekonomi adalah dua indikator yang berbeda namun saling berkaitan.\n\nInflasi mengacu pada kenaikan harga barang dan jasa secara umum dari waktu ke waktu. Sementara pertumbuhan ekonomi mengacu pada peningkatan total output (barang dan jasa) yang dihasilkan oleh suatu perekonomian.",
      blocks: ["kpi"],
      insight:
        "Meskipun keduanya mengukur aspek yang berbeda, inflasi yang terkendali umumnya kondusif bagi pertumbuhan ekonomi yang berkelanjutan.",
      sources: SOURCE_INFLASI,
    };
  }

  // Scenario 3: Poverty search
  if (q.includes("cari") && q.includes("kemiskinan")) {
    return {
      text: "Saya menemukan 1 dataset yang paling relevan dengan permintaan Anda pada wilayah Kalimantan Tengah.",
      blocks: ["dataset"],
      insight:
        "Dataset ini mencakup 14 kabupaten/kota dengan periode 2020–2025 dan dapat langsung dianalisis.",
      sources: SOURCE_POVERTY,
    };
  }

  // Scenario 4: Poverty comparison
  if (q.includes("banding") || (q.includes("kemiskinan") && q.includes("2020"))) {
    return {
      text: "Berikut perbandingan tingkat kemiskinan Kalimantan Tengah pada periode 2020–2025.",
      blocks: ["kpi", "area"],
      insight:
        "Tingkat kemiskinan menurun konsisten sepanjang periode, dengan penurunan tahunan terbesar terjadi pada 2023.",
      sources: SOURCE_POVERTY,
    };
  }

  // Scenario 5: Regional movers
  if (q.includes("wilayah") || q.includes("terbesar") || q.includes("mover")) {
    return {
      text: "Berikut wilayah dengan perubahan terbesar pada periode yang dipilih.",
      blocks: ["table", "bar"],
      insight:
        "Kotawaringin Timur mencatat perubahan terbesar sebesar -1,23 poin dan ditandai pada visualisasi.",
      sources: SOURCE_POVERTY,
    };
  }

  // Scenario 6: Summary/brief
  if (q.includes("ringkas") || q.includes("summary") || q.includes("brief")) {
    return {
      text: "Berikut ringkasan yang saya susun dari data yang sedang Anda telaah.",
      blocks: ["summary"],
      sources: SOURCE_PDRB,
    };
  }

  // Scenario 7: Growth/economy queries
  if (q.includes("ekonomi") || q.includes("pdrb") || q.includes("pertumbuhan")) {
    return {
      text: "Berdasarkan data yang tersedia, berikut ringkasan perkembangan pertumbuhan ekonomi pada periode yang dipilih.",
      blocks: ["kpi", "line"],
      insight:
        "Pertumbuhan menunjukkan perubahan pada beberapa periode. Periode dengan perubahan terbesar ditandai pada visualisasi.",
      sources: SOURCE_PDRB,
    };
  }

  // Scenario 8: Survey methodology
  if (q.includes("survei") || q.includes("metode") || q.includes("susenas")) {
    return {
      text: "Survei SUSENAS (Survei Sosial Ekonomi Nasional) adalah survei yang dilakukan oleh BPS secara berkala untuk mengumpulkan data sosial-ekonomi penduduk Indonesia.\n\nMetodologi survei meliputi:\n• Desain sampel berlapis bertingkat (stratified multistage cluster sampling)\n• Pengumpulan data melalui wawancara langsung\n• Pengolahan data menggunakan sistem tabulasi otomatis\n• Validasi dan verifikasi data di tingkat kabupaten/kota",
      blocks: [],
      insight:
        "Pedoman lengkap survei SUSENAS tersedia dalam dokumen Pedoman Survei 2026 yang dapat diakses oleh pegawai BPS.",
      sources: SOURCE_SURVEI,
    };
  }

  // Scenario 9: Population trends
  if (q.includes("penduduk") || q.includes("jumlah")) {
    return {
      text: "Berdasarkan data proyeksi penduduk BPS, jumlah penduduk Kalimantan Tengah menunjukkan tren peningkatan moderat selama 5 tahun terakhir. Distribusi penduduk masih terpusat di wilayah perkotaan, khususnya Palangka Raya dan Kotawaringin Timur.",
      blocks: ["kpi"],
      insight:
        "Proyeksi jumlah penduduk merupakan dasar perencanaan pembangunan daerah di tingkat provinsi dan kabupaten/kota.",
      sources: SOURCE_PENDUDUK,
    };
  }

  // Scenario 10: Follow-up with "Ya"
  if (q.includes("ya, berikan contoh") || q.includes("berikan contoh")) {
    return {
      text: "Tentu, berikut contoh sederhananya:\n\nBayangkan sebuah desa yang tahun lalu menghasilkan 100 ton padi. Tahun ini, desa yang sama berhasil menghasilkan 110 ton padi. Karena total produksi meningkat, maka perekonomian desa tersebut mengalami pertumbuhan sebesar 10%.\n\nDalam skala nasional, BPS mengukur pertumbuhan ekonomi menggunakan PDRB (Produk Domestik Bruto) yang mencakup seluruh nilai barang dan jasa yang diproduksi di Indonesia selama periode tertentu.",
      blocks: [],
      insight:
        "Pertumbuhan ekonomi tidak selalu berarti harga naik — yang terjadi adalah jumlah barang dan jasa yang diproduksi meningkat.",
      sources: SOURCE_PDRB,
    };
  }

  // Scenario 11: Simplify explanation
  if (q.includes("lebih sederhana") || q.includes("sederhanakan")) {
    return {
      text: "Singkatnya:\n\n• Pertumbuhan ekonomi = ada lebih banyak barang dan jasa yang diproduksi.\n• Inflasi = harga barang dan jasa naik.\n\nKalau ekonomi tumbuh, berarti orang-orang di daerah itu semakin produktif. Kalau inflasi naik, berarti uang kamu bisa beli lebih sedikit barang dari sebelumnya.\n\nIdealnya, pertumbuhan ekonomi lebih tinggi dari inflasi — ini berarti daya beli masyarakat tetap terjaga.",
      blocks: [],
      sources: SOURCE_GENERAL,
    };
  }

  // Fallback: uncertainty response
  return {
    text: "Maaf, saya belum memiliki informasi yang cukup untuk menjawab pertanyaan tersebut dengan detail.\n\nCoba berikan konteks atau sumber tambahan, atau ajukan pertanyaan yang lebih spesifik mengenai topik data, statistik, atau metodologi BPS.",
    blocks: [],
    insight:
      "Untuk pertanyaan yang sangat spesifik, Anda dapat menghubungi unit terkait di BPS provinsi atau kabupaten/kota.",
    sources: [],
  };
}

export const answerData = {
  growthSeries,
  povertySeries,
  regionMovers,
  povertyDataset: datasets.find((d) => d.id === "kemiskinan-kalteng")!,
};

export const loadingStages = [
  "Memahami pertanyaan...",
  "Menyusun jawaban...",
  "Menyiapkan sumber...",
];

// Preset conversations for sidebar history
const makeUserMsg = (text: string): ChatMessage => ({
  id: `u-${Math.random().toString(36).slice(2)}`,
  role: "user",
  text,
  createdAt: Date.now(),
});

const makeAiMsg = (answer: AiAnswer): ChatMessage => ({
  id: `a-${Math.random().toString(36).slice(2)}`,
  role: "assistant",
  answer,
  createdAt: Date.now(),
});

export const presetConversations: Record<string, ChatMessage[]> = {
  "pertumbuhan-ekonomi": [
    makeUserMsg("Bagaimana cara menjelaskan pertumbuhan ekonomi kepada masyarakat awam?"),
    makeAiMsg(answerFor("menjelaskan pertumbuhan ekonomi masyarakat")),
    makeUserMsg("Ya, berikan contoh"),
    makeAiMsg(answerFor("ya, berikan contoh")),
  ],
  "data-kemiskinan": [
    makeUserMsg("Cari data kemiskinan Kalimantan Tengah."),
    makeAiMsg(answerFor("cari data kemiskinan Kalimantan Tengah")),
  ],
  inflasi: [
    makeUserMsg("Apa perbedaan inflasi dan pertumbuhan ekonomi?"),
    makeAiMsg(answerFor("perbedaan inflasi dan pertumbuhan")),
  ],
  "metodologi-survei": [
    makeUserMsg("Apa itu metode survei SUSENAS?"),
    makeAiMsg(answerFor("metode survei SUSENAS")),
  ],
  "statistik-penduduk": [
    makeUserMsg("Bagaimana tren jumlah penduduk di Kalimantan Tengah?"),
    makeAiMsg(answerFor("tren jumlah penduduk")),
  ],
};
