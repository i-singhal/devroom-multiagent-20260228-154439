"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../lib/auth-context";
import { roomsApi } from "../lib/api";
import Link from "next/link";
import { Plus, Loader2, Users, Target } from "lucide-react";

export default function HomePage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [rooms, setRooms] = useState<any[]>([]);
  const [loadingRooms, setLoadingRooms] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newGoal, setNewGoal] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  useEffect(() => {
    if (user) {
      setLoadingRooms(true);
      roomsApi.list()
        .then((r) => setRooms(r.data))
        .catch(console.error)
        .finally(() => setLoadingRooms(false));
    }
  }, [user]);

  const createRoom = async () => {
    if (!newTitle.trim() || !newGoal.trim()) return;
    setCreating(true);
    try {
      const res = await roomsApi.create(newTitle.trim(), newGoal.trim());
      router.push(`/rooms/${res.data.id}`);
    } catch (e) {
      console.error(e);
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="animate-spin w-8 h-8 text-brand-500" />
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="min-h-screen bg-surface-950">
      <header className="border-b border-white/5 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-brand-600 rounded-lg flex items-center justify-center text-sm font-bold">
            D
          </div>
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

      <main className="max-w-6xl mx-auto px-8 py-16">
        <h1 className="text-4xl font-bold text-white mb-8">Explore Your Rooms</h1>

        {loadingRooms ? (
          <div className="flex justify-center py-12">
            <Loader2 className="animate-spin w-6 h-6 text-brand-500" />
          </div>
        ) : rooms.length === 0 ? (
          <div className="flex flex-col items-center py-12">
            <div className="w-20 h-20 bg-brand-600/20 rounded-full flex items-center justify-center mb-8">
              <Users className="w-10 h-10 text-brand-400" />
            </div>
            <p className="text-slate-400 mb-6">No rooms yet. Create one to get started.</p>
            <button onClick={() => setShowCreate(true)} className="btn-primary">
              Create your first room
            </button>
          </div>
        ) : (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {rooms.map((room) => (
              <Link key={room.id} href={`/rooms/${room.id}`} className="card p-6 hover:border-brand-500/30 transition-colors block">
                <h2 className="text-2xl font-semibold text-white mb-1">{room.title}</h2>
                <p className="text-sm text-slate-400 mb-2">Goal: {room.goal}</p>
                <span className={`badge ${room.role === "owner" ? "bg-brand-600/20 text-brand-300" : "bg-slate-700 text-slate-300"}`}>
                  {room.role}
                </span>
              </Link>
            ))}
          </div>
        )}
      </main>

      {/* Create Room Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="card p-8 w-full max-w-lg">
            <h2 className="text-xl font-semibold text-white mb-6">Create a New Room</h2>
            <div className="space-y-4">
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Room Title</label>
                <input
                  className="input"
                  placeholder="e.g. Payment Service v2"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Goal</label>
                <textarea
                  className="input resize-none"
                  rows={3}
                  placeholder="e.g. Build a new checkout flow with Stripe integration"
                  value={newGoal}
                  onChange={(e) => setNewGoal(e.target.value)}
                />
              </div>
              <div className="flex gap-4 pt-4">
                <button onClick={() => setShowCreate(false)} className="btn-ghost flex-1">
                  Cancel
                </button>
                <button
                  onClick={createRoom}
                  className="btn-primary flex-1 flex items-center justify-center gap-2"
                  disabled={creating || !newTitle || !newGoal}
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
