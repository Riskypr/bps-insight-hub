import { api, parseSSEStream } from "@/lib/api";
import { useCallback, useRef, useState } from "react";

export type AiAnswer = {
  text: string;
  blocks: string[];
  insight?: string | undefined;
  sources: {
    kind: string;
    title: string;
    meta: string;
    link?: string | undefined;
    rawScore?: number | null | undefined;
    pages?: string[] | undefined;
    citedPages?: string[] | undefined;
  }[];
  suggestions?: string[] | undefined;
  warning?: string | null | undefined;
  note?: string | null | undefined;
  featuredImage?: { url: string; page?: string | undefined; title?: string | undefined } | null | undefined;
  mode?: string | undefined;
};

export type ChatMessage =
  | { id: string; role: "user"; text: string; attachment?: { name: string; type: string } | undefined; createdAt: number }
  | { id: string; role: "assistant"; answer: AiAnswer; createdAt: number };

export type ConversationItem = {
  id: string;
  title: string;
  createdAt: number;
};

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

/** Extract follow-up suggestions from AI text (lines starting with `- ` at the end) */
function extractSuggestions(text: string): { cleanText: string; suggestions: string[] } {
  const lines = text.split("\n");
  const suggestions: string[] = [];
  let i = lines.length - 1;

  // Walk backwards from end, collect `- ` prefixed lines
  while (i >= 0) {
    const line = lines[i];
    if (line !== undefined && /^\s*-\s+/.test(line)) {
      suggestions.unshift(line.replace(/^\s*-\s+/, "").trim());
      i--;
    } else {
      break;
    }
  }

  // Remove the suggestion lines from text
  const cleanText = suggestions.length > 0 ? lines.slice(0, i + 1).join("\n").trimEnd() : text;
  return { cleanText, suggestions };
}

/**
 * Custom hook to manage the BPS AI chat state.
 * Uses real Python chat.py RAG backend with streaming support.
 */
export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [stage, setStage] = useState<number | null>(null);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [conversationHistory, setConversationHistory] = useState<ConversationItem[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  // Store messages per conversation (keyed by conversationId)
  const conversationsRef = useRef<Map<string, ChatMessage[]>>(new Map());

  // Auto-save messages when they change and we have a conversationId
  const activeConvId = useRef<string | undefined>(undefined);
  activeConvId.current = conversationId;
  if (conversationId && messages.length > 0) {
    conversationsRef.current.set(conversationId, messages);
  }

  const sendMessage = useCallback(
    async (rawText: string) => {
      const text = rawText.trim();
      if (!text || stage !== null) return;

      const userMsg: ChatMessage = { id: uid(), role: "user", text, createdAt: Date.now() };
      setMessages((prev) => [...prev, userMsg]);
      setStage(0);

      let aiId: string | null = null;

      try {
        // Build history AFTER adding user message
        const history = messages.map((m) => {
          if (m.role === "assistant") return { role: "assistant" as const, content: m.answer.text };
          return { role: "user" as const, content: m.text };
        });
        const apiMessages = [...history, { role: "user" as const, content: text }];

        const stream = await api.chat.stream(text, {
          conversationId,
          messages: apiMessages,
        });

        const reader = stream.getReader();
        let fullText = "";
        let convId = conversationId;
        let latestSources: AiAnswer["sources"] = [];
        let latestWarning: string | null = null;
        let latestNote: string | null = null;
        let latestFeaturedImage: AiAnswer["featuredImage"] = null;
        let latestMode: string | undefined = undefined;

        for await (const event of parseSSEStream(reader)) {
          if (event.type === "meta") {
            if (event.conversationId) convId = event.conversationId;
            if (event.sources && event.sources.length > 0) {
              latestSources = event.sources.map((s) => ({
                kind: s.kind || "Publikasi BPS",
                title: s.title,
                meta: s.meta,
                link: s.link,
                rawScore: s.rawScore,
                pages: s.pages,
                citedPages: s.citedPages,
              }));
            }
            if (event.warning !== undefined) latestWarning = event.warning;
            if (event.note !== undefined) latestNote = event.note;
            if (event.featuredImage !== undefined) latestFeaturedImage = event.featuredImage;
            if (event.mode !== undefined) latestMode = event.mode;
          } else if (event.type === "token") {
            // Create AI placeholder on FIRST token (not before)
            if (!aiId) {
              aiId = uid();
              const aiMsg: ChatMessage = {
                id: aiId,
                role: "assistant",
                answer: { text: "", blocks: [], sources: [] },
                createdAt: Date.now(),
              };
              setMessages((prev) => [...prev, aiMsg]);
              setStage(null); // Remove thinking block, streaming visible now
            }
            fullText += event.content;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === aiId && m.role === "assistant"
                  ? { ...m, answer: { ...m.answer, text: fullText } }
                  : m,
              ),
            );
          }
        }

        setConversationId(convId);

        // Extract suggestions from final text & attach sources and metadata
        if (aiId) {
          const { cleanText, suggestions } = extractSuggestions(fullText);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === aiId && m.role === "assistant"
                ? {
                    ...m,
                    answer: {
                      ...m.answer,
                      text: cleanText,
                      suggestions,
                      sources: latestSources,
                      warning: latestWarning,
                      note: latestNote,
                      featuredImage: latestFeaturedImage,
                      mode: latestMode,
                    },
                  }
                : m,
            ),
          );
        }

        // Track conversation in history
        setConversationHistory((prev) => {
          const existing = prev.find((c) => c.id === convId);
          if (existing) return prev;
          const title = text.length > 40 ? text.slice(0, 40) + "…" : text;
          return [{ id: convId!, title, createdAt: Date.now() }, ...prev];
        });

        setStage(null);
      } catch (err) {
        console.error("Chat error:", err);
        const errorMsg = err instanceof Error ? err.message : "Terjadi kesalahan";
        if (aiId) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === aiId && m.role === "assistant"
                ? {
                    ...m,
                    answer: {
                      text: `Maaf, terjadi kesalahan: ${errorMsg}\n\nSilakan coba lagi.`,
                      blocks: [],
                      sources: [],
                    },
                  }
                : m,
            ),
          );
        } else {
          // Error before first token — add error as AI message
          const errId = uid();
          setMessages((prev) => [
            ...prev,
            {
              id: errId,
              role: "assistant",
              answer: {
                text: `Maaf, terjadi kesalahan: ${errorMsg}\n\nSilakan coba lagi.`,
                blocks: [],
                sources: [],
              },
              createdAt: Date.now(),
            },
          ]);
        }
        setStage(null);
      }
    },
    [stage, conversationId, messages],
  );

  /** Upload file/image then stream AI response */
  const sendFile = useCallback(
    async (file: File, message?: string) => {
      if (stage !== null) return;

      const userMsg: ChatMessage = {
        id: uid(),
        role: "user",
        text: message ?? `Mengunggah: ${file.name}`,
        attachment: { name: file.name, type: file.type },
        createdAt: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setStage(0);

      let aiId: string | null = null;

      try {
        const stream = await api.chat.upload(file, {
          message,
          conversationId,
        });

        const reader = stream.getReader();
        let fullText = "";
        let convId = conversationId;
        let latestSources: AiAnswer["sources"] = [];
        let latestWarning: string | null = null;
        let latestNote: string | null = null;
        let latestFeaturedImage: AiAnswer["featuredImage"] = null;
        let latestMode: string | undefined = undefined;

        for await (const event of parseSSEStream(reader)) {
          if (event.type === "meta") {
            if (event.conversationId) convId = event.conversationId;
            if (event.sources && event.sources.length > 0) {
              latestSources = event.sources.map((s) => ({
                kind: s.kind || "Publikasi BPS",
                title: s.title,
                meta: s.meta,
                link: s.link,
                rawScore: s.rawScore,
                pages: s.pages,
                citedPages: s.citedPages,
              }));
            }
            if (event.warning !== undefined) latestWarning = event.warning;
            if (event.note !== undefined) latestNote = event.note;
            if (event.featuredImage !== undefined) latestFeaturedImage = event.featuredImage;
            if (event.mode !== undefined) latestMode = event.mode;
          } else if (event.type === "token") {
            if (!aiId) {
              aiId = uid();
              setMessages((prev) => [
                ...prev,
                { id: aiId!, role: "assistant", answer: { text: "", blocks: [], sources: [] }, createdAt: Date.now() },
              ]);
              setStage(null);
            }
            fullText += event.content;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === aiId && m.role === "assistant"
                  ? { ...m, answer: { ...m.answer, text: fullText } }
                  : m,
              ),
            );
          }
        }

        setConversationId(convId);

        if (aiId) {
          const { cleanText, suggestions } = extractSuggestions(fullText);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === aiId && m.role === "assistant"
                ? {
                    ...m,
                    answer: {
                      ...m.answer,
                      text: cleanText,
                      suggestions,
                      sources: latestSources,
                      warning: latestWarning,
                      note: latestNote,
                      featuredImage: latestFeaturedImage,
                      mode: latestMode,
                    },
                  }
                : m,
            ),
          );
        }
        setStage(null);
      } catch (err) {
        console.error("Upload error:", err);
        const errorMsg = err instanceof Error ? err.message : "Terjadi kesalahan";
        if (aiId) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === aiId && m.role === "assistant"
                ? {
                    ...m,
                    answer: {
                      text: `Maaf, terjadi kesalahan saat memproses file: ${errorMsg}`,
                      blocks: [],
                      sources: [],
                    },
                  }
                : m,
            ),
          );
        } else {
          const errId = uid();
          setMessages((prev) => [
            ...prev,
            {
              id: errId,
              role: "assistant",
              answer: { text: `Maaf, terjadi kesalahan: ${errorMsg}`, blocks: [], sources: [] },
              createdAt: Date.now(),
            },
          ]);
        }
        setStage(null);
      }
    },
    [stage, conversationId],
  );

  const resetChat = useCallback(() => {
    abortRef.current?.abort();
    setStage(null);
    setMessages([]);
    setConversationId(undefined);
  }, []);

  const loadConversation = useCallback(
    (id: string) => {
      abortRef.current?.abort();
      setStage(null);
      const saved = conversationsRef.current.get(id);
      setMessages(saved ?? []);
      setConversationId(id);
    },
    [],
  );

  const renameConversation = useCallback((id: string, newTitle: string) => {
    setConversationHistory((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title: newTitle } : c)),
    );
  }, []);

  return {
    messages,
    stage,
    loadingStageText: stage !== null
      ? ["Mengirim pesan...", "AI sedang berpikir...", "Menyusun jawaban..."][stage] ?? "Memproses..."
      : null,
    sendMessage,
    sendFile,
    resetChat,
    loadConversation,
    renameConversation,
    conversationHistory,
    isLoading: stage !== null,
  };
}
