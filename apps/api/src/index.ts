import "dotenv/config";
import express from "express";
import type { RequestHandler } from "express";
import cors from "cors";
import session from "express-session";
import { createServer } from "http";
import { Server as SocketServer } from "socket.io";
import { prisma } from "./db";
import { initWebSocket } from "./websocket";
import { startMasterMonitor } from "./agents/monitor";

// Routes
import roomRoutes from "./routes/rooms";
import taskRoutes from "./routes/tasks";
import contractRoutes from "./routes/contracts";
import messageRoutes from "./routes/messages";
import notebookRoutes from "./routes/notebook";
import inviteRoutes from "./routes/invites";
import authRoutes from "./routes/auth";

const app = express();
const httpServer = createServer(app);

export const io = new SocketServer(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
  },
});

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:3000",
  credentials: true,
}));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || "devroom-secret-change-in-prod",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
}) as unknown as RequestHandler);

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/auth", authRoutes);
app.use("/rooms", roomRoutes);
app.use("/tasks", taskRoutes);
app.use("/contracts", contractRoutes);
app.use("/rooms", messageRoutes);
app.use("/rooms", notebookRoutes);
app.use("/rooms", inviteRoutes);
app.use("/invites", inviteRoutes);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
initWebSocket(io);

// ─── Master Monitor ───────────────────────────────────────────────────────────
startMasterMonitor(io);

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`🚀 API server running on http://localhost:${PORT}`);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  await prisma.$disconnect();
  process.exit(0);
});
