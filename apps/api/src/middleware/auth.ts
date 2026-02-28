import { Request, Response, NextFunction } from "express";
import { prisma } from "../db";
import { emitSecurityAlert } from "../security";

declare module "express-session" {
  interface SessionData {
    userId: string;
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const userId = req.session?.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.locals.user = user;
  next();
}

export async function requireRoomMember(req: Request, res: Response, next: NextFunction) {
  const user = res.locals.user;
  const roomId = req.params.roomId || req.params.id;

  if (!roomId) {
    res.status(400).json({ error: "Missing roomId" });
    return;
  }

  const membership = await prisma.membership.findUnique({
    where: { roomId_userId: { roomId, userId: user.id } },
  });

  if (!membership) {
    emitSecurityAlert({
      roomId,
      userId: user.id,
      userName: user.name,
      action: "room.member_access",
      detail: `${req.method} ${req.originalUrl}`,
      severity: "medium",
    }).catch(console.error);
    res.status(403).json({ error: "Not a member of this room" });
    return;
  }

  res.locals.membership = membership;
  next();
}

export async function requireRoomAdmin(req: Request, res: Response, next: NextFunction) {
  await requireRoomMember(req, res, async () => {
    const user = res.locals.user;
    const roomId = req.params.roomId || req.params.id;
    const { role } = res.locals.membership;
    if (role !== "owner" && role !== "admin") {
      emitSecurityAlert({
        roomId,
        userId: user.id,
        userName: user.name,
        action: "room.admin_action",
        detail: `${req.method} ${req.originalUrl}`,
        severity: "high",
      }).catch(console.error);
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    next();
  });
}
