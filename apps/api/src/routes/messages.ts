import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireAuth, requireRoomMember } from "../middleware/auth";
import { emitMessage } from "../websocket";
import { workerHandleMessage } from "../agents/worker";
import { masterHandleMessage } from "../agents/master";

const router = Router();

// GET /rooms/:roomId/messages?channel=master|worker
router.get("/:roomId/messages", requireAuth, requireRoomMember, async (req, res) => {
  const { roomId } = req.params;
  const user = res.locals.user;
  const channel = (req.query.channel as string) || "master";
  const before = req.query.before as string | undefined;
  const limit = Math.min(Number(req.query.limit) || 50, 100);

  if (channel !== "master" && channel !== "worker") {
    res.status(400).json({ error: "channel must be master or worker" });
    return;
  }

  const where: Record<string, unknown> = {
    roomId,
    channel,
    ...(channel === "worker" ? { ownerUserId: user.id } : {}),
    ...(before ? { createdAt: { lt: new Date(before) } } : {}),
  };

  const messages = await prisma.message.findMany({
    where,
    include: {
      senderUser: { select: { id: true, name: true, email: true } },
      senderAgent: { select: { id: true, type: true } },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  res.json(messages);
});

// POST /rooms/:roomId/messages/master
router.post("/:roomId/messages/master", requireAuth, requireRoomMember, async (req, res) => {
  const { roomId } = req.params;
  const user = res.locals.user;

  const { content, sharedFromMessageId } = z.object({
    content: z.string().min(1).max(10000),
    sharedFromMessageId: z.string().uuid().optional(),
  }).parse(req.body);

  // If sharing from worker chat, validate ownership
  if (sharedFromMessageId) {
    const original = await prisma.message.findUnique({ where: { id: sharedFromMessageId } });
    if (!original || original.ownerUserId !== user.id || original.channel !== "worker") {
      res.status(403).json({ error: "Cannot share: message not found or not yours" });
      return;
    }
  }

  const message = await prisma.message.create({
    data: {
      roomId,
      channel: "master",
      senderUserId: user.id,
      content,
    },
    include: {
      senderUser: { select: { id: true, name: true, email: true } },
      senderAgent: { select: { id: true, type: true } },
    },
  });

  await emitMessage(roomId, "global", message);

  if (sharedFromMessageId) {
    await prisma.notebookEntry.create({
      data: {
        roomId,
        category: "summary",
        title: `Shared context from ${user.name}`,
        content: `User **${user.name}** shared context to the master channel:\n\n> ${content}`,
        references: { messageIds: [sharedFromMessageId, message.id] },
      },
    });
  }

  // Master agent responds to master channel messages
  masterHandleMessage(roomId, user.id, content).catch(console.error);

  res.status(201).json(message);
});

// POST /rooms/:roomId/messages/worker
router.post("/:roomId/messages/worker", requireAuth, requireRoomMember, async (req, res) => {
  const { roomId } = req.params;
  const user = res.locals.user;

  const { content } = z.object({
    content: z.string().min(1).max(10000),
  }).parse(req.body);

  const message = await prisma.message.create({
    data: {
      roomId,
      channel: "worker",
      ownerUserId: user.id,
      senderUserId: user.id,
      content,
    },
    include: {
      senderUser: { select: { id: true, name: true, email: true } },
      senderAgent: { select: { id: true, type: true } },
    },
  });

  // Send only to the user's private socket room
  await emitMessage(roomId, "user", message, user.id);

  // Worker agent processes the message and responds
  workerHandleMessage(roomId, user.id, content).catch(console.error);

  res.status(201).json(message);
});

export default router;
