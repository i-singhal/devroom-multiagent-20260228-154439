"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { AxiosError } from "axios";
import { useAuth } from "../../lib/auth-context";
import { API_BASE } from "../../lib/api";
import { Loader2 } from "lucide-react";

export default function LoginPage() {
  const { login, register } = useAuth();
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const formatError = (err: unknown) => {
    const axiosErr = err as AxiosError<{ error?: unknown }>;
    if (!axiosErr.response) {
      return `Cannot reach API server at ${API_BASE}. Start the API app and refresh.`;
    }

    const payloadError = axiosErr.response.data?.error;
    if (typeof payloadError === "string") {
      return payloadError;
    }

    if (Array.isArray(payloadError)) {
      const joined = payloadError
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object" && "message" in item) {
            const message = (item as { message?: unknown }).message;
            return typeof message === "string" ? message : "";
          }
          return "";
        })
        .filter(Boolean)
        .join(", ");
      if (joined) return joined;
    }

    return `Request failed (${axiosErr.response.status}).`;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      if (mode === "login") {
        await login(email, password);
      } else {
        if (password !== confirmPassword) {
          setError("Passwords do not match.");
          return;
        }
        await register(name, email, password);
      }
      router.push("/");
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-surface-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-12 h-12 bg-brand-600 rounded-2xl flex items-center justify-center text-xl font-bold mx-auto mb-4">D</div>
          <h1 className="text-2xl font-bold text-white">DevRoom</h1>
          <p className="text-slate-400 text-sm mt-1">Multi-Agent Collaborative Dev Platform</p>
        </div>

        <div className="card p-6">
          <div className="flex gap-1 bg-surface-900 rounded-lg p-1 mb-6">
            {(["login", "register"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`flex-1 py-1.5 rounded-md text-sm font-medium transition-colors capitalize ${
                  mode === m ? "bg-brand-600 text-white" : "text-slate-400 hover:text-white"
                }`}
              >
                {m}
              </button>
            ))}
          </div>

          <form onSubmit={submit} className="space-y-3">
            {mode === "register" && (
              <>
                <div>
                  <label className="text-sm text-slate-400 block mb-1">Name</label>
                  <input
                    className="input"
                    placeholder="Your name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label className="text-sm text-slate-400 block mb-1">Confirm Password</label>
                  <input
                    className="input"
                    type="password"
                    placeholder="••••••••"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    minLength={8}
                  />
                </div>
              </>
            )}
            <div>
              <label className="text-sm text-slate-400 block mb-1">Email</label>
              <input
                className="input"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="text-sm text-slate-400 block mb-1">Password</label>
              <input
                className="input"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
              />
            </div>

            {error && (
              <p className="text-red-400 text-sm bg-red-400/10 rounded-lg px-3 py-2">{error}</p>
            )}

            <button type="submit" className="btn-primary w-full flex items-center justify-center gap-2 mt-2" disabled={loading}>
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {mode === "login" ? "Sign In" : "Create Account"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
