import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireAuth } from "../middleware/auth";
import { emitEvent } from "../websocket";
import { workerKickoffAssignedTasks } from "../agents/worker";
import { emitSecurityAlert } from "../security";

const router = Router();

// Helper: verify task exists + user is member of room
async function getTaskWithAccess(taskId: string, userId: string) {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) return null;
  const membership = await prisma.membership.findUnique({
    where: { roomId_userId: { roomId: task.roomId, userId } },
  });
  if (!membership) return null;
  return { task, membership };
}

// POST /tasks/:id/assign (admin/owner)
router.post("/:id/assign", requireAuth, async (req, res) => {
  const user = res.locals.user;
  const result = await getTaskWithAccess(req.params.id, user.id);
  if (!result) { res.status(403).json({ error: "Not found or no access" }); return; }

  const { task, membership } = result;
  if (membership.role === "collaborator") {
    emitSecurityAlert({
      roomId: task.roomId,
      userId: user.id,
      userName: user.name,
      action: "task.assign",
      detail: `taskId=${task.id}`,
      severity: "high",
    }).catch(console.error);
    res.status(403).json({ error: "Admin role required to assign tasks" });
    return;
  }

  const { assignedUserId } = z.object({ assignedUserId: z.string().uuid() }).parse(req.body);

  // Verify target user is a member
  const targetMembership = await prisma.membership.findUnique({
    where: { roomId_userId: { roomId: task.roomId, userId: assignedUserId } },
  });
  if (!targetMembership) {
    res.status(400).json({ error: "Target user is not a member" });
    return;
  }

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: { assignedUserId },
  });

  await emitEvent({
    roomId: task.roomId,
    visibility: "user",
    visibleToUserId: assignedUserId,
    type: "task.assigned",
    payload: { taskId: task.id, taskTitle: task.title, assignedUserId },
  });

  // Also global notification (status board update)
  await emitEvent({
    roomId: task.roomId,
    visibility: "global",
    type: "task.status.updated",
    payload: { taskId: task.id, taskTitle: task.title, status: updated.status },
  });

  // Ensure worker agent instance for assignee
  const existing = await prisma.agentInstance.findFirst({
    where: { roomId: task.roomId, type: "worker", userId: assignedUserId },
  });
  if (!existing) {
    await prisma.agentInstance.create({
      data: { roomId: task.roomId, type: "worker", userId: assignedUserId },
    });
  }

  workerKickoffAssignedTasks(task.roomId, assignedUserId, [task.id]).catch((err) => {
    console.error("Worker kickoff failed:", err);
  });

  res.json(updated);
});

// POST /tasks/:id/status
router.post("/:id/status", requireAuth, async (req, res) => {
  const user = res.locals.user;
  const result = await getTaskWithAccess(req.params.id, user.id);
  if (!result) { res.status(403).json({ error: "Not found or no access" }); return; }

  const { task, membership } = result;

  // Collaborator can only update their own assigned tasks
  if (membership.role === "collaborator" && task.assignedUserId !== user.id) {
    emitSecurityAlert({
      roomId: task.roomId,
      userId: user.id,
      userName: user.name,
      action: "task.status.update_for_other_user",
      detail: `taskId=${task.id}`,
      severity: "high",
    }).catch(console.error);
    res.status(403).json({ error: "Can only update your own tasks" });
    return;
  }

  const data = z.object({
    status: z.enum(["todo", "in_progress", "blocked", "review", "done"]),
    blockedReason: z.string().optional(),
  }).parse(req.body);

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: {
      status: data.status,
      blockedReason: data.status === "blocked" ? data.blockedReason : null,
    },
  });

  await emitEvent({
    roomId: task.roomId,
    visibility: "global",
    type: "task.status.updated",
    payload: { taskId: task.id, taskTitle: task.title, status: data.status, blockedReason: data.blockedReason },
  });

  res.json(updated);
});

// GET /tasks/:id/messages (worker agent context for a task)
router.get("/:id", requireAuth, async (req, res) => {
  const user = res.locals.user;
  const result = await getTaskWithAccess(req.params.id, user.id);
  if (!result) { res.status(403).json({ error: "Not found or no access" }); return; }

  const { task } = result;
  const contractDeps = await prisma.taskContractDependency.findMany({
    where: { taskId: task.id },
    include: {
      contract: {
        include: { versions: { orderBy: { version: "desc" }, take: 1 } },
      },
    },
  });

  res.json({ ...task, contractDeps });
});

export default router;
