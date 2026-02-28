"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { messagesApi, roomsApi } from "../../lib/api";
import { useSocket } from "../../hooks/useSocket";
import { Send, Bot, Loader2, Sparkles } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import clsx from "clsx";

interface Props {
  roomId: string;
  userId: string;
  userName: string;
  isAdmin: boolean;
  tasks: any[];
}

export default function MasterTab({ roomId, userId, userName, isAdmin, tasks }: Props) {
  const [messages, setMessages] = useState<any[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const { on } = useSocket(roomId, userId);

  useEffect(() => {
    messagesApi.list(roomId, "master")
      .then((r) => setMessages(r.data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [roomId]);

  useEffect(() => {
    const unsub = on("message.new", (msg: any) => {
      if (msg.channel === "master") {
        setMessages((prev) => {
          if (prev.find((m) => m.id === msg.id)) return prev;
          return [...prev, msg];
        });
      }
    });
    return unsub;
  }, [on]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = async () => {
    if (!input.trim() || sending) return;
    const content = input.trim();
    setInput("");
    setSending(true);
    try {
      await messagesApi.sendMaster(roomId, content);
    } catch (e) {
      console.error(e);
      setInput(content);
    } finally {
      setSending(false);
    }
  };

  const generatePlan = async () => {
    setLoadingPlan(true);
    try {
      await roomsApi.plan(roomId);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingPlan(false);
    }
  };

  const isAgent = (msg: any) => !!msg.senderAgentId;
  const isMe = (msg: any) => msg.senderUserId === userId;

  return (
    <div className="h-full flex flex-col">
      {/* Top bar */}
      <div className="px-4 py-3 border-b border-white/5 flex items-center gap-3 flex-shrink-0">
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <Bot className="w-4 h-4 text-brand-400" />
          <span>Master Agent — shared channel</span>
        </div>
        {isAdmin && tasks.length === 0 && (
          <button
            onClick={generatePlan}
            disabled={loadingPlan}
            className="btn-primary ml-auto flex items-center gap-2 text-xs"
          >
            {loadingPlan ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            Generate Plan
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {loading ? (
          <div className="flex justify-center pt-8">
            <Loader2 className="w-5 h-5 animate-spin text-brand-500" />
          </div>
        ) : messages.length === 0 ? (
          <div className="text-center text-slate-500 text-sm pt-8">
            <Bot className="w-8 h-8 text-slate-600 mx-auto mb-2" />
            No messages yet. Ask the Master Agent anything, or{" "}
            {isAdmin ? "generate a plan to get started." : "wait for the admin to generate a plan."}
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={clsx("flex gap-3", isMe(msg) && !isAgent(msg) ? "flex-row-reverse" : "flex-row")}
            >
              <div className={clsx(
                "w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0",
                isAgent(msg) ? "bg-brand-600 text-white" : "bg-slate-700 text-slate-300"
              )}>
                {isAgent(msg) ? "M" : (msg.senderUser?.name?.[0] ?? "?")}
              </div>
              <div className="max-w-[75%]">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs text-slate-500">
                    {isAgent(msg) ? "Master Agent" : msg.senderUser?.name ?? "Unknown"}
                  </span>
                  <span className="text-xs text-slate-600">
                    {formatDistanceToNow(new Date(msg.createdAt), { addSuffix: true })}
                  </span>
                </div>
                <div className={clsx(
                  "rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap",
                  isAgent(msg)
                    ? "bg-brand-600/15 border border-brand-500/20 text-slate-200 rounded-tl-sm"
                    : isMe(msg)
                    ? "bg-brand-600 text-white rounded-tr-sm"
                    : "bg-surface-800 text-slate-200 rounded-tl-sm"
                )}>
                  {msg.content}
                </div>
              </div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="px-4 py-3 border-t border-white/5 flex-shrink-0">
        <div className="flex gap-2">
          <input
            className="input flex-1"
            placeholder="Message the Master Agent or team..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            disabled={sending}
          />
          <button
            onClick={send}
            className="btn-primary px-3 flex items-center justify-center"
            disabled={sending || !input.trim()}
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}
