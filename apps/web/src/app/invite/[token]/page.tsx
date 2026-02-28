"use client";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { invitesApi } from "../../../lib/api";
import { useAuth } from "../../../lib/auth-context";
import { Loader2 } from "lucide-react";

export default function InvitePage() {
  const { token } = useParams() as { token: string };
  const { user, loading } = useAuth();
  const router = useRouter();
  const [status, setStatus] = useState<"joining" | "done" | "error">("joining");
  const [error, setError] = useState("");

  useEffect(() => {
    if (loading) return;

    if (!user) {
      router.push(`/login?redirect=/invite/${token}`);
      return;
    }

    invitesApi.join(token)
      .then((res) => {
        setStatus("done");
        setTimeout(() => router.push(`/rooms/${res.data.roomId}`), 1000);
      })
      .catch((e) => {
        setStatus("error");
        setError(e.response?.data?.error || "Failed to join room");
      });
  }, [user, loading, token, router]);

  return (
    <div className="min-h-screen bg-surface-950 flex items-center justify-center">
      <div className="text-center">
        {status === "joining" && (
          <>
            <Loader2 className="w-8 h-8 animate-spin text-brand-500 mx-auto mb-4" />
            <p className="text-slate-400">Joining room...</p>
          </>
        )}
        {status === "done" && (
          <p className="text-green-400">✓ Joined! Redirecting...</p>
        )}
        {status === "error" && (
          <p className="text-red-400">{error}</p>
        )}
      </div>
    </div>
  );
}
