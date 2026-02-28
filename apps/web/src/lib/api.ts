import axios from "axios";

export const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

export const api = axios.create({
  baseURL: API_BASE,
  withCredentials: true,
  headers: { "Content-Type": "application/json" },
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
export const authApi = {
  register: (name: string, email: string, password: string) =>
    api.post("/auth/register", { name, email, password }),
  login: (email: string, password: string) =>
    api.post("/auth/login", { email, password }),
  logout: () => api.post("/auth/logout"),
  me: () => api.get("/auth/me"),
};

// ─── Rooms ────────────────────────────────────────────────────────────────────
export const roomsApi = {
  list: () => api.get("/rooms"),
  get: (id: string) => api.get(`/rooms/${id}`),
  create: (title: string, goal: string) => api.post("/rooms", { title, goal }),
  plan: (id: string) => api.post(`/rooms/${id}/plan`),
  createInvite: (id: string) => api.post(`/rooms/${id}/invites`),
};

// ─── Tasks ────────────────────────────────────────────────────────────────────
export const tasksApi = {
  get: (id: string) => api.get(`/tasks/${id}`),
  assign: (id: string, assignedUserId: string) =>
    api.post(`/tasks/${id}/assign`, { assignedUserId }),
  updateStatus: (id: string, status: string, blockedReason?: string) =>
    api.post(`/tasks/${id}/status`, { status, blockedReason }),
};

// ─── Contracts ────────────────────────────────────────────────────────────────
export const contractsApi = {
  get: (id: string) => api.get(`/contracts/${id}`),
  propose: (id: string, data: { summary: string; breaking: boolean; proposedContent: string }) =>
    api.post(`/contracts/${id}/propose`, data),
  publish: (id: string, data: { summary: string; breaking: boolean; content: string }) =>
    api.post(`/contracts/${id}/publish`, data),
};

// ─── Messages ─────────────────────────────────────────────────────────────────
export const messagesApi = {
  list: (roomId: string, channel: "master" | "worker") =>
    api.get(`/rooms/${roomId}/messages?channel=${channel}`),
  sendMaster: (roomId: string, content: string, sharedFromMessageId?: string) =>
    api.post(`/rooms/${roomId}/messages/master`, { content, sharedFromMessageId }),
  sendWorker: (roomId: string, content: string) =>
    api.post(`/rooms/${roomId}/messages/worker`, { content }),
};

// ─── Notebook ─────────────────────────────────────────────────────────────────
export const notebookApi = {
  list: (roomId: string, q?: string, category?: string) =>
    api.get(`/rooms/${roomId}/notebook`, { params: { q, category } }),
  create: (roomId: string, data: object) =>
    api.post(`/rooms/${roomId}/notebook`, data),
};

// ─── Invites ─────────────────────────────────────────────────────────────────
export const invitesApi = {
  join: (token: string) => api.post(`/invites/${token}/join`),
};
