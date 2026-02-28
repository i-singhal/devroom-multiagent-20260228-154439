"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../lib/auth-context";
import { roomsApi } from "../lib/api";
import { Plus, Loader2 } from "lucide-react";

export default function HomePage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  const [rooms, setRooms] = useState<any[]>([]);
  const [loadingRooms, setLoadingRooms] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newGoal, setNewGoal] = useState("");
  const [newRepositoryUrl, setNewRepositoryUrl] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [loading, user, router]);

  useEffect(() => {
    if (!user) return;
    setLoadingRooms(true);
    roomsApi
      .list()
      .then((res) => setRooms(res.data))
      .catch(console.error)
      .finally(() => setLoadingRooms(false));
  }, [user]);

  const createRoom = async () => {
    if (!newTitle.trim() || !newGoal.trim()) return;
    setCreating(true);
    try {
      const repoUrl = newRepositoryUrl.trim();
      const res = await roomsApi.create(
        newTitle.trim(),
        newGoal.trim(),
        repoUrl ? repoUrl : undefined,
      );
      router.push(`/rooms/${res.data.id}`);
    } catch (err) {
      console.error(err);
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="animate-spin w-8 h-8 text-primary-color" />
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="min-h-screen bg-background-color">
      <header className="border-b border-white/5 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-primary-color rounded-lg flex items-center justify-center text-sm font-bold">D</div>
          <span className="font-semibold text-white">DevRoom</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-slate-400">{user.name}</span>
          <button onClick={() => setShowCreate(true)} className="btn-primary flex items-center gap-2">
            <Plus className="w-4 h-4" />
            New Room
          </button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-bold text-white mb-8">Your Dev Rooms</h1>

        {loadingRooms ? (
          <div className="flex justify-center py-12">
            <Loader2 className="animate-spin w-6 h-6 text-primary-color" />
          </div>
        ) : rooms.length === 0 ? (
          <div className="card p-10 text-center">
            <p className="text-slate-400 mb-4">No rooms yet. Create your first room to get started.</p>
            <button onClick={() => setShowCreate(true)} className="btn-primary">Create Room</button>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {rooms.map((room) => (
              <button
                key={room.id}
                onClick={() => router.push(`/rooms/${room.id}`)}
                className="card p-5 text-left hover:border-primary-color/30 transition-colors"
              >
                <h2 className="font-semibold text-white">{room.title}</h2>
                <p className="text-sm text-slate-400 mt-1">{room.goal}</p>
                <span className={`badge mt-3 ${room.role === "owner" ? "bg-primary-color/20 text-primary-color" : "bg-slate-700 text-slate-300"}`}>
                  {room.role}
                </span>
              </button>
            ))}
          </div>
        )}
      </main>

      {showCreate && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="card p-6 w-full max-w-lg">
            <h2 className="text-lg font-semibold text-white mb-4">Create New Room</h2>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Room Title</label>
                <input
                  className="input"
                  placeholder="Build Netflix clone"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Goal</label>
                <textarea
                  className="input resize-none"
                  rows={3}
                  placeholder="Implement core screens, auth, APIs, and streaming flow."
                  value={newGoal}
                  onChange={(e) => setNewGoal(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">GitHub Repo URL (optional)</label>
                <input
                  className="input"
                  placeholder="https://github.com/your-org/your-repo.git"
                  value={newRepositoryUrl}
                  onChange={(e) => setNewRepositoryUrl(e.target.value)}
                />
                <p className="text-xs text-slate-500 mt-1">
                  If left blank, DevRoom creates a room workspace repo automatically.
                </p>
              </div>
              <div className="flex gap-2 pt-1">
                <button onClick={() => setShowCreate(false)} className="btn-ghost flex-1">Cancel</button>
                <button
                  onClick={createRoom}
                  className="btn-primary flex-1 flex items-center justify-center gap-2"
                  disabled={creating || !newTitle.trim() || !newGoal.trim()}
                >
                  {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : "Create Room"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
