import { Router } from "express";
import { prisma } from "../db";
import { requireAuth, requireRoomAdmin } from "../middleware/auth";
import { emitEvent } from "../websocket";
import { workerKickoffAssignedTasks } from "../agents/worker";

const router = Router();

function roleRank(role: string): number {
  switch (role) {
    case "collaborator":
      return 0;
    case "admin":
      return 1;
    case "owner":
      return 2;
    default:
      return 3;
  }
}

async function rebalanceTodoTasks(roomId: string) {
  const members = await prisma.membership.findMany({
    where: { roomId },
    include: { user: { select: { id: true, name: true } } },
  });
  if (members.length === 0) return;

  const preferredMembers = members.filter((m) => m.role !== "owner");
  const assignees = (preferredMembers.length > 0 ? preferredMembers : members)
    .slice()
    .sort((a, b) => roleRank(a.role) - roleRank(b.role));
  if (assignees.length === 0) return;

  const todoTasks = await prisma.task.findMany({
    where: { roomId, status: "todo" },
    orderBy: { createdAt: "asc" },
  });
  if (todoTasks.length === 0) return;

  const taskIdsByUser = new Map<string, string[]>();

  for (let i = 0; i < todoTasks.length; i++) {
    const task = todoTasks[i];
    if (!task) continue;
    const assignee = assignees[i % assignees.length];
    if (!assignee) continue;
    if (task.assignedUserId === assignee.userId) continue;

    await prisma.task.update({
      where: { id: task.id },
      data: { assignedUserId: assignee.userId },
    });

    const existing = taskIdsByUser.get(assignee.userId) ?? [];
    existing.push(task.id);
    taskIdsByUser.set(assignee.userId, existing);

    await emitEvent({
      roomId,
      visibility: "user",
      visibleToUserId: assignee.userId,
      type: "task.assigned",
      payload: {
        taskId: task.id,
        taskTitle: task.title,
        assignedUserId: assignee.userId,
      },
    });
  }

  for (const assignedUserId of taskIdsByUser.keys()) {
    const existingAgent = await prisma.agentInstance.findFirst({
      where: { roomId, type: "worker", userId: assignedUserId },
    });
    if (!existingAgent) {
      await prisma.agentInstance.create({
        data: { roomId, type: "worker", userId: assignedUserId },
      });
    }
  }

  for (const [assignedUserId, taskIds] of taskIdsByUser) {
    workerKickoffAssignedTasks(roomId, assignedUserId, taskIds).catch((err) => {
      console.error("Worker kickoff after rebalance failed:", err);
    });
  }
}

// POST /rooms/:id/invites
router.post("/:id/invites", requireAuth, requireRoomAdmin, async (req, res) => {
  const { id: roomId } = req.params;

  const invite = await prisma.invite.create({
    data: {
      roomId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    },
  });

  const requestOrigin = req.get("origin");
  const requestHost = req.get("x-forwarded-host") || req.get("host");
  const requestProto = req.get("x-forwarded-proto") || req.protocol;
  const inferredFrontUrl = requestOrigin || (requestHost ? `${requestProto}://${requestHost}` : undefined);
  const configuredFrontUrl = process.env.PUBLIC_FRONTEND_URL
    || process.env.FRONTEND_URL?.split(",").map((value) => value.trim()).find(Boolean);
  const baseUrl = inferredFrontUrl || configuredFrontUrl || "http://localhost:3000";
  res.status(201).json({
    token: invite.token,
    url: `${baseUrl}/invite/${invite.token}`,
    expiresAt: invite.expiresAt,
  });
});

// POST /invites/:token/join
router.post("/:token/join", requireAuth, async (req, res) => {
  const { token } = req.params;
  const user = res.locals.user;

  const invite = await prisma.invite.findUnique({ where: { token } });
  if (!invite) {
    res.status(404).json({ error: "Invite not found" });
    return;
  }
  if (invite.expiresAt && invite.expiresAt < new Date()) {
    res.status(410).json({ error: "Invite expired" });
    return;
  }

  // Check if already a member
  const existing = await prisma.membership.findUnique({
    where: { roomId_userId: { roomId: invite.roomId, userId: user.id } },
  });
  if (existing) {
    res.json({ roomId: invite.roomId, alreadyMember: true });
    return;
  }

  await prisma.$transaction([
    prisma.membership.create({
      data: { roomId: invite.roomId, userId: user.id, role: "collaborator" },
    }),
    prisma.agentInstance.create({
      data: { roomId: invite.roomId, type: "worker", userId: user.id },
    }),
    prisma.invite.update({
      where: { token },
      data: { usedBy: user.id }, // stores most recent user who used this reusable invite
    }),
  ]);

  await emitEvent({
    roomId: invite.roomId,
    visibility: "global",
    type: "member.joined",
    payload: {
      roomId: invite.roomId,
      userId: user.id,
      userName: user.name,
      message: `${user.name} joined the room.`,
    },
  });

  await prisma.notebookEntry.create({
    data: {
      roomId: invite.roomId,
      category: "summary",
      title: "Team Member Joined",
      content: `**${user.name}** joined the room via invite link.`,
      references: {},
    },
  });

  await rebalanceTodoTasks(invite.roomId);

  res.json({ roomId: invite.roomId, joined: true, inviteReusable: true });
});

export default router;
