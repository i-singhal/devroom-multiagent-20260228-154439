import { Server as SocketServer } from "socket.io";
import { prisma } from "../db";
import { emitEvent } from "../websocket";
import { masterHandleContractPublished, checkDependencyResolution } from "./master";
import { workerKickoffAssignedTasks } from "./worker";

const SWEEP_INTERVAL_MS = 30 * 1000; // 30 seconds
const STALE_TASK_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

let monitorRunning = false;
const processedEvents = new Set<string>();

export function startMasterMonitor(_io: SocketServer) {
  if (monitorRunning) return;
  monitorRunning = true;

  console.log("🤖 Master Monitor started");

  runStartupWorkerKickoff().catch((err) => {
    console.error("Startup worker kickoff error:", err);
  });

  // Periodic sweep
  setInterval(async () => {
    try {
      const rooms = await prisma.room.findMany({ select: { id: true } });
      for (const room of rooms) {
        await periodicSweep(room.id);
      }
    } catch (err) {
      console.error("Master Monitor sweep error:", err);
    }
  }, SWEEP_INTERVAL_MS);

  // Event-driven handler - poll for unprocessed events
  setInterval(async () => {
    try {
      await processNewEvents();
    } catch (err) {
      console.error("Master Monitor event poll error:", err);
    }
  }, 5000); // Poll every 5s
}

async function runStartupWorkerKickoff() {
  const activeTasks = await prisma.task.findMany({
    where: {
      assignedUserId: { not: null },
      status: { in: ["todo", "in_progress"] },
    },
    select: { id: true, roomId: true, assignedUserId: true },
  });

  const tasksByRoomUser = new Map<string, string[]>();
  for (const task of activeTasks) {
    if (!task.assignedUserId) continue;
    const key = `${task.roomId}:${task.assignedUserId}`;
    const existing = tasksByRoomUser.get(key) ?? [];
    existing.push(task.id);
    tasksByRoomUser.set(key, existing);
  }

  for (const [key, taskIds] of tasksByRoomUser) {
    const [roomId, userId] = key.split(":");
    if (!roomId || !userId || taskIds.length === 0) continue;

    const hasWorkerAgentMessage = await prisma.message.findFirst({
      where: {
        roomId,
        channel: "worker",
        ownerUserId: userId,
        senderAgentId: { not: null },
      },
      orderBy: { createdAt: "desc" },
    });

    if (!hasWorkerAgentMessage) {
      workerKickoffAssignedTasks(roomId, userId, taskIds).catch((err) => {
        console.error("Worker startup kickoff failed:", err);
      });
    }
  }
}

async function processNewEvents() {
  const recentEvents = await prisma.event.findMany({
    where: {
      createdAt: { gte: new Date(Date.now() - 10000) }, // Last 10 seconds
      type: {
        in: [
          "task.status.updated",
          "task.assigned",
          "worker.progress.updated",
          "worker.blocked",
          "contract.proposed_change",
          "contract.published",
          "master.security.alert",
          "member.joined",
        ],
      },
    },
    orderBy: { createdAt: "asc" },
  });

  for (const event of recentEvents) {
    if (processedEvents.has(event.id)) continue;
    processedEvents.add(event.id);

    // Keep processed set bounded
    if (processedEvents.size > 10000) {
      const oldest = [...processedEvents].slice(0, 5000);
      oldest.forEach((id) => processedEvents.delete(id));
    }

    await masterHandleEvent(event.roomId, event.id, event.type, event.payload as Record<string, unknown>);
  }
}

async function masterHandleEvent(
  roomId: string,
  _eventId: string,
  type: string,
  payload: Record<string, unknown>,
) {
  switch (type) {
    case "task.status.updated": {
      const { taskId, status } = payload as { taskId: string; status: string };

      if (status === "done") {
        // Check if any downstream tasks can be unblocked
        await checkDependencyResolution(roomId, taskId);
      }

      if (status === "blocked") {
        // Ensure notebook entry exists
        const task = await prisma.task.findUnique({ where: { id: taskId as string } });
        if (task) {
          const recentEntry = await prisma.notebookEntry.findFirst({
            where: {
              roomId,
              category: "blocker",
              createdAt: { gte: new Date(Date.now() - 60000) },
              references: { path: ["taskIds"], array_contains: taskId },
            },
          });
          if (!recentEntry) {
            await prisma.notebookEntry.create({
              data: {
                roomId,
                category: "blocker",
                title: `Task Blocked: "${task.title}"`,
                content: `**Task blocked:** "${task.title}"\n\n**Reason:** ${task.blockedReason ?? "No reason provided"}\n\nThis blocker may affect dependent tasks. The Master Agent is monitoring for resolution.`,
                references: { taskIds: [taskId as string] },
              },
            });
          }
        }
      }

      if (status === "in_progress" || status === "review" || status === "done") {
        const task = await prisma.task.findUnique({
          where: { id: taskId },
          include: { assignedUser: { select: { id: true, name: true } } },
        });
        if (task) {
          const recentUpdate = await prisma.notebookEntry.findFirst({
            where: {
              roomId,
              category: "task_update",
              createdAt: { gte: new Date(Date.now() - 30000) },
              references: { path: ["taskIds"], array_contains: taskId },
            },
          });

          if (!recentUpdate) {
            const assigneeName = task.assignedUser?.name ?? "Unassigned";
            await prisma.notebookEntry.create({
              data: {
                roomId,
                category: "task_update",
                title: `Task ${status.replace("_", " ")}: "${task.title}"`,
                content: `**${assigneeName}** set task **${task.title}** to **${status}**.`,
                references: { taskIds: [task.id] },
              },
            });
          }
        }
      }
      break;
    }

    case "task.assigned": {
      const { taskId, assignedUserId } = payload as { taskId?: string; assignedUserId?: string };
      if (taskId && assignedUserId) {
        workerKickoffAssignedTasks(roomId, assignedUserId, [taskId]).catch((err) => {
          console.error("Worker kickoff from monitor failed:", err);
        });
      }
      break;
    }

    case "worker.blocked": {
      const { taskId, reason } = payload as { taskId: string; reason: string };
      await prisma.task.update({
        where: { id: taskId as string },
        data: { status: "blocked", blockedReason: reason },
      });
      break;
    }
  }
}

async function periodicSweep(roomId: string) {
  const staleTasks = await prisma.task.findMany({
    where: {
      roomId,
      status: { in: ["in_progress", "review"] },
      updatedAt: { lt: new Date(Date.now() - STALE_TASK_THRESHOLD_MS) },
    },
    include: { assignedUser: { select: { id: true, name: true } } },
  });

  if (staleTasks.length > 0) {
    // Notify each affected user
    const userTasks = new Map<string, typeof staleTasks>();
    for (const task of staleTasks) {
      if (!task.assignedUserId) continue;
      const existing = userTasks.get(task.assignedUserId) ?? [];
      existing.push(task);
      userTasks.set(task.assignedUserId, existing);
    }

    for (const [userId, tasks] of userTasks) {
      await emitEvent({
        roomId,
        visibility: "user",
        visibleToUserId: userId,
        type: "master.integration.alert",
        payload: {
          severity: "low",
          message: `📊 Status check: ${tasks.length} task(s) haven't been updated in a while — ${tasks.map((t) => `"${t.title}"`).join(", ")}. Please post an update or mark them blocked if stuck.`,
          relatedTaskIds: tasks.map((t) => t.id),
          relatedContractIds: [],
        },
      });
    }
  }

  // Check for dangling dependencies (tasks blocked waiting on already-done tasks)
  const blockedTasks = await prisma.task.findMany({
    where: { roomId, status: "blocked" },
  });

  for (const task of blockedTasks) {
    await checkDependencyResolution(roomId, task.id);
  }

  // Validate contract/task graph consistency
  await validateContractGraph(roomId);
}

async function validateContractGraph(roomId: string) {
  // Find task-contract deps where contract no longer exists
  const allContracts = await prisma.contract.findMany({ where: { roomId }, select: { id: true } });
  const contractIds = new Set(allContracts.map((c) => c.id));

  const allTaskContractDeps = await prisma.taskContractDependency.findMany({
    where: { task: { roomId } },
    include: { task: true },
  });

  for (const dep of allTaskContractDeps) {
    if (!contractIds.has(dep.contractId)) {
      // Dangling reference — clean up
      await prisma.taskContractDependency.delete({ where: { id: dep.id } });
      console.warn(`[Monitor] Cleaned dangling contract dep ${dep.id} in room ${roomId}`);
    }
  }
}
