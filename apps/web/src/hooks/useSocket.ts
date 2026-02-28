"use client";
import { useEffect, useRef, useCallback } from "react";
import { io, Socket } from "socket.io-client";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

type EventHandler = (data: unknown) => void;

let sharedSocket: Socket | null = null;
let currentRoomId: string | null = null;
let currentUserId: string | null = null;

export function useSocket(roomId: string | null, userId: string | null) {
  const handlersRef = useRef<Map<string, Set<EventHandler>>>(new Map());

  const on = useCallback((event: string, handler: EventHandler) => {
    if (!handlersRef.current.has(event)) {
      handlersRef.current.set(event, new Set());
    }
    handlersRef.current.get(event)!.add(handler);
    return () => {
      handlersRef.current.get(event)?.delete(handler);
    };
  }, []);

  const emit = useCallback((event: string, data: unknown) => {
    sharedSocket?.emit(event, data);
  }, []);

  useEffect(() => {
    if (!roomId || !userId) return;

    // Reconnect if room/user changed
    if (currentRoomId !== roomId || currentUserId !== userId) {
      sharedSocket?.disconnect();
      sharedSocket = null;
    }

    if (!sharedSocket) {
      currentRoomId = roomId;
      currentUserId = userId;

      sharedSocket = io(API_URL, {
        withCredentials: true,
        auth: { roomId, userId },
      });

      sharedSocket.on("connect", () => {
        console.log("🔌 Socket connected:", sharedSocket?.id);
      });

      sharedSocket.on("disconnect", () => {
        console.log("🔌 Socket disconnected");
      });
    }

    const messageHandler = (data: unknown) => {
      handlersRef.current.get("message.new")?.forEach((h) => h(data));
    };
    const eventHandler = (data: unknown) => {
      handlersRef.current.get("event.new")?.forEach((h) => h(data));
    };
    const patchHandler = (data: unknown) => {
      handlersRef.current.get("state.patch")?.forEach((h) => h(data));
    };

    sharedSocket.on("message.new", messageHandler);
    sharedSocket.on("event.new", eventHandler);
    sharedSocket.on("state.patch", patchHandler);

    return () => {
      sharedSocket?.off("message.new", messageHandler);
      sharedSocket?.off("event.new", eventHandler);
      sharedSocket?.off("state.patch", patchHandler);
    };
  }, [roomId, userId]);

  return { on, emit, socket: sharedSocket };
}
