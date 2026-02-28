"use client";
import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "../../../lib/auth-context";
import { roomsApi } from "../../../lib/api";
import { useSocket } from "../../../hooks/useSocket";
import MasterTab from "../../../components/master/MasterTab";
import WorkerTab from "../../../components/worker/WorkerTab";
import TasksTab from "../../../components/tasks/TasksTab";
import NotebookTab from "../../../components/notebook/NotebookTab";
import { Users, Bot, LayoutGrid, BookOpen, Loader2, Link2, LogOut, AlertTriangle, GitBranch, RefreshCw } from "lucide-react";
import clsx from "clsx";

const TABS = [
  { id: "master", label: "Master", icon: Bot },
  { id: "agent", label: "My Agent", icon: Users },
  { id: "tasks", label: "Tasks", icon: LayoutGrid },
  { id: "notebook", label: "Notebook", icon: BookOpen },
] as const;

type TabId = typeof TABS[number]["id"];

export default function RoomPage() {
  const { id: roomId } = useParams() as { id: string };
  const { user, loading: authLoading, logout } = useAuth();
  const router = useRouter();

  const [room, setRoom] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>("master");
  const [alerts, setAlerts] = useState<any[]>([]);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteUrl, setInviteUrl] = useState("");
  const [repoStatus, setRepoStatus] = useState<any>(null);
  const [syncingRepo, setSyncingRepo] = useState(false);

  const { on } = useSocket(roomId, user?.id ?? null);

  const fetchRoom = useCallback(async () => {
    try {
      const res = await roomsApi.get(roomId);
      setRoom(res.data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [roomId]);

  const fetchRepoStatus = useCallback(async () => {
    try {
      const res = await roomsApi.getRepo(roomId);
      setRepoStatus(res.data);
    } catch (e) {
      console.error(e);
    }
  }, [roomId]);

  useEffect(() => {
    if (!authLoading && !user) {
      router.push("/login");
      return;
    }
    if (user) {
      fetchRoom();
      fetchRepoStatus();
    }
  }, [user, authLoading, fetchRoom, fetchRepoStatus, router]);

  useEffect(() => {
    if (!user) return;
    const id = window.setInterval(() => {
      fetchRepoStatus().catch(() => undefined);
    }, 8000);
    return () => window.clearInterval(id);
  }, [fetchRepoStatus, user]);

  // Real-time: listen for events and update state
  useEffect(() => {
    const unsubEvent = on("event.new", (evt: any) => {
      // Show integration alerts in top bar
      if (["master.integration.alert", "master.impact.alert", "master.security.alert", "member.joined"].includes(evt.type)) {
        setAlerts((prev) => [{ ...evt, id: evt.id }, ...prev].slice(0, 5));
        // Auto-dismiss after 10s
        setTimeout(() => {
          setAlerts((prev) => prev.filter((a) => a.id !== evt.id));
        }, 10000);
      }

      // Refresh room state on task/contract changes
      if (["task.status.updated", "task.assigned", "contract.published", "notebook.entry.added", "member.joined"].includes(evt.type)) {
        fetchRoom();
        fetchRepoStatus();
      }
    });

    return () => {
      if (typeof unsubEvent === "function") unsubEvent();
    };
  }, [on, fetchRoom, fetchRepoStatus]);

  const createInvite = async () => {
    try {
      const res = await roomsApi.createInvite(roomId);
      const token = typeof res.data?.token === "string" ? res.data.token : "";
      const dynamicUrl = token && typeof window !== "undefined"
        ? `${window.location.origin}/invite/${token}`
        : "";
      setInviteUrl(dynamicUrl || res.data.url);
      setShowInvite(true);
    } catch (e) {
      console.error(e);
    }
  };

  const syncRepo = async () => {
    setSyncingRepo(true);
    try {
      await roomsApi.syncRepo(roomId);
      await fetchRepoStatus();
      await fetchRoom();
    } catch (e) {
      console.error(e);
    } finally {
      setSyncingRepo(false);
    }
  };

  if (authLoading || loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-surface-950">
        <Loader2 className="animate-spin w-8 h-8 text-brand-500" />
      </div>
    );
  }

  if (!room || !user) return null;

  const isAdmin = room.myRole === "owner" || room.myRole === "admin";

  return (
    <div className="h-screen bg-surface-950 flex flex-col overflow-hidden">
      {/* Header */}
      <header className="border-b border-white/5 px-4 py-3 flex items-center gap-4 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 bg-brand-600 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0">D</div>
          <div className="min-w-0">
            <h1 className="font-semibold text-white text-sm truncate">{room.title}</h1>
            <p className="text-xs text-slate-500 truncate hidden sm:block">{room.goal}</p>
          </div>
        </div>

        <div className="flex items-center gap-1 ml-auto">
          <div className={clsx(
            "hidden md:flex items-center gap-1.5 text-xs rounded-lg border px-2 py-1",
            repoStatus?.repoReady ? "border-emerald-500/30 text-emerald-300" : "border-red-500/30 text-red-300",
          )}>
            <GitBranch className="w-3.5 h-3.5" />
            <span>{repoStatus?.repoReady ? "Repo Ready" : "Repo Warning"}</span>
          </div>

          {isAdmin && (
            <button onClick={syncRepo} className="btn-ghost flex items-center gap-1.5 text-xs" disabled={syncingRepo}>
              {syncingRepo ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">Sync Repo</span>
            </button>
          )}

          {/* Members */}
          <div className="flex items-center gap-1 text-xs text-slate-400 mr-2">
            <Users className="w-3.5 h-3.5" />
            {room.memberships?.length ?? 0}
          </div>

          {isAdmin && (
            <button onClick={createInvite} className="btn-ghost flex items-center gap-1.5 text-xs">
              <Link2 className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Invite</span>
            </button>
          )}
          <button onClick={logout} className="btn-ghost flex items-center gap-1.5 text-xs">
            <LogOut className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">{user.name}</span>
          </button>
        </div>
      </header>

      {/* Alerts */}
      {alerts.length > 0 && (
        <div className="bg-amber-500/10 border-b border-amber-500/20 px-4 py-2 space-y-1 flex-shrink-0">
          {alerts.map((a) => (
            <div key={a.id} className={clsx(
              "flex items-start gap-2 text-xs",
              a.type === "master.security.alert" ? "text-red-300" : "text-amber-300",
            )}>
              <AlertTriangle className={clsx(
                "w-3.5 h-3.5 mt-0.5 flex-shrink-0",
                a.type === "master.security.alert" ? "text-red-300" : "text-amber-300",
              )} />
              <span>{typeof a.payload?.message === "string" ? a.payload.message : JSON.stringify(a.payload?.message || a.payload?.summary)}</span>
              <button onClick={() => setAlerts((p) => p.filter((x) => x.id !== a.id))} className="ml-auto text-amber-500 hover:text-white">✕</button>
            </div>
          ))}
        </div>
      )}

      {repoStatus?.repoLastError && (
        <div className="bg-red-500/10 border-b border-red-500/20 px-4 py-2 text-xs text-red-300">
          Repository issue: {repoStatus.repoLastError}
        </div>
      )}

      {/* Tabs */}
      <nav className="flex border-b border-white/5 flex-shrink-0">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={clsx(
              "flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors",
              activeTab === id
                ? "border-brand-500 text-brand-400"
                : "border-transparent text-slate-400 hover:text-white",
            )}
          >
            <Icon className="w-4 h-4" />
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </nav>

      {/* Tab Content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === "master" && (
          <MasterTab roomId={roomId} userId={user.id} userName={user.name} isAdmin={isAdmin} tasks={room.tasks} />
        )}
        {activeTab === "agent" && (
          <WorkerTab roomId={roomId} userId={user.id} userName={user.name} tasks={room.tasks} members={room.memberships} />
        )}
        {activeTab === "tasks" && (
          <TasksTab roomId={roomId} tasks={room.tasks} members={room.memberships} userId={user.id} isAdmin={isAdmin} onRefresh={fetchRoom} />
        )}
        {activeTab === "notebook" && (
          <NotebookTab roomId={roomId} />
        )}
      </div>

      {/* Invite Modal */}
      {showInvite && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="card p-6 w-full max-w-md">
            <h2 className="text-lg font-semibold text-white mb-3">Invite Link</h2>
            <p className="text-sm text-slate-400 mb-3">Share this link with collaborators (expires in 7 days):</p>
            <div className="flex gap-2">
              <input className="input flex-1 text-xs" value={inviteUrl} readOnly />
              <button
                className="btn-primary text-xs px-3"
                onClick={() => navigator.clipboard.writeText(inviteUrl)}
              >
                Copy
              </button>
            </div>
            <button onClick={() => setShowInvite(false)} className="btn-ghost w-full mt-3">Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
