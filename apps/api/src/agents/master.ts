import OpenAI from "openai";
import { prisma } from "../db";
import { emitEvent, emitMessage } from "../websocket";
import type { MasterPlanOutput } from "@devroom/shared";
import { workerKickoffAssignedTasks } from "./worker";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MASTER_MODEL = process.env.OPENAI_MODEL?.trim() || "gpt-4o";
const FAST_MODEL = process.env.OPENAI_FAST_MODEL?.trim() || "gpt-4o-mini";

type RoomMember = {
  userId: string;
  role: string;
  user: { id: string; name: string };
};

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function pickMentionedMembers(content: string, members: RoomMember[]): RoomMember[] {
  const normalizedContent = normalizeName(content);
  if (!normalizedContent) return [];

  const mentionsAll = /(everyone|all members|all teammates|team|all of us)/i.test(content);
  if (mentionsAll) return members;

  const matched = members.filter((member) => {
    const full = normalizeName(member.user.name);
    if (!full) return false;
    if (normalizedContent.includes(full)) return true;

    const parts = full.split(" ").filter(Boolean);
    if (parts.length > 1) {
      return parts.every((p) => normalizedContent.includes(p));
    }
    return false;
  });

  return matched;
}

function isReassignIntent(content: string) {
  return /(assign|reassign|rebalance|split|distribute)/i.test(content)
    && /(task|workload|work)/i.test(content);
}

async function rebalanceTasksByMembers(params: {
  roomId: string;
  requestedByName: string;
  members: RoomMember[];
  tasks: Array<{ id: string; title: string; status: string; assignedUserId: string | null; createdAt: Date }>;
  equalMode: boolean;
}) {
  const { roomId, requestedByName, members, tasks, equalMode } = params;
  const activeTasks = tasks
    .filter((task) => task.status !== "done")
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  if (activeTasks.length === 0) {
    return {
      changedCount: 0,
      summary: "No active tasks to rebalance.",
      changedTaskIds: [] as string[],
      targetMemberNames: members.map((m) => m.user.name),
    };
  }

  const taskIdsByUser = new Map<string, string[]>();
  const assigneeByTaskId = new Map<string, RoomMember>();
  const changedTaskIds: string[] = [];
  const assignmentLines: string[] = [];

  for (let i = 0; i < activeTasks.length; i++) {
    const task = activeTasks[i];
    if (!task) continue;
    const target = equalMode ? members[i % members.length] : members[0];
    if (!target) continue;
    assigneeByTaskId.set(task.id, target);

    if (task.assignedUserId !== target.userId) {
      await prisma.task.update({
        where: { id: task.id },
        data: { assignedUserId: target.userId },
      });
      changedTaskIds.push(task.id);
    }

    const existing = taskIdsByUser.get(target.userId) ?? [];
    existing.push(task.id);
    taskIdsByUser.set(target.userId, existing);
  }

  for (const task of activeTasks) {
    const target = assigneeByTaskId.get(task.id);
    if (!target) continue;
    assignmentLines.push(`- [${task.status}] ${task.title} -> ${target.user.name}`);
  }

  for (const [userId, taskIds] of taskIdsByUser) {
    const existingAgent = await prisma.agentInstance.findFirst({
      where: { roomId, type: "worker", userId },
    });
    if (!existingAgent) {
      await prisma.agentInstance.create({
        data: { roomId, type: "worker", userId },
      });
    }

    for (const taskId of taskIds) {
      const task = activeTasks.find((t) => t.id === taskId);
      if (!task) continue;
      await emitEvent({
        roomId,
        visibility: "user",
        visibleToUserId: userId,
        type: "task.assigned",
        payload: {
          taskId: task.id,
          taskTitle: task.title,
          assignedUserId: userId,
        },
      });
      await emitEvent({
        roomId,
        visibility: "global",
        type: "task.status.updated",
        payload: {
          taskId: task.id,
          taskTitle: task.title,
          status: task.status,
          assignedUserId: userId,
        },
      });
    }
  }

  for (const [userId, taskIds] of taskIdsByUser) {
    workerKickoffAssignedTasks(roomId, userId, taskIds).catch((err) => {
      console.error("Worker kickoff after master reassignment failed:", err);
    });
  }

  const summary = `I executed the reassignment requested by ${requestedByName}.\n\nAssigned members: ${members.map((m) => m.user.name).join(", ")}\nUpdated tasks: ${changedTaskIds.length}/${activeTasks.length}\n\nCurrent active-task assignment:\n${assignmentLines.join("\n")}`;

  await prisma.notebookEntry.create({
    data: {
      roomId,
      category: "task_update",
      title: "Master Rebalanced Task Assignments",
      content: summary,
      references: { taskIds: activeTasks.map((t) => t.id) },
    },
  }).catch(() => undefined);

  await emitEvent({
    roomId,
    visibility: "global",
    type: "master.integration.alert",
    payload: {
      severity: "low",
      message: `Master rebalanced active tasks across ${members.length} member(s): ${members.map((m) => m.user.name).join(", ")}.`,
      relatedTaskIds: activeTasks.map((t) => t.id),
      relatedContractIds: [],
    },
  }).catch(() => undefined);

  return {
    changedCount: changedTaskIds.length,
    summary,
    changedTaskIds,
    targetMemberNames: members.map((m) => m.user.name),
  };
}

async function maybeExecuteMasterAction(params: {
  roomId: string;
  content: string;
  requestedByName: string;
  members: RoomMember[];
  tasks: Array<{ id: string; title: string; status: string; assignedUserId: string | null; createdAt: Date }>;
}) {
  const { roomId, content, requestedByName, members, tasks } = params;
  if (!isReassignIntent(content)) return null;

  const mentionedMembers = pickMentionedMembers(content, members);
  const targets = mentionedMembers.length > 0 ? mentionedMembers : members;
  if (targets.length === 0) {
    return {
      applied: false,
      message: "No room members found to assign tasks to.",
    };
  }

  const equalMode = /(equal|equally|split|balance|rebalance|distribute)/i.test(content) || targets.length > 1;
  const result = await rebalanceTasksByMembers({
    roomId,
    requestedByName,
    members: targets,
    tasks,
    equalMode,
  });

  return {
    applied: true,
    message: result.summary,
  };
}

// ─── Master Planning ──────────────────────────────────────────────────────────

export async function masterPlanRoom(
  room: { id: string; title: string; goal: string },
  members: { userId: string; role: string; user: { id: string; name: string } }[],
): Promise<MasterPlanOutput> {
  const memberCount = members.length;
  const memberList = members.map((m) => `${m.user.name} (${m.role})`).join(", ");

  const response = await openai.chat.completions.create({
    model: MASTER_MODEL,
    max_tokens: 4096,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are the Master Orchestration Agent for a software development room.
Return ONLY valid JSON matching this exact schema:
{
  "tasks": [{ "title": "string", "description": "string", "acceptanceCriteria": ["string"], "assigneeHint": "string?" }],
  "dependencies": [{ "fromTitle": "string", "toTitle": "string" }],
  "contracts": [{ "name": "string", "type": "openapi|typescript|jsonschema|protobuf|other", "initialContent": "string", "summary": "string" }],
  "notesForNotebook": "string"
}
Rules: 3-8 tasks, 1-4 contracts, dependencies only if truly sequential, assigneeHint MUST be an exact full name from Team list or omitted, initialContent should be a realistic stub.`,
      },
      {
        role: "user",
        content: `Room: "${room.title}"\nGoal: "${room.goal}"\nTeam: ${memberList} (${memberCount} people)\n\nGenerate the task breakdown and initial contracts.`,
      },
    ],
  });

  const text = response.choices[0].message.content ?? "{}";
  return JSON.parse(text) as MasterPlanOutput;
}

// ─── Contract Impact Analysis ─────────────────────────────────────────────────

export async function masterHandleContractPublished(
  roomId: string,
  contractId: string,
  versionId: string,
  breaking: boolean,
  summary: string,
) {
  const [contract, version, taskDeps] = await Promise.all([
    prisma.contract.findUnique({ where: { id: contractId } }),
    prisma.contractVersion.findUnique({ where: { id: versionId } }),
    prisma.taskContractDependency.findMany({
      where: { contractId },
      include: {
        task: { include: { assignedUser: { select: { id: true, name: true } } } },
      },
    }),
  ]);

  if (!contract || !version) return;

  const impactedTasks = taskDeps.map((d) => d.task);
  const impactedTaskIds = impactedTasks.map((t) => t.id);
  const impactedUsers = [...new Set(
    impactedTasks.filter((t) => t.assignedUserId).map((t) => t.assignedUserId as string),
  )];

  let impactSummary = `Contract "${contract.name}" v${version.version} published. ${breaking ? "⚠️ Breaking change." : ""} ${impactedTasks.length} tasks affected.`;
  let recommendedActions = ["Review updated contract", "Test integration points"];

  try {
    const aiResponse = await openai.chat.completions.create({
      model: FAST_MODEL,
      max_tokens: 512,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a Master Orchestration Agent analyzing a contract change. Return JSON only: { "impactSummary": "...", "recommendedActions": ["..."] }`,
        },
        {
          role: "user",
          content: `Contract: "${contract.name}" (${contract.type})\nVersion: ${version.version}\nBreaking: ${breaking}\nChange: ${summary}\nImpacted tasks: ${impactedTasks.map((t) => `"${t.title}" (${t.status})`).join(", ")}`,
        },
      ],
    });
    const parsed = JSON.parse(aiResponse.choices[0].message.content ?? "{}");
    impactSummary = parsed.impactSummary ?? impactSummary;
    recommendedActions = parsed.recommendedActions ?? recommendedActions;
  } catch (e) {
    console.warn("AI impact analysis failed, using defaults:", e);
  }

  // Emit user-level alerts
  for (const userId of impactedUsers) {
    await emitEvent({
      roomId,
      visibility: "user",
      visibleToUserId: userId,
      type: "master.impact.alert",
      payload: { contractId, contractName: contract.name, impactedTaskIds, summary: impactSummary, recommendedActions },
    });
  }

  // High severity global alert for breaking changes
  if (breaking && impactedTasks.length > 0) {
    await emitEvent({
      roomId,
      visibility: "global",
      type: "master.integration.alert",
      payload: {
        severity: "high",
        message: `⚠️ Breaking contract change: "${contract.name}" v${version.version}. ${impactedTasks.length} tasks affected. ${impactSummary}`,
        relatedTaskIds: impactedTaskIds,
        relatedContractIds: [contractId],
      },
    });
  }

  // Block impacted tasks
  for (const task of impactedTasks) {
    if (task.status !== "done" && task.status !== "blocked") {
      await prisma.task.update({
        where: { id: task.id },
        data: {
          status: "blocked",
          blockedReason: `Contract "${contract.name}" updated (v${version.version}): ${summary}`,
        },
      });
    }
  }

  // Notebook entry
  const entry = await prisma.notebookEntry.create({
    data: {
      roomId,
      category: "contract_change",
      title: `Contract Published: ${contract.name} v${version.version}`,
      content: `**What changed:** ${summary}\n\n**Breaking:** ${breaking ? "Yes ⚠️" : "No"}\n\n**Impact:** ${impactSummary}\n\n**Impacted tasks:** ${impactedTasks.map((t) => `- ${t.title} (${t.assignedUser?.name ?? "unassigned"})`).join("\n")}\n\n**Recommended actions:**\n${recommendedActions.map((a) => `- ${a}`).join("\n")}`,
      references: { contractIds: [contractId], taskIds: impactedTaskIds },
    },
  });

  await emitEvent({
    roomId,
    visibility: "global",
    type: "notebook.entry.added",
    payload: { entryId: entry.id, category: "contract_change", title: entry.title },
  });
}

// ─── Master Chat Handler ──────────────────────────────────────────────────────

export async function masterHandleMessage(roomId: string, fromUserId: string, content: string) {
  const [room, tasks, contracts, recentMessages, memberships] = await Promise.all([
    prisma.room.findUnique({ where: { id: roomId } }),
    prisma.task.findMany({
      where: { roomId },
      include: { assignedUser: { select: { id: true, name: true } } },
    }),
    prisma.contract.findMany({
      where: { roomId },
      include: { versions: { orderBy: { version: "desc" }, take: 1 } },
    }),
    prisma.message.findMany({
      where: { roomId, channel: "master" },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { senderUser: { select: { id: true, name: true } } },
    }),
    prisma.membership.findMany({
      where: { roomId },
      include: { user: { select: { id: true, name: true } } },
    }),
  ]);

  const user = await prisma.user.findUnique({ where: { id: fromUserId } });
  if (!room || !user) return;

  const actionResult = await maybeExecuteMasterAction({
    roomId,
    content,
    requestedByName: user.name,
    members: memberships,
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      assignedUserId: t.assignedUserId,
      createdAt: t.createdAt,
    })),
  });

  const taskSummary = tasks.length > 0
    ? tasks.map((t) => `- [${t.status}] ${t.title} → ${t.assignedUser?.name ?? "unassigned"}`).join("\n")
    : "- none yet";
  const contractSummary = contracts.length > 0
    ? contracts.map((c) => `- ${c.name} (${c.type}) v${c.versions[0]?.version ?? 0}`).join("\n")
    : "- none yet";
  const teamSummary = memberships.length > 0
    ? memberships.map((m) => `- ${m.user.name} (${m.role})`).join("\n")
    : "- none";
  const teamProgressSummary = memberships.length > 0
    ? memberships.map((m) => {
      const owned = tasks.filter((t) => t.assignedUserId === m.userId);
      const byStatus = {
        todo: owned.filter((t) => t.status === "todo").length,
        in_progress: owned.filter((t) => t.status === "in_progress").length,
        review: owned.filter((t) => t.status === "review").length,
        blocked: owned.filter((t) => t.status === "blocked").length,
        done: owned.filter((t) => t.status === "done").length,
      };
      const activeTitles = owned
        .filter((t) => t.status === "in_progress" || t.status === "review")
        .slice(0, 3)
        .map((t) => `"${t.title}"`)
        .join(", ");
      return `- ${m.user.name}: todo=${byStatus.todo}, in_progress=${byStatus.in_progress}, review=${byStatus.review}, blocked=${byStatus.blocked}, done=${byStatus.done}${activeTitles ? ` | active: ${activeTitles}` : ""}`;
    }).join("\n")
    : "- no members";

  const history: OpenAI.Chat.ChatCompletionMessageParam[] = recentMessages
    .reverse()
    .slice(-10)
    .map((m) => ({
      role: m.senderAgentId ? ("assistant" as const) : ("user" as const),
      content: m.senderAgentId ? m.content : `${m.senderUser?.name ?? "Teammate"}: ${m.content}`,
    }));

  let replyContent = "";
  if (actionResult) {
    replyContent = actionResult.message;
  } else {
    const response = await openai.chat.completions.create({
      model: MASTER_MODEL,
      max_tokens: 1024,
      messages: [
        {
          role: "system",
          content: `You are the Master Orchestration Agent for room "${room.title}".
Goal: ${room.goal}

Current tasks:\n${taskSummary}

Contracts:\n${contractSummary}

Team roster (and only valid member names):\n${teamSummary}

Team progress snapshot:\n${teamProgressSummary}

You coordinate work across the team. Your responses are visible to everyone.
Rules:
- Never invent teammates or mention people not in the team roster.
- If asked to assign/reassign workload, confirm you will execute it and reflect actual room state.
- If a requested person is not in the roster, say so clearly.
- If asked "what everyone is doing", answer from task assignments/status only.
- Do not reveal private worker chat contents.
- Be concise, actionable, and professional.`,
        },
        ...history,
        { role: "user", content: `${user.name}: ${content}` },
      ],
    });
    replyContent = response.choices[0].message.content ?? "";
  }

  if (!replyContent) return;

  const masterAgent = await prisma.agentInstance.findFirst({
    where: { roomId, type: "master" },
  });

  const msg = await prisma.message.create({
    data: {
      roomId,
      channel: "master",
      senderAgentId: masterAgent?.id,
      content: replyContent,
    },
    include: {
      senderUser: { select: { id: true, name: true, email: true } },
      senderAgent: { select: { id: true, type: true } },
    },
  });

  await emitMessage(roomId, "global", msg);
}

// ─── Dependency Resolution ────────────────────────────────────────────────────

export async function checkDependencyResolution(roomId: string, completedTaskId: string) {
  const dependents = await prisma.taskDependency.findMany({
    where: { fromTaskId: completedTaskId },
    include: {
      toTask: { include: { assignedUser: { select: { id: true, name: true } } } },
    },
  });

  for (const dep of dependents) {
    const task = dep.toTask;
    if (task.status !== "blocked") continue;

    const allDeps = await prisma.taskDependency.findMany({
      where: { toTaskId: task.id },
      include: { fromTask: true },
    });

    const allComplete = allDeps.every((d) => d.fromTask.status === "done");

    if (allComplete && task.blockedReason?.includes("dependency")) {
      await prisma.task.update({
        where: { id: task.id },
        data: { status: "todo", blockedReason: null },
      });

      if (task.assignedUserId) {
        await emitEvent({
          roomId,
          visibility: "user",
          visibleToUserId: task.assignedUserId,
          type: "task.unblocked",
          payload: { taskId: task.id, taskTitle: task.title, message: "Your blocking dependency is now complete!" },
        });
      }
    }
  }
}
