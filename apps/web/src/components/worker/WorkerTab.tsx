"use client";
import { useState, useEffect, useRef } from "react";
import { messagesApi, tasksApi, contractsApi } from "../../lib/api";
import { useSocket } from "../../hooks/useSocket";
import { Send, Loader2, Lock, AlertOctagon, Share2, FileEdit, CheckCircle, Clock } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import clsx from "clsx";

interface Props {
  roomId: string;
  userId: string;
  userName: string;
  tasks: any[];
  members: any[];
}

const STATUS_COLORS: Record<string, string> = {
  todo: "bg-slate-700 text-slate-300",
  in_progress: "bg-blue-600/20 text-blue-300",
  blocked: "bg-red-600/20 text-red-300",
  review: "bg-yellow-600/20 text-yellow-300",
  done: "bg-green-600/20 text-green-300",
};

export default function WorkerTab({ roomId, userId, userName, tasks }: Props) {
  const [messages, setMessages] = useState<any[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [shareMode, setShareMode] = useState<string | null>(null);
  const [showMarkBlocked, setShowMarkBlocked] = useState<string | null>(null);
  const [blockedReason, setBlockedReason] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const { on } = useSocket(roomId, userId);

  const myTasks = tasks.filter((t) => t.assignedUserId === userId);

  useEffect(() => {
    messagesApi.list(roomId, "worker")
      .then((r) => setMessages(r.data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [roomId]);

  useEffect(() => {
    const unsub = on("message.new", (msg: any) => {
      if (msg.channel === "worker" && msg.ownerUserId === userId) {
        setMessages((prev) => {
          if (prev.find((m) => m.id === msg.id)) return prev;
          return [...prev, msg];
        });
      }
    });
    return unsub;
  }, [on, userId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = async () => {
    if (!input.trim() || sending) return;
    const content = input.trim();
    setInput("");
    setSending(true);
    try {
      await messagesApi.sendWorker(roomId, content);
    } catch (e) {
      console.error(e);
      setInput(content);
    } finally {
      setSending(false);
    }
  };

  const shareToMaster = async (msgId: string, content: string) => {
    try {
      await messagesApi.sendMaster(roomId, content, msgId);
      setShareMode(null);
    } catch (e) {
      console.error(e);
    }
  };

  const markDone = async (taskId: string) => {
    await tasksApi.updateStatus(taskId, "done");
  };

  const markBlocked = async (taskId: string) => {
    if (!blockedReason.trim()) return;
    await tasksApi.updateStatus(taskId, "blocked", blockedReason);
    setShowMarkBlocked(null);
    setBlockedReason("");
  };

  const isAgent = (msg: any) => !!msg.senderAgentId;
  const isMe = (msg: any) => msg.senderUserId === userId && !msg.senderAgentId;

  return (
    <div className="h-full flex gap-0">
      {/* Sidebar: My Tasks */}
      <div className="w-64 border-r border-white/5 flex flex-col flex-shrink-0 hidden lg:flex">
        <div className="px-3 py-3 border-b border-white/5 flex items-center gap-2">
          <Lock className="w-3.5 h-3.5 text-slate-500" />
          <span className="text-xs text-slate-400 font-medium">My Tasks</span>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-2">
          {myTasks.length === 0 ? (
            <p className="text-xs text-slate-500 px-2 py-2">No tasks assigned yet.</p>
          ) : (
            myTasks.map((task) => (
              <div key={task.id} className="card p-3 space-y-2">
                <div className="flex items-start gap-2">
                  <span className={`badge text-xs ${STATUS_COLORS[task.status]}`}>{task.status}</span>
                </div>
                <p className="text-xs text-white font-medium leading-tight">{task.title}</p>
                {task.blockedReason && (
                  <p className="text-xs text-red-400">⚠ {task.blockedReason}</p>
                )}
                <div className="flex gap-1 pt-1">
                  {task.status !== "done" && (
                    <button
                      onClick={() => markDone(task.id)}
                      className="flex items-center gap-1 text-xs text-green-400 hover:text-green-300 transition-colors"
                    >
                      <CheckCircle className="w-3 h-3" />
                      Done
                    </button>
                  )}
                  {task.status !== "blocked" && (
                    <button
                      onClick={() => setShowMarkBlocked(task.id)}
                      className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 transition-colors ml-auto"
                    >
                      <AlertOctagon className="w-3 h-3" />
                      Block
                    </button>
                  )}
                </div>

                {showMarkBlocked === task.id && (
                  <div className="space-y-1.5 pt-1">
                    <input
                      className="input text-xs"
                      placeholder="Reason for blocking..."
                      value={blockedReason}
                      onChange={(e) => setBlockedReason(e.target.value)}
                    />
                    <div className="flex gap-1">
                      <button onClick={() => setShowMarkBlocked(null)} className="text-xs text-slate-500 hover:text-white px-2">Cancel</button>
                      <button onClick={() => markBlocked(task.id)} className="text-xs btn-primary py-1 px-2">Confirm</button>
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Chat */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-4 py-3 border-b border-white/5 flex items-center gap-2 flex-shrink-0">
          <Lock className="w-3.5 h-3.5 text-slate-500" />
          <span className="text-sm text-slate-400">Private Worker Agent</span>
          <span className="ml-auto text-xs text-slate-600">Only you can see this</span>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
          {loading ? (
            <div className="flex justify-center pt-8">
              <Loader2 className="w-5 h-5 animate-spin text-brand-500" />
            </div>
          ) : messages.length === 0 ? (
            <div className="text-center text-slate-500 text-sm pt-8">
              <Lock className="w-8 h-8 text-slate-600 mx-auto mb-2" />
              Start a private conversation with your Worker Agent.<br />
              Ask for help with your tasks, code review, or architecture advice.
            </div>
          ) : (
            messages.map((msg) => (
              <div key={msg.id} className={clsx("flex gap-3 group", isMe(msg) ? "flex-row-reverse" : "flex-row")}>
                <div className={clsx(
                  "w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0",
                  isAgent(msg) ? "bg-emerald-700 text-white" : "bg-slate-700 text-slate-300"
                )}>
                  {isAgent(msg) ? "W" : userName[0]}
                </div>
                <div className="max-w-[75%]">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs text-slate-500">
                      {isAgent(msg) ? "Worker Agent" : "You"}
                    </span>
                    <span className="text-xs text-slate-600">
                      {formatDistanceToNow(new Date(msg.createdAt), { addSuffix: true })}
                    </span>
                    {isAgent(msg) && (
                      <button
                        onClick={() => shareToMaster(msg.id, msg.content)}
                        className="text-xs text-slate-600 hover:text-brand-400 transition-colors opacity-0 group-hover:opacity-100 flex items-center gap-1"
                        title="Share to Master channel"
                      >
                        <Share2 className="w-3 h-3" />
                        Share
                      </button>
                    )}
                  </div>
                  <div className={clsx(
                    "rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap",
                    isAgent(msg)
                      ? "bg-emerald-600/10 border border-emerald-500/20 text-slate-200 rounded-tl-sm"
                      : "bg-brand-600 text-white rounded-tr-sm"
                  )}>
                    {msg.content}
                  </div>
                </div>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>

        <div className="px-4 py-3 border-t border-white/5 flex-shrink-0">
          <div className="flex gap-2">
            <input
              className="input flex-1"
              placeholder="Ask your agent for help..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              disabled={sending}
            />
            <button
              onClick={send}
              className="btn-primary px-3"
              disabled={sending || !input.trim()}
            >
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
