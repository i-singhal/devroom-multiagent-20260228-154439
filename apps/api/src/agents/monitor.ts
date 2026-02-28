import { Server as SocketServer } from "socket.io";
import { prisma } from "../db";
import { emitEvent } from "../websocket";
import { masterHandleContractPublished, checkDependencyResolution } from "./master";
import { workerKickoffAssignedTasks } from "./worker";
import { getRoomRepoStatus } from "../services/roomRepo";

const SWEEP_INTERVAL_MS = 30 * 1000; // 30 seconds
const STALE_TASK_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const SIGNAL_COOLDOWN_MS = 90 * 1000;

let monitorRunning = false;
const processedEvents = new Set<string>();
const lastSignalAt = new Map<string, number>();

function shouldEmitSignal(key: string, cooldownMs = SIGNAL_COOLDOWN_MS) {
  const now = Date.now();
  const last = lastSignalAt.get(key) ?? 0;
  if (now - last < cooldownMs) return false;
  lastSignalAt.set(key, now);
  return true;
}

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
      createdAt: { gte: new Date(Date.now() - 60000) }, // Last 60 seconds
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
          const blockedKey = `task-blocked:${roomId}:${task.id}:${task.blockedReason ?? ""}`;
          if (shouldEmitSignal(blockedKey, 45000)) {
            await emitEvent({
              roomId,
              visibility: "global",
              type: "master.integration.alert",
              payload: {
                severity: "medium",
                message: `Task blocked: "${task.title}"${task.blockedReason ? ` — ${task.blockedReason}` : ""}`,
                relatedTaskIds: [task.id],
                relatedContractIds: [],
              },
            });
          }

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

      await monitorRoomRepoSignals(roomId);
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

    case "worker.progress.updated":
    case "contract.published":
    case "member.joined": {
      await monitorRoomRepoSignals(roomId);
      break;
    }

    case "master.security.alert": {
      const severity = String(payload.severity ?? "medium");
      const message = String(payload.message ?? "Security alert raised.");
      const dedupeKey = `sec:${roomId}:${message.slice(0, 120)}`;
      if (shouldEmitSignal(dedupeKey, 120000)) {
        await prisma.notebookEntry.create({
          data: {
            roomId,
            category: "integration",
            title: `Security Alert (${severity})`,
            content: message,
            references: {},
          },
        }).catch(() => undefined);
      }
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
  await monitorRoomRepoSignals(roomId);
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

async function monitorRoomRepoSignals(roomId: string) {
  let status;
  try {
    status = await getRoomRepoStatus(roomId);
  } catch (err) {
    const key = `repo-status-failed:${roomId}`;
    if (shouldEmitSignal(key, 180000)) {
      await emitEvent({
        roomId,
        visibility: "global",
        type: "master.integration.alert",
        payload: {
          severity: "medium",
          message: `Repository monitoring failed: ${String(err).slice(0, 200)}`,
          relatedTaskIds: [],
          relatedContractIds: [],
        },
      });
    }
    return;
  }

  if (!status.repoReady) {
    const key = `repo-not-ready:${roomId}`;
    if (shouldEmitSignal(key, 180000)) {
      await emitEvent({
        roomId,
        visibility: "global",
        type: "master.integration.alert",
        payload: {
          severity: "high",
          message: `Repository workspace is not ready. ${status.repoLastError ?? "Agentic execution is paused until this is fixed."}`,
          relatedTaskIds: [],
          relatedContractIds: [],
        },
      });
    }
    return;
  }

  if (status.mergeConflictFiles.length > 0) {
    const key = `repo-conflicts:${roomId}:${status.mergeConflictFiles.join(",")}`;
    if (shouldEmitSignal(key)) {
      await emitEvent({
        roomId,
        visibility: "global",
        type: "master.integration.alert",
        payload: {
          severity: "high",
          message: `Merge conflicts detected in room repo: ${status.mergeConflictFiles.slice(0, 5).join(", ")}.`,
          relatedTaskIds: [],
          relatedContractIds: [],
        },
      });
    }
  }

  if (status.behindBy > 0) {
    const key = `repo-behind:${roomId}:${status.behindBy}`;
    if (shouldEmitSignal(key, 150000)) {
      await emitEvent({
        roomId,
        visibility: "global",
        type: "master.integration.alert",
        payload: {
          severity: "low",
          message: `Room repo is behind origin by ${status.behindBy} commit(s). Sync recommended before major merges.`,
          relatedTaskIds: [],
          relatedContractIds: [],
        },
      });
    }
  }

  if (status.changedFiles > 40) {
    const key = `repo-dirty:${roomId}`;
    if (shouldEmitSignal(key, 120000)) {
      await emitEvent({
        roomId,
        visibility: "global",
        type: "master.integration.alert",
        payload: {
          severity: "low",
          message: `Large uncommitted delta detected (${status.changedFiles} files). Consider splitting into smaller commits to reduce integration risk.`,
          relatedTaskIds: [],
          relatedContractIds: [],
        },
      });
    }
  }

  if (status.trackedEnvFiles.length > 0) {
    const key = `tracked-env:${roomId}:${status.trackedEnvFiles.join(",")}`;
    if (shouldEmitSignal(key, 180000)) {
      await emitEvent({
        roomId,
        visibility: "global",
        type: "master.security.alert",
        payload: {
          severity: "high",
          message: `Sensitive env file tracked in git: ${status.trackedEnvFiles.slice(0, 5).join(", ")}. Remove and rotate secrets.`,
          action: "repo.env_file_tracked",
          detail: status.trackedEnvFiles.join(","),
        },
      });
    }
  }

  if (status.potentialSecrets.length > 0) {
    const key = `secret-hit:${roomId}:${status.potentialSecrets[0]}`;
    if (shouldEmitSignal(key, 180000)) {
      await emitEvent({
        roomId,
        visibility: "global",
        type: "master.security.alert",
        payload: {
          severity: "high",
          message: `Potential secret detected in repository content. Review immediately.`,
          action: "repo.potential_secret",
          detail: status.potentialSecrets.slice(0, 3).join(" | "),
        },
      });
    }
  }
}
