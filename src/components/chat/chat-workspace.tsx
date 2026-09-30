import { BpsMark } from "@/components/bps-logo";
import { ChartCard, GrowthLineChart, MoversBarChart, PovertyAreaChart } from "@/components/charts";
import { DemoBadge, SourceCard, StatisticCard, TrustNote } from "@/components/common";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import type { AiAnswer, ChatMessage } from "@/hooks/use-chat";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";
import {
    ArrowDown,
    Check,
    Copy,
    Mic,
    Moon,
    Paperclip,
    RefreshCw,
    Search,
    SendHorizontal,
    Sun,
    ThumbsDown,
    ThumbsUp,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AiBlockRenderer } from "./ai-blocks";
import { answerData } from "./mock-engine";

/* ─── Quick Prompt Definitions ─── */
const quickPrompts = [
  {
    id: "analisis-statistik",
    emoji: "📊",
    title: "Analisis data statistik",
    description: "Jelaskan tren dari data yang saya berikan.",
  },
  {
    id: "konsep-statistik",
    emoji: "📚",
    title: "Jelaskan konsep statistik",
    description: "Jelaskan konsep statistik dengan bahasa sederhana.",
  },
  {
    id: "cari-informasi",
    emoji: "🔎",
    title: "Cari informasi BPS",
    description: "Bantu saya menemukan informasi yang relevan.",
  },
  {
    id: "bantu-pekerjaan",
    emoji: "📝",
    title: "Bantu pekerjaan saya",
    description: "Buat ringkasan atau draft berdasarkan informasi yang saya berikan.",
  },
];

/* ─── Chat Workspace ─── */
export function ChatWorkspace({
  messages,
  stage,
  loadingStageText,
  onSend,
  onFileUpload,
}: {
  messages: ChatMessage[];
  stage: number | null;
  loadingStageText: string | null;
  onSend: (text: string) => void;
  onFileUpload?: (file: File, message?: string) => void;
}) {
  const [input, setInput] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isCompact, setIsCompact] = useState(false);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastScrollTop = useRef(0);
  const scrollTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafId = useRef<number>(0);

  const { theme, toggle: toggleTheme } = useTheme();

  useEffect(() => {
    // Only auto-scroll if user is already near bottom
    if (isNearBottom) {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, stage]);

  const scrollToBottom = useCallback(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, []);

  const handleScroll = useCallback(() => {
    if (rafId.current) return;
    rafId.current = requestAnimationFrame(() => {
      rafId.current = 0;
      const el = scrollRef.current;
      if (!el) return;

      const scrollTop = el.scrollTop;
      const delta = scrollTop - lastScrollTop.current;
      const atTop = scrollTop <= 5;
      const atBottom = scrollTop + el.clientHeight >= el.scrollHeight - 150;
      const atVeryBottom = scrollTop + el.clientHeight >= el.scrollHeight - 5;

      // Near bottom threshold: 150px from bottom
      setIsNearBottom(atVeryBottom);

      // Only react if scrolled more than 25px (avoid micro-jitter)
      if (Math.abs(delta) > 25) {
        if (delta > 0 && !atTop && !atBottom) {
          setIsCompact(true);
        } else if (delta < 0 || atTop || atBottom) {
          setIsCompact(false);
        }
        lastScrollTop.current = scrollTop;
      } else if (atTop || atVeryBottom) {
        setIsCompact(false);
        lastScrollTop.current = scrollTop;
      }

      if (scrollTimeout.current) clearTimeout(scrollTimeout.current);
      scrollTimeout.current = setTimeout(() => setIsCompact(false), 1500);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (scrollTimeout.current) clearTimeout(scrollTimeout.current);
      if (rafId.current) cancelAnimationFrame(rafId.current);
    };
  }, []);

  const handleSend = (text?: string) => {
    const msg = (text ?? input).trim();
    if (!msg) return;
    setInput("");
    setIsCompact(false);
    onSend(msg);
  };

  const handleQuickPrompt = (promptId: string) => {
    const prompt = quickPrompts.find((p) => p.id === promptId);
    if (prompt) {
      setInput(prompt.title);
      handleSend(prompt.title);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* ── Chat Header ── */}
      <header
        className={cn(
          "flex flex-wrap items-center border-b bg-surface/85 backdrop-blur transition-all duration-300 ease-in-out",
          isCompact ? "px-3 py-1.5 gap-2" : "justify-between gap-3 px-4 py-3",
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <SidebarTrigger />
          <div className="min-w-0">
            <h1
              className={cn(
                "font-semibold tracking-tight transition-all duration-300",
                isCompact ? "text-[13px]" : "text-[15px]",
              )}
            >
              BPS AI Assistant
            </h1>
            {!isCompact && (
              <p className="text-[12px] text-muted-foreground">
                AI Assistant • Internal Workspace
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "transition-all duration-300",
              isCompact ? "h-7 w-7" : "h-9 w-9",
            )}
            onClick={toggleTheme}
            title={theme === "dark" ? "Mode Terang" : "Mode Gelap"}
          >
            {theme === "dark" ? (
              <Sun className="h-4 w-4 text-bps-blue" />
            ) : (
              <Moon className="h-4 w-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "transition-all duration-300",
              isCompact ? "h-7 w-7" : "h-9 w-9",
            )}
            onClick={() => setSearchOpen(!searchOpen)}
          >
            <Search className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {/* ── Search Bar (collapsible) ── */}
      {searchOpen && (
        <div className="border-b bg-surface px-4 py-2.5 animate-fade-up sm:px-6">
          <div className="mx-auto max-w-3xl">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Cari dalam percakapan..."
                className="w-full rounded-lg border bg-background py-2 pl-9 pr-3 text-sm outline-none focus:border-bps-blue"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setSearchOpen(false);
                    setSearchQuery("");
                  }
                }}
              />
            </div>

            {/* Search Results — clickable to jump to the message */}
            {searchQuery && (
              <div className="mt-2">
                {(() => {
                  const matched = messages.filter((m) => {
                    const text = m.role === "user" ? m.text : m.answer?.text || "";
                    return text.toLowerCase().includes(searchQuery.toLowerCase());
                  });
                  const count = matched.length;

                  const jumpTo = (id: string) => {
                    const el = document.getElementById(`msg-${id}`);
                    el?.scrollIntoView({ behavior: "smooth", block: "center" });
                    // Flash highlight on the selected message
                    el?.classList.add("search-flash");
                    setTimeout(() => el?.classList.remove("search-flash"), 1600);
                  };

                  return count === 0 ? (
                    <span className="text-xs text-muted-foreground">
                      Tidak ada pesan yang cocok
                    </span>
                  ) : (
                    <div className="space-y-1">
                      <div className="text-xs text-muted-foreground">
                        Ditemukan <span className="font-semibold text-foreground">{count}</span> pesan yang cocok
                      </div>
                      <div className="max-h-48 overflow-y-auto rounded-lg border bg-background p-1.5">
                        {matched.map((m) => {
                          const snippet = m.role === "user" ? m.text : m.answer?.text || "";
                          const idx = snippet.toLowerCase().indexOf(searchQuery.toLowerCase());
                          const before = snippet.slice(0, Math.max(0, idx));
                          const hit = snippet.slice(idx, idx + searchQuery.length);
                          const after = snippet.slice(idx + searchQuery.length);
                          return (
                            <button
                              key={m.id}
                              onClick={() => jumpTo(m.id)}
                              className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted"
                            >
                              <span
                                className={cn(
                                  "mt-0.5 shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold uppercase",
                                  m.role === "user"
                                    ? "bg-bps-blue-soft text-bps-blue"
                                    : "bg-bps-green-soft text-bps-green",
                                )}
                              >
                                {m.role === "user" ? "Anda" : "AI"}
                              </span>
                              <span className="min-w-0 truncate text-[13px] text-muted-foreground">
                                {idx <= 0 ? "" : "…"}
                                {before.slice(before.length - 24)}
                                <span className="rounded bg-yellow-200/50 px-0.5 font-medium text-yellow-900 dark:bg-yellow-800/50 dark:text-yellow-200">
                                  {hit}
                                </span>
                                {after.slice(0, 40)}
                                {after.length > 40 ? "…" : ""}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Main Chat Area ── */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto px-4 py-6 sm:px-6"
        >
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            {messages.length === 0 && <WelcomeState onQuickPrompt={handleQuickPrompt} />}

            {messages.map((m, i) =>
              m.role === "user" ? (
                <UserMessage key={m.id} id={m.id} text={m.text} index={i} searchQuery={searchQuery} createdAt={m.createdAt} />
              ) : (
                <AssistantMessage key={m.id} id={m.id} answer={m.answer} index={i} searchQuery={searchQuery} onSend={handleSend} createdAt={m.createdAt} />
              ),
            )}

            {stage !== null && (
              <div className="animate-fade-in flex items-center gap-3 pl-11">
                <div className="flex items-center gap-1.5">
                  <span className="typing-dot" />
                  <span className="typing-dot" style={{ animationDelay: "0.15s" }} />
                  <span className="typing-dot" style={{ animationDelay: "0.3s" }} />
                </div>
                <div className="flex flex-col">
                  <span className="text-[13px] font-medium text-foreground">{loadingStageText}</span>
                  <span className="text-[11px] text-muted-foreground">{stage === 0 ? 'Mengirim ke AI...' : stage === 1 ? 'Memproses permintaan...' : 'Menyusun jawaban...'}</span>
                </div>
                <div className="ml-2 flex gap-1">
                  {[0, 1, 2].map((s) => (
                    <div key={s} className={`h-1.5 rounded-full transition-all duration-500 ${s <= stage ? 'w-6 bg-bps-blue' : 'w-1.5 bg-muted'}`} />
                  ))}
                </div>
              </div>
            )}

            <div ref={endRef} />
          </div>
        </div>

        {/* Scroll-to-bottom FAB */}
        {!isNearBottom && (
          <button
            onClick={scrollToBottom}
            className="absolute bottom-4 left-1/2 z-10 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border bg-background/90 shadow-lg backdrop-blur-sm transition-all hover:bg-muted animate-fade-in"
            title="Scroll ke bawah"
          >
            <ArrowDown className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* ── Composer ── */}
      <Composer
        input={input}
        setInput={setInput}
        onSend={handleSend}
        onFileUpload={onFileUpload}
        onKeyDown={handleKeyDown}
        disabled={stage !== null}
        isCompact={isCompact}
      />
    </div>
  );
}

/* ─── Welcome State ─── */
function WelcomeState({ onQuickPrompt }: { onQuickPrompt: (id: string) => void }) {
  const steps = [
    { num: "1", label: "Pilih topik", desc: "Mulai dengan pertanyaan atau topik pekerjaan" },
    { num: "2", label: "Analisis data", desc: "AI menganalisis dan menyajikan hasilnya" },
    { num: "3", label: "Jelajahi lebih dalam", desc: "Klik saran pertanyaan untuk eksplorasi lanjutan" },
  ];

  return (
    <div className="flex flex-col items-center py-12 text-center">
      <BpsMark className="h-12 w-12 opacity-80" />
      <h2 className="mt-5 text-2xl font-semibold tracking-tight text-foreground">
        Selamat datang 👋
      </h2>
      <p className="mt-2 text-base text-foreground/80">
        Bagaimana saya dapat membantu pekerjaan Anda hari ini?
      </p>
      <p className="mt-1.5 max-w-md text-[14px] leading-relaxed text-muted-foreground">
        Tanyakan tentang data, statistik, metodologi, atau pekerjaan Anda.
      </p>

      {/* Flow Steps */}
      <div className="mt-8 flex items-center gap-3 sm:gap-6">
        {steps.map((step, i) => (
          <div key={step.num} className="flex items-center gap-2 sm:gap-3">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bps-blue/10 text-[12px] font-bold text-bps-blue">
              {step.num}
            </div>
            <div className="text-left">
              <div className="text-[13px] font-medium text-foreground">{step.label}</div>
              <div className="hidden text-[11px] text-muted-foreground sm:block">{step.desc}</div>
            </div>
            {i < steps.length - 1 && (
              <div className="ml-1 hidden h-px w-6 bg-border sm:block" />
            )}
          </div>
        ))}
      </div>

      {/* Quick Prompts */}
      <div className="mt-8 grid w-full max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
        {quickPrompts.map((prompt, i) => (
          <button
            key={prompt.id}
            onClick={() => onQuickPrompt(prompt.id)}
            className="animate-card-in group flex items-start gap-3.5 rounded-xl border bg-surface p-4 text-left transition-all hover:border-bps-blue/40 hover:bg-bps-blue-soft/30 hover:shadow-sm"
            style={{ animationDelay: `${i * 80}ms` }}
          >
            <span className="mt-0.5 text-xl">{prompt.emoji}</span>
            <div className="min-w-0">
              <div className="text-[14px] font-medium text-foreground group-hover:text-bps-blue">
                {prompt.title}
              </div>
              <div className="mt-0.5 text-[13px] leading-snug text-muted-foreground">
                {prompt.description}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ─── User Message ─── */
function UserMessage({ id, text, index, searchQuery, createdAt }: { id: string; text: string; index: number; searchQuery?: string; createdAt: number }) {
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);

  const highlightText = (t: string) => {
    if (!searchQuery) return t;
    const regex = new RegExp(`(${searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    const parts = t.split(regex);
    return parts.map((part, i) =>
      regex.test(part) ? (
        <span key={i} className="bg-yellow-200/50 text-yellow-900 dark:bg-yellow-800/50 dark:text-yellow-200 rounded px-0.5">{part}</span>
      ) : part
    );
  };

  return (
    <div id={`msg-${id}`} className="animate-msg-in flex justify-end scroll-mt-20" style={{ animationDelay: `${index * 50}ms` }}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <div className="flex items-end gap-2">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-bps-blue-soft/80 px-4 py-2.5 text-[14px] leading-relaxed text-bps-blue-deep">
          {highlightText(text)}
        </div>
        {hovered && (
          <button onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
            className="shrink-0 rounded-md border bg-background p-1.5 text-muted-foreground shadow-sm transition-all hover:text-foreground" title="Salin">
            {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>
      <span className="mt-1 text-right text-[10px] text-muted-foreground/60">{new Date(createdAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</span>
    </div>
  );
}

/* ─── Assistant Message ─── */
function AssistantMessage({ id, answer, index, searchQuery, onSend, createdAt }: { id: string; answer: AiAnswer; index: number; searchQuery?: string; onSend?: (text: string) => void; createdAt: number }) {
  const [copied, setCopied] = useState(false);
  const [vote, setVote] = useState<"up" | "down" | null>(null);

  const highlightText = (t: string) => {
    if (!searchQuery) return t;
    const regex = new RegExp(`(${searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    const parts = t.split(regex);
    return parts.map((part, i) =>
      regex.test(part) ? (
        <span key={i} className="bg-yellow-200/50 text-yellow-900 dark:bg-yellow-800/50 dark:text-yellow-200 rounded px-0.5">{part}</span>
      ) : part
    );
  };

  return (
    <div id={`msg-${id}`} className="animate-msg-in flex gap-3 scroll-mt-20" style={{ animationDelay: `${index * 50}ms` }}>
      <BpsMark className="mt-0.5 h-8 w-8 shrink-0" />
      <div className="min-w-0 flex-1 space-y-4">
        {/* Label */}
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-foreground">BPS AI Assistant</span>
        </div>

        {/* Text Content — supports charts, images, files, embeds, tables */}
        <div className="text-[14px] leading-relaxed text-foreground/85">
          <AiBlockRenderer text={answer.text} />
        </div>

        {/* KPI Cards */}
        {answer.blocks.includes("kpi") && (
          <div className="grid gap-3 sm:grid-cols-2">
            <StatisticCard label="Pertumbuhan Ekonomi" value="5,42%" delta="+0,62" tone="green" />
            <StatisticCard label="Rata-rata 5 Tahun" value="4,76%" delta="stabil" tone="blue" />
          </div>
        )}

        {/* Charts */}
        {answer.blocks.includes("line") && (
          <ChartCard title="Pertumbuhan Ekonomi 2020–2025" subtitle="Persen (y-on-y)">
            <GrowthLineChart data={answerData.growthSeries} />
          </ChartCard>
        )}

        {answer.blocks.includes("area") && (
          <ChartCard title="Tingkat Kemiskinan 2020–2025" subtitle="Persen penduduk miskin">
            <PovertyAreaChart data={answerData.povertySeries} />
          </ChartCard>
        )}

        {answer.blocks.includes("bar") && (
          <ChartCard title="Perubahan Terbesar per Wilayah" subtitle="Selisih poin 2020 → 2025">
            <MoversBarChart data={answerData.regionMovers} />
          </ChartCard>
        )}

        {answer.blocks.includes("table") && <MoversTable />}
        {answer.blocks.includes("dataset") && <InlineDatasetCard />}
        {answer.blocks.includes("summary") && <SummaryBlock />}

        {/* Insight Box */}
        {answer.insight && (
          <div className="rounded-xl border border-bps-blue/20 bg-bps-blue-soft/50 p-4">
            <div className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-bps-blue">
              <span>💡</span>
              <span>Ringkasnya</span>
            </div>
            <p className="mt-1.5 text-[14px] leading-relaxed text-foreground/80">
              {answer.insight}
            </p>
          </div>
        )}

        {/* Sources */}
        {answer.sources.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
              <span>📚</span>
              <span>Sources & References</span>
            </div>
            {answer.sources.map((s) => (
              <SourceCard key={s.title} {...s} />
            ))}
            <TrustNote />
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-1 pt-1">
          <ActionBtn
            icon={copied ? Check : Copy}
            label={copied ? "Disalin" : "Copy"}
            onClick={() => {
              void navigator.clipboard.writeText(answer.text).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          />
          <ActionBtn
            icon={ThumbsUp}
            label="Helpful"
            active={vote === "up"}
            onClick={() => setVote("up")}
          />
          <ActionBtn
            icon={ThumbsDown}
            label="Not helpful"
            active={vote === "down"}
            onClick={() => setVote("down")}
          />
          <ActionBtn
            icon={RefreshCw}
            label="Regenerate"
            onClick={() => toast("Demo: jawaban akan dibuat ulang.")}
          />
        </div>

        {/* Follow-up Suggestions */}
        {answer.suggestions && answer.suggestions.length > 0 && onSend && (
          <FollowUpSuggestions suggestions={answer.suggestions} onSend={onSend} />
        )}

        {/* Timestamp */}
        <div className="text-[10px] text-muted-foreground/60">
          {new Date(createdAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
    </div>
  );
}

/* ─── Follow-up Suggestions ─── */
function FollowUpSuggestions({ suggestions, onSend }: { suggestions: string[]; onSend: (text: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      {suggestions.map((s, i) => (
        <button
          key={i}
          onClick={() => onSend(s)}
          className="animate-card-in group flex items-center gap-1.5 rounded-lg border border-dashed bg-surface px-3 py-1.5 text-[13px] text-muted-foreground transition-all hover:border-bps-blue/40 hover:bg-bps-blue-soft/20 hover:text-bps-blue"
          style={{ animationDelay: `${i * 60}ms` }}
        >
          <span className="opacity-50 group-hover:opacity-100">→</span>
          <span>{s}</span>
        </button>
      ))}
    </div>
  );
}

/* ─── Composer ─── */
function Composer({
  input,
  setInput,
  onSend,
  onFileUpload,
  onKeyDown,
  disabled,
  isCompact,
}: {
  input: string;
  setInput: (v: string) => void;
  onSend: (text?: string) => void;
  onFileUpload?: (file: File, message?: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  disabled: boolean;
  isCompact: boolean;
}) {
  const handleFileSelect = () => {
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".csv,.xlsx,.xls,.png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.json";
    fileInput.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      if (onFileUpload) {
        onFileUpload(file, input.trim() || undefined);
        setInput("");
      } else {
        toast(`"${file.name}" dipilih — upload belum terhubung ke API.`);
      }
    };
    fileInput.click();
  };

  return (
    <div
      className={cn(
        "border-t bg-surface transition-all duration-300 ease-in-out",
        isCompact ? "px-4 py-2 sm:px-6" : "px-4 py-4 sm:px-6",
      )}
    >
      <div className="mx-auto w-full max-w-3xl">
        <div className="rounded-xl border bg-background p-2 transition-colors focus-within:border-bps-blue focus-within:shadow-[0_0_0_1px_var(--bps-blue)]">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Tanyakan apa saja tentang pekerjaan Anda..."
            disabled={disabled}
            className={cn(
              "resize-none border-0 bg-transparent px-2 shadow-none focus-visible:ring-0 transition-all duration-300",
              isCompact ? "min-h-[40px] text-[13px]" : "min-h-[52px] text-[14px]",
            )}
          />
          <div className="flex items-center justify-between px-1 pt-1">
            {!isCompact && (
            <div className="flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => {
                  toast("Voice input belum aktif.");
                }}
              >
                <Mic className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={handleFileSelect}
                title="Lampirkan file atau gambar"
              >
                <Paperclip className="h-4 w-4" />
              </Button>
            </div>
          )}
            <Button
              size="sm"
              onClick={() => onSend()}
              disabled={disabled || !input.trim()}
              className={cn(
                "rounded-lg bg-bps-blue hover:bg-bps-blue/90 transition-all duration-300",
                isCompact ? "px-3 h-8" : "px-3.5",
              )}
            >
              <SendHorizontal className="h-4 w-4" />
            </Button>
          </div>
        </div>
        {!isCompact && (
          <p className="mt-2 text-center text-[11px] text-muted-foreground">
            <kbd className="rounded border bg-muted px-1 py-0.5 text-[10px]">Enter</kbd> kirim · <kbd className="rounded border bg-muted px-1 py-0.5 text-[10px]">Shift+Enter</kbd> baris baru · AI dapat membuat kesalahan
          </p>
        )}
      </div>
    </div>
  );
}

/* ─── Action Button ─── */
function ActionBtn({
  icon: Icon,
  label,
  onClick,
  active,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        active && "bg-bps-blue-soft text-bps-blue",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

/* ─── Movers Table ─── */
function MoversTable() {
  const min = Math.min(...answerData.regionMovers.map((r) => r.delta));
  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <span className="text-[14px] font-semibold">Perubahan Menurut Wilayah</span>
        <DemoBadge full />
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Wilayah</TableHead>
              <TableHead className="text-right">2020</TableHead>
              <TableHead className="text-right">2025</TableHead>
              <TableHead className="text-right">Perubahan</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {answerData.regionMovers.map((r) => (
              <TableRow key={r.region} className={cn(r.delta === min && "bg-bps-blue-soft/60")}>
                <TableCell className="font-medium">{r.region}</TableCell>
                <TableCell className="text-right tabular-nums">{r.y2020.toFixed(2)}</TableCell>
                <TableCell className="text-right tabular-nums">{r.y2025.toFixed(2)}</TableCell>
                <TableCell className="text-right font-medium tabular-nums text-bps-green">
                  {r.delta.toFixed(2)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/* ─── Inline Dataset Card ─── */
function InlineDatasetCard() {
  const d = answerData.povertyDataset;
  return (
    <div className="panel hover-lift p-5">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-bps-blue">
        {d.code}
      </div>
      <h4 className="mt-1 text-[15px] font-semibold">{d.title}</h4>
      <p className="mt-1.5 text-[13px] text-muted-foreground">{d.description}</p>
      <div className="mt-3 flex flex-wrap gap-2 text-[12px] text-muted-foreground">
        <span className="rounded-md border bg-surface-2 px-2 py-0.5">{d.period}</span>
        <span className="rounded-md border bg-surface-2 px-2 py-0.5">{d.region}</span>
        <span className="rounded-md border bg-surface-2 px-2 py-0.5">{d.variables} variabel</span>
      </div>
    </div>
  );
}

/* ─── Summary Block ─── */
function SummaryBlock() {
  return (
    <div className="panel space-y-3 p-5">
      <div className="flex items-center justify-between">
        <h4 className="text-[15px] font-semibold">Ringkasan AI</h4>
        <DemoBadge full />
      </div>
      <ul className="space-y-2 text-[13px] leading-relaxed text-muted-foreground">
        <li>• Tingkat kemiskinan turun dari 5,26% (2020) menjadi 4,52% (2025).</li>
        <li>• Penurunan tercatat pada seluruh 14 kabupaten/kota yang diamati.</li>
        <li>• Kotawaringin Timur mencatat penurunan terbesar (-1,23 poin).</li>
        <li>• Pertumbuhan ekonomi pada periode yang sama mencapai 5,42% pada 2025.</li>
      </ul>
    </div>
  );
}
