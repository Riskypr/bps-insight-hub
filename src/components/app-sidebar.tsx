import { BpsWordmark } from "@/components/bps-logo";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import type { ConversationItem } from "@/hooks/use-chat";
import { cn } from "@/lib/utils";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  FileUp,
  FolderOpen,
  MessageSquare,
  Pencil,
  Plus,
} from "lucide-react";
import { useRef, useState } from "react";

export function AppSidebar({
  onNewChat,
  onSelectConversation,
  onRenameConversation,
  activeConversationId,
  conversations = [],
}: {
  onNewChat: () => void;
  onSelectConversation: (id: string) => void;
  onRenameConversation: (id: string, title: string) => void;
  activeConversationId?: string | undefined;
  conversations?: ConversationItem[];
}) {
  const { state, isMobile, setOpenMobile } = useSidebar();
  const collapsed = !isMobile && state === "collapsed";
  const navigate = useNavigate();
  const location = useLocation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  const startRename = (conv: ConversationItem) => {
    setEditingId(conv.id);
    setEditValue(conv.title);
    setTimeout(() => editInputRef.current?.focus(), 50);
  };

  const commitRename = () => {
    if (editingId && editValue.trim()) {
      onRenameConversation(editingId, editValue.trim());
    }
    setEditingId(null);
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="px-3 py-4">
        <BpsWordmark collapsed={collapsed} />
      </SidebarHeader>

      <SidebarContent>
        {/* New Chat Button */}
        <div className="px-3 pt-1">
          <button
            onClick={onNewChat}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-xl border border-dashed border-bps-blue/30 bg-bps-blue-soft/40 px-3 py-2.5 text-sm font-medium text-bps-blue transition-all hover:border-bps-blue/60 hover:bg-bps-blue-soft/70",
              collapsed && "justify-center px-0",
            )}
          >
            <Plus className="h-4 w-4 shrink-0" />
            {!collapsed && <span>Percakapan Baru</span>}
          </button>
        </div>

        {/* Chat History */}
        {conversations.length > 0 && (
          <div className="mt-4 px-3">
            {!collapsed && (
              <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Percakapan Terbaru
              </div>
            )}
          </div>
        )}

        {conversations.length > 0 && (
          <SidebarGroup className="pt-0">
            <SidebarGroupContent>
              <SidebarMenu>
                {conversations.map((conv) => (
                  <SidebarMenuItem key={conv.id}>
                    {editingId === conv.id ? (
                      <input
                        ref={editInputRef}
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename();
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        className="w-full rounded-md border bg-background px-2 py-1 text-[13px] outline-none focus:border-bps-blue"
                      />
                    ) : (
                      <div className="group relative flex items-center">
                        <SidebarMenuButton
                          onClick={() => onSelectConversation(conv.id)}
                          isActive={activeConversationId === conv.id}
                          tooltip={conv.title}
                          className={cn(
                            "flex-1 text-[13px]",
                            activeConversationId === conv.id &&
                              "bg-bps-blue-soft/60 text-bps-blue-deep",
                          )}
                        >
                          <MessageSquare className="h-3.5 w-3.5 shrink-0 opacity-50" />
                          <span className="truncate">{conv.title}</span>
                        </SidebarMenuButton>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            startRename(conv);
                          }}
                          className="absolute right-1 hidden rounded p-1 text-muted-foreground hover:bg-muted group-hover:block"
                          title="Rename"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        <div className="mt-auto px-3 pb-3">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => {
                  if (isMobile) setOpenMobile(false);
                  void navigate({ to: "/rag-documents" });
                }}
                isActive={location.pathname === "/rag-documents"}
                tooltip="Unggah Dokumen"
                className={cn(
                  "text-[13px]",
                  location.pathname.startsWith("/rag-documents") &&
                    "bg-bps-blue-soft/60 text-bps-blue-deep",
                )}
              >
                <FileUp className="h-4 w-4 shrink-0" />
                <span>Unggah Dokumen</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => {
                  if (isMobile) setOpenMobile(false);
                  void navigate({ to: "/rag-document-collection" });
                }}
                isActive={location.pathname === "/rag-document-collection"}
                tooltip="Koleksi Dokumen"
                className={cn(
                  "text-[13px]",
                  location.pathname === "/rag-documents/collection" &&
                    "bg-bps-blue-soft/60 text-bps-blue-deep",
                )}
              >
                <FolderOpen className="h-4 w-4 shrink-0" />
                <span>Koleksi Dokumen</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </div>
      </SidebarContent>
    </Sidebar>
  );
}
