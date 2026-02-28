import { Server as SocketServer, Socket } from "socket.io";
import type { Prisma } from "@prisma/client";
import { prisma } from "./db";

let io: SocketServer;

export function initWebSocket(socketServer: SocketServer) {
  io = socketServer;

  io.on("connection", async (socket: Socket) => {
    const { roomId, userId, auth } = socket.handshake.auth as {
      roomId: string;
      userId: string;
      auth: string;
    };

    if (!roomId || !userId) {
      socket.disconnect();
      return;
    }

    // Verify membership
    const membership = await prisma.membership.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });

    if (!membership) {
      socket.emit("error", { message: "Not a member of this room" });
      socket.disconnect();
      return;
    }

    // Join rooms
    socket.join(`room:${roomId}:global`);
    socket.join(`room:${roomId}:user:${userId}`);

    console.log(`👤 User ${userId} connected to room ${roomId}`);

    socket.on("message.send", async (data: { channel: string; content: string }) => {
      // Handled via HTTP endpoints; WS only for real-time delivery
      console.log(`[WS] message.send from ${userId} channel=${data.channel}`);
    });

    socket.on("event.emit", async (data: { type: string; payload: Record<string, unknown> }) => {
      // Human activity events from client
      await emitEvent({
        roomId,
        visibility: "global",
        type: data.type,
        payload: { ...data.payload, sourcePUserId: userId },
      });
    });

    socket.on("disconnect", () => {
      console.log(`👋 User ${userId} disconnected from room ${roomId}`);
    });
  });
}

// ─── Broadcast helpers ────────────────────────────────────────────────────────

export async function emitEvent(params: {
  roomId: string;
  visibility: "global" | "user";
  visibleToUserId?: string;
  type: string;
  payload: Record<string, unknown>;
}) {
  const { roomId, visibility, visibleToUserId, type, payload } = params;

  const event = await prisma.event.create({
    data: {
      roomId,
      visibility,
      visibleToUserId: visibility === "user" ? visibleToUserId : null,
      type,
      payload: payload as Prisma.InputJsonValue,
    },
  });

  const room =
    visibility === "global"
      ? `room:${roomId}:global`
      : `room:${roomId}:user:${visibleToUserId}`;

  io?.to(room).emit("event.new", event);
  return event;
}

export async function emitMessage(
  roomId: string,
  scope: "global" | "user",
  message: Record<string, unknown>,
  userId?: string,
) {
  const room =
    scope === "global"
      ? `room:${roomId}:global`
      : `room:${roomId}:user:${userId}`;

  io?.to(room).emit("message.new", message);
}

export function getIO() {
  return io;
}
