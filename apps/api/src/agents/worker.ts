import OpenAI from "openai";
import { prisma } from "../db";
import { emitEvent, emitMessage } from "../websocket";
import { runWorkerAgenticExecution } from "./agentic";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const WORKER_MODEL = "gpt-4o";
const REFUSAL_PATTERN = /(i\s+(?:can(?:not|'t)|do(?:\s+not|'nt)\s+have)\s+(?:the\s+)?capability|i(?:'m| am)\s+unable|as an ai[, ]+i\s+don'?t)/i;
const activeExecutionRuns = new Set<string>();

function buildTaskContext(assignedTasks: Array<{
  id: string;
  title: string;
  status: string;
  description: string;
  acceptanceCriteria: string;
  blockedReason: string | null;
  contractDeps: Array<{
    dependencyType: string;
    contract: {
      name: string;
      versions: Array<{ version: number }>;
    };
  }>;
  toDependencies: Array<{
    fromTask: { title: string; status: string };
  }>;
}>) {
  return assignedTasks.map((t) => `
Task: "${t.title}" [${t.status}]
Description: ${t.description}
Acceptance Criteria: ${t.acceptanceCriteria}
${t.blockedReason ? `Blocked Reason: ${t.blockedReason}` : ""}
Contracts: ${t.contractDeps.map((cd) => `${cd.dependencyType} ${cd.contract.name} (v${cd.contract.versions[0]?.version ?? 0})`).join(", ") || "none"}
Depends on: ${t.toDependencies.map((d) => `"${d.fromTask.title}" [${d.fromTask.status}]`).join(", ") || "none"}
  `.trim()).join("\n\n");
}

async function createWorkerAgentMessage(roomId: string, userId: string, content: string) {
  const workerAgent = await prisma.agentInstance.findFirst({
    where: { roomId, type: "worker", userId },
  });

  const msg = await prisma.message.create({
    data: {
      roomId,
      channel: "worker",
      ownerUserId: userId,
      senderAgentId: workerAgent?.id,
      content,
    },
    include: {
      senderUser: { select: { id: true, name: true, email: true } },
      senderAgent: { select: { id: true, type: true } },
    },
  });

  await emitMessage(roomId, "user", msg, userId);
}

async function loadWorkerContext(roomId: string, userId: string) {
  const [user, room, assignedTasks, recentMessages] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId } }),
    prisma.room.findUnique({ where: { id: roomId } }),
    prisma.task.findMany({
      where: { roomId, assignedUserId: userId },
      include: {
        contractDeps: {
          include: {
            contract: {
              include: { versions: { orderBy: { version: "desc" }, take: 1 } },
            },
          },
        },
        fromDependencies: { include: { toTask: true } },
        toDependencies: { include: { fromTask: true } },
      },
    }),
    prisma.message.findMany({
      where: { roomId, channel: "worker", ownerUserId: userId },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);

  return { user, room, assignedTasks, recentMessages };
}

function shouldRetryBlockedTask(userMessage: string) {
  return /(retry|again|re-run|rerun|continue|resume|go\s+for\s+it|do\s+the\s+task|fix\s+it)/i.test(userMessage);
}

function getActiveExecutionTaskIds(
  assignedTasks: Array<{ id: string; status: string; blockedReason?: string | null }>,
  userMessage: string,
) {
  const allowBlockedRetry = shouldRetryBlockedTask(userMessage);
  return assignedTasks
    .filter((task) => {
      if (task.status === "todo" || task.status === "in_progress") return true;
      if (!allowBlockedRetry || task.status !== "blocked") return false;
      const reason = (task.blockedReason ?? "").toLowerCase();
      return reason.includes("agentic") || reason.includes("patch") || reason.includes("verification");
    })
    .map((task) => task.id);
}

function buildAgenticFallback(userName: string, taskTitles: string[]) {
  const focus = taskTitles.length > 0
    ? taskTitles.map((title, index) => `${index + 1}. ${title}`).join("\n")
    : "1. Review assigned work and start implementation immediately.";

  return [
    `${userName}, I will execute this directly.`,
    "",
    "Immediate coding focus:",
    focus,
    "",
    "I am starting an autonomous implementation pass now and will post status/progress updates as code changes are made.",
  ].join("\n");
}

export async function workerHandleMessage(roomId: string, userId: string, userMessage: string) {
  const context = await loadWorkerContext(roomId, userId);
  if (!context.user || !context.room) return;
  const { user, room, assignedTasks, recentMessages } = context;

  const taskContext = buildTaskContext(assignedTasks);

  const conversationHistory: OpenAI.Chat.ChatCompletionMessageParam[] = recentMessages
    .reverse()
    .slice(-10)
    .map((m) => ({
      role: m.senderUserId === userId ? ("user" as const) : ("assistant" as const),
      content: m.content,
    }));

  const response = await openai.chat.completions.create({
    model: WORKER_MODEL,
    max_tokens: 2048,
    messages: [
      {
        role: "system",
        content: `You are a personal Worker Agent for ${user.name} in the dev room "${room.title}".
Goal: ${room.goal}

Your job is to help ${user.name} stay focused, make progress on their tasks, and avoid integration problems.
You have autonomous coding capability wired into this system and are expected to execute implementation work on assigned tasks.

${assignedTasks.length > 0 ? `Assigned tasks:\n${taskContext}` : "No tasks assigned yet."}

Guidelines:
- Help with technical questions, code review, architecture decisions
- When asked to do work, assume ownership and start execution immediately
- Warn if changes might affect shared contracts
- Suggest when to mark a task as blocked or done
- When contract changes are needed, remind user to use "Propose Contract Change"
- Never claim you cannot code or cannot make changes
- Keep responses focused, practical, and concise
- This is a PRIVATE conversation — only you and ${user.name} can see it`,
      },
      ...conversationHistory,
      { role: "user", content: userMessage },
    ],
  });

  const replyContentRaw = response.choices[0].message.content ?? "";
  const activeTaskTitles = assignedTasks
    .filter((task) => task.status === "todo" || task.status === "in_progress")
    .map((task) => task.title);
  const replyContent = !replyContentRaw || REFUSAL_PATTERN.test(replyContentRaw)
    ? buildAgenticFallback(user.name, activeTaskTitles)
    : replyContentRaw;

  await createWorkerAgentMessage(roomId, userId, replyContent);

  const executionTaskIds = getActiveExecutionTaskIds(assignedTasks, userMessage);
  const shouldRunAgentic = executionTaskIds.length > 0 && !/(only|just)\s+explain/i.test(userMessage);

  if (shouldRunAgentic) {
    const runKey = `${roomId}:${userId}`;
    if (activeExecutionRuns.has(runKey)) {
      await createWorkerAgentMessage(
        roomId,
        userId,
        "An autonomous execution pass is already running. I will post updates when it completes.",
      );
      return;
    }
    activeExecutionRuns.add(runKey);

    await createWorkerAgentMessage(
      roomId,
      userId,
      `Starting autonomous execution pass on your active tasks now (${executionTaskIds.length} task${executionTaskIds.length === 1 ? "" : "s"}).`,
    );

    runWorkerAgenticExecution({
      roomId,
      userId,
      taskIds: executionTaskIds,
      workerMessage: (content) => createWorkerAgentMessage(roomId, userId, content),
    })
      .catch((err) => {
        console.error("Agentic execution from worker message failed:", err);
      })
      .finally(() => {
        activeExecutionRuns.delete(runKey);
      });
  }
}

export async function workerKickoffAssignedTasks(roomId: string, userId: string, taskIds: string[] = []) {
  const assignmentWhere = taskIds.length > 0
    ? { roomId, assignedUserId: userId, id: { in: taskIds } }
    : { roomId, assignedUserId: userId };

  const newlyAssignedTasks = await prisma.task.findMany({
    where: assignmentWhere,
    include: { toDependencies: { include: { fromTask: true } } },
  });

  if (newlyAssignedTasks.length === 0) return;

  const readyTodoTasks = newlyAssignedTasks.filter((t) => {
    if (t.status !== "todo") return false;
    return t.toDependencies.every((dep) => dep.fromTask.status === "done");
  });

  for (const task of readyTodoTasks) {
    await prisma.task.update({
      where: { id: task.id },
      data: { status: "in_progress" },
    });

    await emitEvent({
      roomId,
      visibility: "global",
      type: "task.status.updated",
      payload: {
        taskId: task.id,
        taskTitle: task.title,
        status: "in_progress",
      },
    });
  }

  const context = await loadWorkerContext(roomId, userId);
  if (!context.user || !context.room) return;
  const { user, room, assignedTasks, recentMessages } = context;
  const taskContext = buildTaskContext(assignedTasks);

  const focusIds = new Set(taskIds);
  const focusedTasks = focusIds.size > 0
    ? assignedTasks.filter((task) => focusIds.has(task.id))
    : assignedTasks;

  const focusedTaskList = focusedTasks.length > 0
    ? focusedTasks.map((task) => `- ${task.title} [${task.status}]`).join("\n")
    : "- no specific task id was provided";

  const history: OpenAI.Chat.ChatCompletionMessageParam[] = recentMessages
    .reverse()
    .slice(-8)
    .map((m) => ({
      role: m.senderUserId === userId ? ("user" as const) : ("assistant" as const),
      content: m.content,
    }));

  let replyContent = "";

  try {
    const response = await openai.chat.completions.create({
      model: WORKER_MODEL,
      max_tokens: 900,
      messages: [
        {
          role: "system",
          content: `You are a personal Worker Agent for ${user.name} in the dev room "${room.title}".
Goal: ${room.goal}

Assigned tasks:\n${assignedTasks.length > 0 ? taskContext : "No tasks assigned yet."}

You are being auto-triggered because new tasks were assigned.
Output a concise execution kickoff:
- Immediate plan (3-6 bullets)
- First concrete implementation step to start now
- What status updates to post next
- Mention blockers only if real

Keep it practical and short. This is private to ${user.name}.`,
        },
        ...history,
        {
          role: "user",
          content: `Auto-trigger: start work on newly assigned tasks now.\nFocused tasks:\n${focusedTaskList}`,
        },
      ],
    });

    replyContent = response.choices[0].message.content ?? "";
  } catch (err) {
    console.warn("Worker kickoff generation failed, using fallback:", err);
  }

  if (!replyContent) {
    const fallbackLines = focusedTasks.map((task, index) =>
      `${index + 1}. ${task.title} — start by implementing the smallest acceptance criterion first, then update status/progress.`);
    replyContent = `I’ve started your newly assigned work.\n\nNext steps:\n${fallbackLines.join("\n") || "1. Review task details and begin implementation."}\n\nIf you hit a blocker, mark the task blocked with a concrete reason.`;
  }

  await createWorkerAgentMessage(roomId, userId, replyContent);

  const executionTaskIds = focusedTasks.map((task) => task.id);
  if (executionTaskIds.length > 0) {
    const runKey = `${roomId}:${userId}`;
    if (activeExecutionRuns.has(runKey)) {
      return;
    }
    activeExecutionRuns.add(runKey);

    await createWorkerAgentMessage(
      roomId,
      userId,
      `Auto-running an autonomous coding pass for your newly assigned task${executionTaskIds.length === 1 ? "" : "s"}.`,
    );

    runWorkerAgenticExecution({
      roomId,
      userId,
      taskIds: executionTaskIds,
      workerMessage: (content) => createWorkerAgentMessage(roomId, userId, content),
    })
      .catch((err) => {
        console.error("Agentic execution from assignment kickoff failed:", err);
      })
      .finally(() => {
        activeExecutionRuns.delete(runKey);
      });
  }
}

export async function workerHandleBlocked(
  roomId: string,
  userId: string,
  taskId: string,
  reason: string,
) {
  await prisma.task.update({
    where: { id: taskId },
    data: { status: "blocked", blockedReason: reason },
  });

  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) return;

  await prisma.notebookEntry.create({
    data: {
      roomId,
      category: "blocker",
      title: `Task Blocked: "${task.title}"`,
      content: `Task "${task.title}" is now blocked.\n\n**Reason:** ${reason}`,
      references: { taskIds: [taskId] },
    },
  });
}
