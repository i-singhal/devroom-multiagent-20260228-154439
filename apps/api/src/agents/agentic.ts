import OpenAI from "openai";
import { execFile } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { prisma } from "../db";
import { emitEvent } from "../websocket";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const AGENTIC_MODEL = "gpt-4o";
const executionLocks = new Set<string>();

type ExecutionPlan = {
  plan: string[];
  targetFiles: string[];
};

type PatchPlan = {
  patch: string;
  fileEdits: Array<{
    path: string;
    content: string;
  }>;
  verificationCommands: string[];
  progressSummary: string;
};

function workspaceRoot() {
  return process.env.AGENT_WORKSPACE_DIR || process.cwd();
}

function runShell(cwd: string, cmd: string, timeoutMs = 120000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "bash",
      ["-lc", cmd],
      { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 10 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${cmd}\n${stderr || stdout || error.message}`));
          return;
        }
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

function sanitizeFileList(filesRaw: string): string[] {
  const blockedDirs = [
    ".git/",
    "node_modules/",
    ".next/",
    "dist/",
    "build/",
    "coverage/",
    ".turbo/",
    ".cache/",
    ".idea/",
    ".vscode/",
  ];

  const allowedExtensions = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".json",
    ".md",
    ".css",
    ".scss",
    ".html",
    ".yml",
    ".yaml",
    ".sql",
    ".prisma",
    ".py",
    ".go",
    ".rs",
    ".java",
    ".kt",
    ".rb",
    ".php",
    ".sh",
    ".toml",
  ]);

  return filesRaw
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => !blockedDirs.some((dir) => f.startsWith(dir)))
    .filter((f) => {
      const ext = path.extname(f).toLowerCase();
      return allowedExtensions.has(ext) || f.endsWith("Dockerfile");
    })
    .slice(0, 1000);
}

function isSafeRelativePath(p: string): boolean {
  if (!p || path.isAbsolute(p)) return false;
  if (p.includes("..")) return false;
  return true;
}

function isSafeVerificationCommand(cmd: string): boolean {
  const normalized = cmd.trim().toLowerCase();
  const blockedTokens = ["rm -rf", "sudo", "shutdown", "reboot", "mkfs", "dd if=", "curl |", "wget |"];
  if (blockedTokens.some((token) => normalized.includes(token))) return false;

  return [
    "npm run",
    "npm test",
    "pnpm run",
    "pnpm test",
    "yarn ",
    "npx ",
    "pytest",
    "go test",
    "cargo test",
    "cargo check",
    "tsc",
  ].some((prefix) => normalized.startsWith(prefix));
}

function extractRunScriptName(cmd: string): string | null {
  const trimmed = cmd.trim();
  const npmLike = trimmed.match(/^(?:npm|pnpm)\s+run\s+([a-zA-Z0-9:_-]+)/);
  if (npmLike?.[1]) return npmLike[1];

  const yarnRun = trimmed.match(/^yarn\s+run\s+([a-zA-Z0-9:_-]+)/);
  if (yarnRun?.[1]) return yarnRun[1];

  const yarnDirect = trimmed.match(/^yarn\s+([a-zA-Z0-9:_-]+)/);
  if (yarnDirect?.[1] && yarnDirect[1] !== "run") return yarnDirect[1];

  return null;
}

async function canRunVerificationCommand(cwd: string, cmd: string): Promise<boolean> {
  if (!isSafeVerificationCommand(cmd)) return false;
  const scriptName = extractRunScriptName(cmd);
  if (!scriptName) return true;

  try {
    const pkgRaw = await fs.readFile(path.join(cwd, "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, unknown> };
    return !!pkg.scripts && Object.prototype.hasOwnProperty.call(pkg.scripts, scriptName);
  } catch {
    return true;
  }
}

async function ensurePatchApplies(cwd: string, patch: string) {
  const tmpPath = path.join(os.tmpdir(), `devroom-patch-${Date.now()}-${Math.random().toString(36).slice(2)}.diff`);
  await fs.writeFile(tmpPath, patch, "utf8");
  try {
    await runShell(cwd, `git apply --reject --whitespace=nowarn ${JSON.stringify(tmpPath)}`, 90000);
  } finally {
    await fs.unlink(tmpPath).catch(() => undefined);
  }
}

function normalizePatch(rawPatch: string): string {
  let patch = rawPatch.replace(/\r\n/g, "\n").trim();
  patch = patch.replace(/^```(?:diff|patch)?\n/i, "").replace(/\n```$/, "");
  if (!patch) return "";
  return patch.endsWith("\n") ? patch : `${patch}\n`;
}

async function applyFileEdits(cwd: string, fileEdits: Array<{ path: string; content: string }>, allowedPaths: Set<string>) {
  const workspace = path.resolve(cwd);
  const appliedPaths: string[] = [];
  const seen = new Set<string>();

  for (const edit of fileEdits) {
    const relPath = String(edit.path ?? "").trim();
    const content = typeof edit.content === "string" ? edit.content : "";
    if (!isSafeRelativePath(relPath)) continue;
    if (!allowedPaths.has(relPath)) continue;
    if (seen.has(relPath)) continue;
    seen.add(relPath);

    const absPath = path.resolve(cwd, relPath);
    if (!absPath.startsWith(`${workspace}${path.sep}`)) continue;

    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content, "utf8");
    appliedPaths.push(relPath);
  }

  if (appliedPaths.length === 0) {
    throw new Error("No safe file edits were applicable.");
  }

  return appliedPaths;
}

async function collectWorkspaceContext(cwd: string) {
  const [fileListResult, gitStatusResult] = await Promise.all([
    runShell(cwd, "rg --files || find . -type f"),
    runShell(cwd, "git status --short || true"),
  ]);

  const files = sanitizeFileList(fileListResult.stdout);
  return {
    files,
    gitStatus: gitStatusResult.stdout.trim() || "clean",
  };
}

async function makeExecutionPlan(params: {
  roomTitle: string;
  roomGoal: string;
  taskTitle: string;
  taskDescription: string;
  acceptanceCriteria: string;
  files: string[];
}) {
  const response = await openai.chat.completions.create({
    model: AGENTIC_MODEL,
    max_tokens: 1000,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are an autonomous coding agent.
Return JSON only:
{
  "plan": ["string"],
  "targetFiles": ["relative/path"]
}
Rules:
- Pick up to 6 existing files from the repository list.
- targetFiles must be exact paths from list.
- Plan should be concrete and execution-focused.`,
      },
      {
        role: "user",
        content: `Room: ${params.roomTitle}
Goal: ${params.roomGoal}
Task: ${params.taskTitle}
Description: ${params.taskDescription}
Acceptance Criteria:
${params.acceptanceCriteria}

Repository files:
${params.files.join("\n")}`,
      },
    ],
  });

  const parsed = JSON.parse(response.choices[0].message.content ?? "{}") as ExecutionPlan;
  return {
    plan: Array.isArray(parsed.plan) ? parsed.plan.slice(0, 8).map((s) => String(s)) : [],
    targetFiles: Array.isArray(parsed.targetFiles)
      ? parsed.targetFiles.map((s) => String(s)).filter(isSafeRelativePath).slice(0, 6)
      : [],
  };
}

async function makePatchPlan(params: {
  roomTitle: string;
  roomGoal: string;
  taskTitle: string;
  taskDescription: string;
  acceptanceCriteria: string;
  gitStatus: string;
  plan: string[];
  filePayload: Array<{ path: string; content: string }>;
  preferFileEdits?: boolean;
}) {
  const filesJoined = params.filePayload
    .map((f) => `FILE: ${f.path}\n${f.content}`)
    .join("\n\n---\n\n");

  const response = await openai.chat.completions.create({
    model: AGENTIC_MODEL,
    max_tokens: 4200,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are an autonomous coding agent.
Return JSON only:
{
  "patch": "git unified diff text",
  "fileEdits": [{ "path": "relative/path", "content": "full updated file content" }],
  "verificationCommands": ["string"],
  "progressSummary": "string"
}
Rules:
- Use one of two output modes:
  1) preferred: valid git unified diff in "patch"
  2) fallback: set "patch" to empty and provide "fileEdits" with full updated file content
- patch must be plain unified diff, no markdown fences.
- edit only provided files.
- fileEdits paths must be exact paths from provided files.
- include a patch only when a concrete code change is possible.
- verificationCommands should be safe local checks (max 3).`,
      },
      {
        role: "user",
        content: `Room: ${params.roomTitle}
Goal: ${params.roomGoal}
Task: ${params.taskTitle}
Description: ${params.taskDescription}
Acceptance Criteria:
${params.acceptanceCriteria}

Current git status:
${params.gitStatus}

Execution plan:
${params.plan.join("\n")}

Execution mode:
${params.preferFileEdits ? "Use fileEdits mode only. Set patch to an empty string." : "Prefer patch mode if reliable."}

Files:
${filesJoined}`,
      },
    ],
  });

  const parsed = JSON.parse(response.choices[0].message.content ?? "{}") as PatchPlan;
  return {
    patch: typeof parsed.patch === "string" ? normalizePatch(parsed.patch) : "",
    fileEdits: Array.isArray(parsed.fileEdits)
      ? parsed.fileEdits
        .map((entry) => ({
          path: typeof entry?.path === "string" ? entry.path : "",
          content: typeof entry?.content === "string" ? entry.content : "",
        }))
        .filter((entry) => isSafeRelativePath(entry.path))
        .slice(0, 6)
      : [],
    verificationCommands: Array.isArray(parsed.verificationCommands)
      ? parsed.verificationCommands.map((c) => String(c)).slice(0, 3)
      : [],
    progressSummary: typeof parsed.progressSummary === "string" ? parsed.progressSummary : "Automated code update attempted.",
  };
}

async function readTargetFiles(cwd: string, targetFiles: string[]) {
  const payload: Array<{ path: string; content: string }> = [];
  for (const relPath of targetFiles) {
    if (!isSafeRelativePath(relPath)) continue;
    const abs = path.join(cwd, relPath);
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) continue;
      const content = await fs.readFile(abs, "utf8");
      payload.push({
        path: relPath,
        content: content.length > 20000 ? content.slice(0, 20000) : content,
      });
    } catch {
      // Ignore unreadable target files
    }
  }
  return payload;
}

async function emitTaskStatus(roomId: string, taskId: string, taskTitle: string, status: "in_progress" | "review" | "blocked", blockedReason?: string) {
  await emitEvent({
    roomId,
    visibility: "global",
    type: "task.status.updated",
    payload: { taskId, taskTitle, status, blockedReason: blockedReason ?? null },
  });
}

export async function runWorkerAgenticExecution(params: {
  roomId: string;
  userId: string;
  taskIds: string[];
  workerMessage: (content: string) => Promise<void>;
}) {
  const { roomId, userId, taskIds, workerMessage } = params;
  if (!process.env.OPENAI_API_KEY) return;

  const room = await prisma.room.findUnique({ where: { id: roomId } });
  if (!room) return;

  const tasks = await prisma.task.findMany({
    where: {
      roomId,
      assignedUserId: userId,
      id: { in: taskIds },
    },
    include: {
      toDependencies: { include: { fromTask: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  if (tasks.length === 0) return;
  const cwd = workspaceRoot();

  for (const task of tasks) {
    const lockKey = `${roomId}:${task.id}`;
    if (executionLocks.has(lockKey)) continue;
    executionLocks.add(lockKey);

    try {
      const blockedByDependency = task.toDependencies.some((dep) => dep.fromTask.status !== "done");
      if (blockedByDependency) {
        await workerMessage(`Skipping "${task.title}" for now: waiting on dependency completion.`);
        continue;
      }

      if (task.status === "todo" || task.status === "blocked") {
        await prisma.task.update({
          where: { id: task.id },
          data: { status: "in_progress", blockedReason: null },
        });
        await emitTaskStatus(roomId, task.id, task.title, "in_progress");
      }

      const context = await collectWorkspaceContext(cwd);
      const executionPlan = await makeExecutionPlan({
        roomTitle: room.title,
        roomGoal: room.goal,
        taskTitle: task.title,
        taskDescription: task.description,
        acceptanceCriteria: task.acceptanceCriteria,
        files: context.files,
      });

      const targetFiles = executionPlan.targetFiles.length > 0
        ? executionPlan.targetFiles
        : context.files.slice(0, 3);
      const filePayload = await readTargetFiles(cwd, targetFiles);

      if (filePayload.length === 0) {
        await workerMessage(`I couldn't find readable target files for "${task.title}". Please point me to relevant files in this repository.`);
        continue;
      }

      const patchPlan = await makePatchPlan({
        roomTitle: room.title,
        roomGoal: room.goal,
        taskTitle: task.title,
        taskDescription: task.description,
        acceptanceCriteria: task.acceptanceCriteria,
        gitStatus: context.gitStatus,
        plan: executionPlan.plan,
        filePayload,
      });

      if (!patchPlan.patch.trim() && patchPlan.fileEdits.length === 0) {
        await workerMessage(`I reviewed "${task.title}" but couldn't produce a safe code patch yet. Suggested plan:\n${executionPlan.plan.map((s, i) => `${i + 1}. ${s}`).join("\n") || "No plan produced."}`);
        continue;
      }

      const allowedPaths = new Set(filePayload.map((f) => f.path));
      let applyMode: "patch" | "file_edits" | null = null;
      let appliedFiles: string[] = [];
      let firstApplyError: unknown = null;

      try {
        if (patchPlan.patch.trim()) {
          await ensurePatchApplies(cwd, patchPlan.patch);
          applyMode = "patch";
        }
      } catch (error) {
        firstApplyError = error;
      }

      if (!applyMode && patchPlan.fileEdits.length > 0) {
        try {
          appliedFiles = await applyFileEdits(cwd, patchPlan.fileEdits, allowedPaths);
          applyMode = "file_edits";
        } catch (error) {
          if (!firstApplyError) firstApplyError = error;
        }
      }

      if (!applyMode && patchPlan.fileEdits.length === 0 && firstApplyError) {
        try {
          const retryEditPlan = await makePatchPlan({
            roomTitle: room.title,
            roomGoal: room.goal,
            taskTitle: task.title,
            taskDescription: task.description,
            acceptanceCriteria: task.acceptanceCriteria,
            gitStatus: context.gitStatus,
            plan: executionPlan.plan,
            filePayload,
            preferFileEdits: true,
          });

          if (retryEditPlan.fileEdits.length > 0) {
            appliedFiles = await applyFileEdits(cwd, retryEditPlan.fileEdits, allowedPaths);
            applyMode = "file_edits";
          }
        } catch (error) {
          if (!firstApplyError) firstApplyError = error;
        }
      }

      if (!applyMode) {
        await prisma.task.update({
          where: { id: task.id },
          data: { status: "blocked", blockedReason: `Agentic patch failed: ${String(firstApplyError).slice(0, 500)}` },
        });
        await emitTaskStatus(roomId, task.id, task.title, "blocked", `Agentic patch failed. See worker chat for details.`);
        await workerMessage(`Patch application failed for "${task.title}". Error:\n${String(firstApplyError)}`);
        continue;
      }

      const verificationLogs: string[] = [];
      let verificationFailed = false;
      for (const cmd of patchPlan.verificationCommands) {
        if (!(await canRunVerificationCommand(cwd, cmd))) {
          verificationLogs.push(`$ ${cmd}\nSKIPPED: command is unsafe or script is not defined in package.json.`);
          continue;
        }
        try {
          const result = await runShell(cwd, cmd, 180000);
          verificationLogs.push(`$ ${cmd}\n${(result.stdout || result.stderr).slice(0, 2000) || "(no output)"}`);
        } catch (error) {
          verificationLogs.push(`$ ${cmd}\nFAILED: ${String(error).slice(0, 1200)}`);
          await prisma.task.update({
            where: { id: task.id },
            data: { status: "blocked", blockedReason: `Verification failed for command: ${cmd}` },
          });
          await emitTaskStatus(roomId, task.id, task.title, "blocked", `Verification failed (${cmd}).`);
          await workerMessage(`Code was edited for "${task.title}", but verification failed.\n${verificationLogs.join("\n\n")}`);
          verificationFailed = true;
          break;
        }
      }

      if (verificationFailed) {
        continue;
      }

      await prisma.task.update({
        where: { id: task.id },
        data: { status: "review", blockedReason: null },
      });
      await emitTaskStatus(roomId, task.id, task.title, "review");

      await prisma.notebookEntry.create({
        data: {
          roomId,
          category: "task_update",
          title: `Agentic code update: ${task.title}`,
          content: `Worker agent edited code for **${task.title}**.\n\nSummary: ${patchPlan.progressSummary}\n\nVerification:\n${verificationLogs.length > 0 ? verificationLogs.map((l) => `\`\`\`\n${l}\n\`\`\``).join("\n") : "_No verification commands run_"}`,
          references: { taskIds: [task.id] },
        },
      });

      await workerMessage([
        `I completed an autonomous coding pass for "${task.title}".`,
        `Status moved to **review**.`,
        applyMode === "file_edits" && appliedFiles.length > 0
          ? `Applied direct file edits to: ${appliedFiles.join(", ")}.`
          : "Applied patch successfully.",
        patchPlan.progressSummary,
        verificationLogs.length > 0 ? `Verification:\n${verificationLogs.join("\n\n")}` : "No verification command was executed.",
      ].join("\n\n"));

      await emitEvent({
        roomId,
        visibility: "global",
        type: "worker.progress.updated",
        payload: {
          taskId: task.id,
          taskTitle: task.title,
          userId,
          status: "review",
          summary: patchPlan.progressSummary,
        },
      });
    } catch (err) {
      await prisma.task.update({
        where: { id: task.id },
        data: { status: "blocked", blockedReason: `Agentic execution error: ${String(err).slice(0, 500)}` },
      }).catch(() => undefined);
      await emitTaskStatus(roomId, task.id, task.title, "blocked", "Agentic execution error.");
      await workerMessage(`Agentic execution failed for "${task.title}": ${String(err)}`);
    } finally {
      executionLocks.delete(lockKey);
    }
  }
}
