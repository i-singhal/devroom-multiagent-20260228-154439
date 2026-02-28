import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireAuth, requireRoomMember, requireRoomAdmin } from "../middleware/auth";
import { emitEvent } from "../websocket";
import { masterPlanRoom } from "../agents/master";
import { workerKickoffAssignedTasks } from "../agents/worker";
import axios from 'axios';
import { ensureRoomRepoWorkspace, getRoomRepoStatus, maybeCreateGitHubRepo, syncRoomRepo } from "../services/roomRepo";

const router = Router();

const API_KEY = process.env.YOUTUBE_API_KEY;
const YOUTUBE_API_URL = "https://www.googleapis.com/youtube/v3/search";

async function fetchYouTubeTitles(query: string) {
  try {
    const response = await axios.get(YOUTUBE_API_URL, {
      params: {
        part: 'snippet',
        q: query,
        key: API_KEY,
        maxResults: 5
      }
    });

    return response.data.items.map((item: any) => item.snippet.title);
  } catch (error) {
    console.error("Error fetching YouTube titles:", error);
    throw new Error("Failed to fetch YouTube titles");
  }
}


// Existing functions...

type PlanMember = {
  userId: string;
  role: string;
  user: { id: string; name: string };
};

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

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function resolveAssigneeFromHint(hint: string | undefined, members: PlanMember[]): PlanMember | null {
  if (!hint) return null;
  const normalizedHint = normalizeName(hint);
  if (!normalizedHint) return null;

  const exact = members.find((m) => normalizeName(m.user.name) === normalizedHint);
  if (exact) return exact;

  const contains = members.find((m) => {
    const normalizedMemberName = normalizeName(m.user.name);
    return normalizedMemberName.includes(normalizedHint) || normalizedHint.includes(normalizedMemberName);
  });
  if (contains) return contains;

  const hintTokens = new Set(normalizedHint.split(" ").filter(Boolean));
  let bestMember: PlanMember | null = null;
  let bestScore = 0;

  for (const member of members) {
    const memberTokens = normalizeName(member.user.name).split(" ").filter(Boolean);
    const overlap = memberTokens.filter((token) => hintTokens.has(token)).length;
    if (overlap > bestScore) {
      bestScore = overlap;
      bestMember = member;
    }
  }

  return bestScore > 0 ? bestMember : null;
}

// POST /rooms
router.post("/", requireAuth, async (req, res) => {
  try {
    const data = z.object({
      title: z.string().min(1),
      goal: z.string().min(1),
      repositoryUrl: z.string().url().optional(),
      createGithubRepo: z.boolean().optional(),
      repositoryName: z.string().min(1).max(100).optional(),
      githubVisibility: z.enum(["private", "public"]).optional(),
    }).parse(req.body);
    const user = res.locals.user;

    const room = await prisma.room.create({
      data: {
        title: data.title,
        goal: data.goal,
        repoRemoteUrl: data.repositoryUrl?.trim() || null,
        memberships: {
          create: { userId: user.id, role: "owner" },
        },
        agents: {
          create: { type: "master" },
        },
      },
    });

    let repoRemoteUrl = data.repositoryUrl?.trim() || null;
    let repoBootstrapNote: string | null = null;

    if (!repoRemoteUrl && (data.createGithubRepo ?? true)) {
      try {
        const created = await maybeCreateGitHubRepo({
          roomId: room.id,
          roomTitle: room.title,
          requestedName: data.repositoryName,
          visibility: data.githubVisibility,
        });
        if (created) {
          repoRemoteUrl = created.cloneUrl;
          await prisma.room.update({
            where: { id: room.id },
            data: {
              repoRemoteUrl,
              repoDefaultBranch: created.defaultBranch || "main",
            },
          });

          await emitEvent({
            roomId: room.id,
            visibility: "global",
            type: "master.integration.alert",
            payload: {
              severity: "low",
              message: `GitHub repository created for this room: ${created.htmlUrl}`,
              relatedTaskIds: [],
              relatedContractIds: [],
            },
          });
        }
      } catch (err) {
        repoBootstrapNote = `GitHub auto-create failed: ${String(err).slice(0, 500)}`;
      }
    }

    const repoSetup = await ensureRoomRepoWorkspace({
      id: room.id,
      title: room.title,
      workspacePath: room.workspacePath,
      repoRemoteUrl,
      repoDefaultBranch: room.repoDefaultBranch,
    });

    if (repoBootstrapNote || repoSetup.repoLastError) {
      await emitEvent({
        roomId: room.id,
        visibility: "global",
        type: "master.integration.alert",
        payload: {
          severity: "medium",
          message: `Repository bootstrap warning: ${repoBootstrapNote || repoSetup.repoLastError}`,
          relatedTaskIds: [],
          relatedContractIds: [],
        },
      });
    }

    const createdRoom = await prisma.room.findUnique({ where: { id: room.id } });
    res.status(201).json(createdRoom);
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: err.errors }); return; }
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /rooms/:id/repo
router.get("/:id/repo", requireAuth, requireRoomMember, async (req, res) => {
  const { id } = req.params;
  try {
    const status = await getRoomRepoStatus(id);
    res.json(status);
  } catch (err) {
    console.error("Repo status error:", err);
    res.status(500).json({ error: "Failed to get repo status", detail: String(err) });
  }
});

// POST /rooms/:id/repo/sync
router.post("/:id/repo/sync", requireAuth, requireRoomAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await syncRoomRepo(id);
    if (!result.synced) {
      await emitEvent({
        roomId: id,
        visibility: "global",
        type: "master.integration.alert",
        payload: {
          severity: "medium",
          message: result.reason || result.error || "Repository sync did not complete cleanly.",
          relatedTaskIds: [],
          relatedContractIds: [],
        },
      });
    }
    res.json(result);
  } catch (err) {
    console.error("Repo sync error:", err);
    res.status(500).json({ error: "Failed to sync repo", detail: String(err) });
  }
});

// Fetch YouTube titles
router.get("/:id/youtube-titles", requireAuth, requireRoomMember, async (req, res) => {
  try {
    const { id } = req.params;
    const room = await prisma.room.findUnique({ where: { id } });

    if (!room) {
      res.status(404).json({ error: "Room not found" });
      return;
    }

    const titles = await fetchYouTubeTitles(room.title);
    res.json({ titles });
  } catch (err) {
    console.error("Error fetching YouTube titles:", err);
    res.status(500).json({ error: "Failed to fetch YouTube titles" });
  }
});

// GET /rooms
router.get("/", requireAuth, async (req, res) => {
  const user = res.locals.user;
  const memberships = await prisma.membership.findMany({
    where: { userId: user.id },
    include: { room: true },
  });
  res.json(memberships.map((m) => ({ ...m.room, role: m.role })));
});

// GET /rooms/:id
router.get("/:id", requireAuth, requireRoomMember, async (req, res) => {
  const { id } = req.params;
  const user = res.locals.user;
  const membership = res.locals.membership;

  const [room, memberships, tasks, contracts, notebook] = await Promise.all([
    prisma.room.findUnique({ where: { id } }),
    prisma.membership.findMany({
      where: { roomId: id },
      include: { user: { select: { id: true, name: true, email: true } } },
    }),
    prisma.task.findMany({
      where: { roomId: id },
      include: {
        assignedUser: { select: { id: true, name: true, email: true } },
        fromDependencies: true,
        toDependencies: true,
        contractDeps: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.contract.findMany({
      where: { roomId: id },
      include: { versions: { orderBy: { version: "desc" } } },
    }),
    prisma.notebookEntry.findMany({
      where: { roomId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);

  res.json({
    ...room,
    memberships,
    tasks,
    contracts,
    notebookPreview: notebook,
    myRole: membership.role,
    myUserId: user.id,
  });
});

// POST /rooms/:id/plan
router.post("/:id/plan", requireAuth, requireRoomAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const room = await prisma.room.findUnique({ where: { id } });
    if (!room) { res.status(404).json({ error: "Room not found" }); return; }

    await ensureRoomRepoWorkspace({
      id: room.id,
      title: room.title,
      workspacePath: room.workspacePath,
      repoRemoteUrl: room.repoRemoteUrl,
      repoDefaultBranch: room.repoDefaultBranch,
    });

    const members = await prisma.membership.findMany({
      where: { roomId: id },
      include: { user: { select: { id: true, name: true } } },
    });

    const result = await masterPlanRoom(room, members);
    const preferredMembers = members.filter((m) => m.role !== "owner");
    const assignableMembers = (preferredMembers.length > 0 ? preferredMembers : members)
      .slice()
      .sort((a, b) => roleRank(a.role) - roleRank(b.role));

    // Persist plan
    const createdTasks = new Map<string, string>();
    const taskAssignments: Array<{ taskId: string; taskTitle: string; assignedUserId: string }> = [];
    const assignedUserIds = new Set<string>();
    let roundRobinIndex = 0;

    for (const t of result.tasks) {
      const hintedMember = resolveAssigneeFromHint(t.assigneeHint, assignableMembers);
      const fallbackMember = assignableMembers.length > 0
        ? assignableMembers[roundRobinIndex++ % assignableMembers.length]
        : null;
      const assignee = hintedMember ?? fallbackMember;

      const task = await prisma.task.create({
        data: {
          roomId: id,
          title: t.title,
          description: t.description,
          acceptanceCriteria: t.acceptanceCriteria.join("\n"),
          assignedUserId: assignee?.userId,
        },
      });
      createdTasks.set(t.title, task.id);

      if (assignee) {
        taskAssignments.push({
          taskId: task.id,
          taskTitle: task.title,
          assignedUserId: assignee.userId,
        });
        assignedUserIds.add(assignee.userId);
      }
    }

    // Dependencies
    for (const dep of result.dependencies) {
      const fromId = createdTasks.get(dep.fromTitle);
      const toId = createdTasks.get(dep.toTitle);
      if (fromId && toId) {
        await prisma.taskDependency.create({
          data: { roomId: id, fromTaskId: fromId, toTaskId: toId },
        });
      }
    }

    // Contracts
    for (const c of result.contracts) {
      const contract = await prisma.contract.create({
        data: { roomId: id, name: c.name, type: c.type },
      });
      const version = await prisma.contractVersion.create({
        data: {
          contractId: contract.id,
          version: 1,
          content: c.initialContent,
          summary: c.summary,
          breaking: false,
        },
      });
      await prisma.contract.update({
        where: { id: contract.id },
        data: { currentVersionId: version.id },
      });
    }

    for (const assignedUserId of assignedUserIds) {
      const existing = await prisma.agentInstance.findFirst({
        where: { roomId: id, type: "worker", userId: assignedUserId },
      });
      if (!existing) {
        await prisma.agentInstance.create({
          data: { roomId: id, type: "worker", userId: assignedUserId },
        });
      }
    }

    for (const assignment of taskAssignments) {
      await emitEvent({
        roomId: id,
        visibility: "user",
        visibleToUserId: assignment.assignedUserId,
        type: "task.assigned",
        payload: {
          taskId: assignment.taskId,
          taskTitle: assignment.taskTitle,
          assignedUserId: assignment.assignedUserId,
        },
      });
    }

    const assignedTaskIdsByUser = new Map<string, string[]>();
    for (const assignment of taskAssignments) {
      const existing = assignedTaskIdsByUser.get(assignment.assignedUserId) ?? [];
      existing.push(assignment.taskId);
      assignedTaskIdsByUser.set(assignment.assignedUserId, existing);
    }

    for (const [assignedUserId, taskIds] of assignedTaskIdsByUser) {
      workerKickoffAssignedTasks(id, assignedUserId, taskIds).catch((err) => {
        console.error("Worker kickoff failed:", err);
      });
    }

    // Notebook entry
    const entry = await prisma.notebookEntry.create({
      data: {
        roomId: id,
        category: "decision",
        title: "Master Plan Created",
        content: result.notesForNotebook,
        references: { taskIds: [...createdTasks.values()] },
      },
    });

    await emitEvent({
      roomId: id,
      visibility: "global",
      type: "notebook.entry.added",
      payload: { entryId: entry.id, category: "decision", title: entry.title },
    });

    res.json({ ok: true, taskCount: result.tasks.length, contractCount: result.contracts.length });
  } catch (err) {
    console.error("Plan error:", err);
    res.status(500).json({ error: "Plan generation failed", detail: String(err) });
  }
});

export default router;
