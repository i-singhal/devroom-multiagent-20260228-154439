import { prisma } from "./db";
import { emitEvent } from "./websocket";

export async function emitSecurityAlert(params: {
  roomId: string;
  userId?: string;
  userName?: string;
  action: string;
  detail?: string;
  severity?: "low" | "medium" | "high";
}) {
  const { roomId, userId, userName, action, detail, severity = "medium" } = params;

  const roomExists = await prisma.room.findUnique({
    where: { id: roomId },
    select: { id: true },
  });
  if (!roomExists) return;

  const actor = userName ?? userId ?? "unknown";
  const message = `Security alert: ${actor} attempted "${action}"${detail ? ` (${detail})` : ""}.`;

  await emitEvent({
    roomId,
    visibility: "global",
    type: "master.security.alert",
    payload: {
      severity,
      message,
      action,
      detail: detail ?? null,
      userId: userId ?? null,
      userName: userName ?? null,
      ts: new Date().toISOString(),
    },
  });
}
