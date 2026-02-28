"use client";
import { useState, useEffect } from "react";
import { notebookApi } from "../../lib/api";
import { useSocket } from "../../hooks/useSocket";
import { Search, BookOpen, Loader2, Shield, GitBranch, AlertTriangle, Zap, MessageSquare, BarChart3 } from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import clsx from "clsx";

const CATEGORY_META: Record<string, { label: string; icon: any; color: string }> = {
  decision: { label: "Decision", icon: BookOpen, color: "text-blue-400 bg-blue-400/10" },
  contract_change: { label: "Contract Change", icon: GitBranch, color: "text-purple-400 bg-purple-400/10" },
  task_update: { label: "Task Update", icon: Zap, color: "text-green-400 bg-green-400/10" },
  integration: { label: "Integration", icon: Shield, color: "text-brand-400 bg-brand-400/10" },
  blocker: { label: "Blocker", icon: AlertTriangle, color: "text-red-400 bg-red-400/10" },
  summary: { label: "Summary", icon: BarChart3, color: "text-slate-400 bg-slate-400/10" },
};

interface Props {
  roomId: string;
  userId?: string;
}

export default function NotebookTab({ roomId, userId }: Props) {
  const [entries, setEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<string>("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const { on } = useSocket(roomId, userId ?? null);

  const fetchEntries = (q?: string, cat?: string) => {
    setLoading(true);
    notebookApi.list(roomId, q, cat)
      .then((r) => setEntries(r.data))
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchEntries(); }, [roomId]);

  useEffect(() => {
    const unsub = on("event.new", (evt: any) => {
      if (evt.type === "notebook.entry.added") {
        fetchEntries(query, filter);
      }
    });
    return unsub;
  }, [on, query, filter]);

  const search = () => fetchEntries(query, filter);

  return (
    <div className="h-full flex flex-col">
      {/* Search + Filters */}
      <div className="px-4 py-3 border-b border-white/5 flex gap-3 flex-shrink-0 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
          <input
            className="input pl-8"
            placeholder="Search notebook..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
          />
        </div>
        <div className="flex gap-1 flex-wrap">
          {["", ...Object.keys(CATEGORY_META)].map((cat) => (
            <button
              key={cat}
              onClick={() => { setFilter(cat); fetchEntries(query, cat); }}
              className={clsx(
                "text-xs px-3 py-1.5 rounded-lg transition-colors",
                filter === cat ? "bg-brand-600 text-white" : "bg-surface-800 text-slate-400 hover:text-white"
              )}
            >
              {cat ? CATEGORY_META[cat]?.label : "All"}
            </button>
          ))}
        </div>
      </div>

      {/* Entries */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {loading ? (
          <div className="flex justify-center pt-8">
            <Loader2 className="w-5 h-5 animate-spin text-brand-500" />
          </div>
        ) : entries.length === 0 ? (
          <div className="text-center text-slate-500 text-sm pt-8">
            <BookOpen className="w-8 h-8 text-slate-600 mx-auto mb-2" />
            No entries yet. Entries are added automatically as your team works.
          </div>
        ) : (
          <div className="relative">
            {/* Timeline line */}
            <div className="absolute left-4 top-0 bottom-0 w-px bg-white/5" />

            <div className="space-y-4 pl-10">
              {entries.map((entry) => {
                const meta = CATEGORY_META[entry.category] ?? CATEGORY_META.summary;
                const Icon = meta.icon;
                const isOpen = expanded === entry.id;

                return (
                  <div key={entry.id} className="relative">
                    {/* Timeline dot */}
                    <div className={clsx(
                      "absolute -left-[2.25rem] top-3 w-5 h-5 rounded-full flex items-center justify-center",
                      meta.color
                    )}>
                      <Icon className="w-3 h-3" />
                    </div>

                    <div className="card p-4">
                      <div className="flex items-start gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <span className={clsx("badge text-xs", meta.color)}>{meta.label}</span>
                            <span className="text-xs text-slate-500">
                              {formatDistanceToNow(new Date(entry.createdAt), { addSuffix: true })}
                            </span>
                          </div>
                          <h4 className="text-sm font-medium text-white">{entry.title}</h4>

                          {isOpen && (
                            <div className="mt-3 prose-dark">
                              <p className="text-sm text-slate-300 whitespace-pre-wrap">{entry.content}</p>
                              {(entry.references?.taskIds?.length > 0 || entry.references?.contractIds?.length > 0) && (
                                <div className="mt-3 flex gap-2 flex-wrap">
                                  {entry.references.taskIds?.map((id: string) => (
                                    <span key={id} className="badge bg-surface-900 text-slate-400 font-mono text-xs">task:{id.slice(0, 8)}</span>
                                  ))}
                                  {entry.references.contractIds?.map((id: string) => (
                                    <span key={id} className="badge bg-purple-600/10 text-purple-400 font-mono text-xs">contract:{id.slice(0, 8)}</span>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        <button
                          onClick={() => setExpanded(isOpen ? null : entry.id)}
                          className="text-xs text-slate-500 hover:text-white transition-colors flex-shrink-0"
                        >
                          {isOpen ? "Collapse" : "Expand"}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
