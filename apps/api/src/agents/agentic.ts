import OpenAI from "openai";
import { execFile } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { prisma } from "../db";
import { emitEvent } from "../websocket";
import { commitAndMaybePushRoomRepo, ensureRoomRepoWorkspace } from "../services/roomRepo";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const AGENTIC_MODEL = process.env.OPENAI_MODEL?.trim() || "gpt-5.3-codex";
const executionLocks = new Set<string>();
const TARGET_FILE_LIMIT = 6;
const TARGET_FILE_CREATION_LIMIT = 2;
const FILE_CONTENT_PREVIEW_LIMIT = 20000;

const EDITABLE_FILE_EXTENSIONS = new Set([
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

const BLOCKED_BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".mp4",
  ".mp3",
  ".mov",
  ".wav",
  ".ttf",
  ".woff",
  ".woff2",
]);

const ALLOWED_EXTENSIONLESS_FILES = new Set([
  "dockerfile",
  "makefile",
  ".gitignore",
  ".npmrc",
  ".env.example",
]);

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

  return filesRaw
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => !blockedDirs.some((dir) => f.startsWith(dir)))
    .filter((f) => isEditableTargetPath(f))
    .slice(0, 1000);
}

function isSafeRelativePath(p: string): boolean {
  if (!p || path.isAbsolute(p)) return false;
  if (p.includes("..")) return false;
  return true;
}

function normalizeRelPath(p: string) {
  return p.replace(/\\/g, "/");
}

function isEditableTargetPath(relPath: string): boolean {
  if (!isSafeRelativePath(relPath)) return false;
  const normalized = normalizeRelPath(relPath);
  const ext = path.extname(normalized).toLowerCase();
  if (ext && BLOCKED_BINARY_EXTENSIONS.has(ext)) return false;
  if (ext) return EDITABLE_FILE_EXTENSIONS.has(ext);
  return ALLOWED_EXTENSIONLESS_FILES.has(path.basename(normalized).toLowerCase());
}

function canCreatePathInWorkspace(relPath: string, existingFiles: string[]) {
  const normalized = normalizeRelPath(relPath);
  const dir = path.posix.dirname(normalized);
  if (dir === "." || dir === "") return true;
  return existingFiles.some((file) => file.startsWith(`${dir}/`));
}

function tokenizeForFileMatch(value: string) {
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "into",
    "that",
    "this",
    "user",
    "task",
    "feature",
    "implement",
    "setup",
    "build",
  ]);
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !stopWords.has(token))
    .slice(0, 30);
}

function selectTargetFiles(params: {
  requestedTargets: string[];
  workspaceFiles: string[];
  taskTitle: string;
  taskDescription: string;
  acceptanceCriteria: string;
}) {
  const { requestedTargets, workspaceFiles, taskTitle, taskDescription, acceptanceCriteria } = params;
  const workspaceSet = new Set(workspaceFiles);
  const selected: string[] = [];
  const seen = new Set<string>();

  const push = (file: string) => {
    const normalized = normalizeRelPath(file);
    if (seen.has(normalized)) return;
    if (!isEditableTargetPath(normalized)) return;
    seen.add(normalized);
    selected.push(normalized);
  };

  for (const file of requestedTargets.map((f) => normalizeRelPath(String(f).trim()))) {
    if (!file) continue;
    if (workspaceSet.has(file)) {
      push(file);
    }
  }

  let created = 0;
  for (const file of requestedTargets.map((f) => normalizeRelPath(String(f).trim()))) {
    if (!file || workspaceSet.has(file)) continue;
    if (!canCreatePathInWorkspace(file, workspaceFiles)) continue;
    if (created >= TARGET_FILE_CREATION_LIMIT) break;
    push(file);
    created += 1;
  }

  if (selected.length >= TARGET_FILE_LIMIT) {
    return selected.slice(0, TARGET_FILE_LIMIT);
  }

  const tokens = tokenizeForFileMatch(`${taskTitle} ${taskDescription} ${acceptanceCriteria}`);
  const ranked = workspaceFiles
    .filter((file) => isEditableTargetPath(file))
    .map((file) => {
      const lower = file.toLowerCase();
      const base = path.basename(lower);
      const score = tokens.reduce((sum, token) => {
        if (base.includes(token)) return sum + 5;
        if (lower.includes(token)) return sum + 2;
        return sum;
      }, lower.includes("src/") || lower.includes("app/") ? 1 : 0);
      return { file, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.file);

  for (const file of ranked) {
    if (selected.length >= TARGET_FILE_LIMIT) break;
    push(file);
  }

  if (selected.length === 0) {
    for (const file of workspaceFiles) {
      if (selected.length >= TARGET_FILE_LIMIT) break;
      push(file);
    }
  }

  return selected.slice(0, TARGET_FILE_LIMIT);
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
  if (/\bNODE_ENV\s*=/i.test(cmd)) return false;
  const scriptName = extractRunScriptName(cmd);
  if (!scriptName) return true;

  try {
    const pkgRaw = await fs.readFile(path.join(cwd, "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, unknown> };
    return !!pkg.scripts && Object.prototype.hasOwnProperty.call(pkg.scripts, scriptName);
  } catch {
    return false;
  }
}

async function getPackageScripts(cwd: string): Promise<Record<string, string>> {
  try {
    const pkgRaw = await fs.readFile(path.join(cwd, "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

async function getFallbackVerificationCommands(cwd: string): Promise<string[]> {
  const scripts = await getPackageScripts(cwd);
  const priorities = ["typecheck", "lint", "test", "build", "check"];
  const selected: string[] = [];

  for (const name of priorities) {
    if (!Object.prototype.hasOwnProperty.call(scripts, name)) continue;
    selected.push(`npm run ${name}`);
    if (selected.length >= 2) break;
  }

  return selected;
}

async function snapshotTargetFiles(cwd: string, targetFiles: string[]) {
  const snapshot = new Map<string, string | null>();
  for (const relPath of targetFiles) {
    if (!isSafeRelativePath(relPath)) continue;
    const abs = path.join(cwd, relPath);
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) {
        snapshot.set(relPath, null);
        continue;
      }
      snapshot.set(relPath, await fs.readFile(abs, "utf8"));
    } catch {
      snapshot.set(relPath, null);
    }
  }
  return snapshot;
}

function changedFilesFromSnapshots(before: Map<string, string | null>, after: Map<string, string | null>) {
  const keys = new Set<string>([...before.keys(), ...after.keys()]);
  const changed: string[] = [];
  for (const key of keys) {
    if ((before.get(key) ?? null) !== (after.get(key) ?? null)) {
      changed.push(key);
    }
  }
  return changed;
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
    const relPath = normalizeRelPath(String(edit.path ?? "").trim());
    const content = typeof edit.content === "string" ? edit.content : "";
    if (!isSafeRelativePath(relPath)) continue;
    if (!isEditableTargetPath(relPath)) continue;
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
- Pick up to 8 files.
- targetFiles may include existing files and up to 4 new files when needed.
- All targetFiles must be safe relative paths (no ../, no absolute paths).
- Target files must be source/config/docs text files only (no images, mockups, design assets, or other binary files).
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
      ? parsed.targetFiles
        .map((s) => normalizeRelPath(String(s).trim()))
        .filter((s) => isEditableTargetPath(s))
        .slice(0, TARGET_FILE_LIMIT)
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
  allowedTargets: string[];
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
- edit only allowed target files.
- fileEdits paths must be exact paths from allowed target files.
- include a patch only when a concrete code change is possible.
- Do not edit design/image/binary files.
- verificationCommands should be package-script checks only (npm/pnpm/yarn run <script>) and max 3.`,
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

Allowed target files:
${params.allowedTargets.join("\n") || "(none provided)"}

Files:
${filesJoined}`,
      },
    ],
  });

  const parsed = JSON.parse(response.choices[0].message.content ?? "{}") as PatchPlan;
  return {
    patch: params.preferFileEdits ? "" : (typeof parsed.patch === "string" ? normalizePatch(parsed.patch) : ""),
    fileEdits: Array.isArray(parsed.fileEdits)
      ? parsed.fileEdits
        .map((entry) => ({
          path: typeof entry?.path === "string" ? normalizeRelPath(entry.path.trim()) : "",
          content: typeof entry?.content === "string" ? entry.content : "",
        }))
        .filter((entry) => isEditableTargetPath(entry.path))
        .slice(0, TARGET_FILE_LIMIT)
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
    if (!isEditableTargetPath(relPath)) continue;
    const abs = path.join(cwd, relPath);
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) continue;
      const content = await fs.readFile(abs, "utf8");
      payload.push({
        path: relPath,
        content: content.length > FILE_CONTENT_PREVIEW_LIMIT ? content.slice(0, FILE_CONTENT_PREVIEW_LIMIT) : content,
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
  const workspaceSetup = await ensureRoomRepoWorkspace({
    id: room.id,
    title: room.title,
    workspacePath: room.workspacePath,
    repoRemoteUrl: room.repoRemoteUrl,
    repoDefaultBranch: room.repoDefaultBranch,
  });

  if (!workspaceSetup.repoReady) {
    await workerMessage(`Repository workspace is not ready for this room. ${workspaceSetup.repoLastError ?? "Please fix repo setup and retry."}`);
    return;
  }
  const cwd = workspaceSetup.workspacePath;

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

      const targetFiles = selectTargetFiles({
        requestedTargets: executionPlan.targetFiles,
        workspaceFiles: context.files,
        taskTitle: task.title,
        taskDescription: task.description,
        acceptanceCriteria: task.acceptanceCriteria,
      });
      if (targetFiles.length === 0) {
        await prisma.task.update({
          where: { id: task.id },
          data: { status: "blocked", blockedReason: "Agentic execution could not find safe target files for this task." },
        });
        await emitTaskStatus(roomId, task.id, task.title, "blocked", "No safe target files identified.");
        await workerMessage(`I could not map "${task.title}" to safe code files in this repo yet. Please add more concrete file-level guidance and retry.`);
        continue;
      }
      const filePayload = await readTargetFiles(cwd, targetFiles);
      const beforeSnapshot = await snapshotTargetFiles(cwd, targetFiles);

      const patchPlan = await makePatchPlan({
        roomTitle: room.title,
        roomGoal: room.goal,
        taskTitle: task.title,
        taskDescription: task.description,
        acceptanceCriteria: task.acceptanceCriteria,
        gitStatus: context.gitStatus,
        plan: executionPlan.plan,
        allowedTargets: targetFiles,
        filePayload,
        preferFileEdits: true,
      });

      if (!patchPlan.patch.trim() && patchPlan.fileEdits.length === 0) {
        await workerMessage(`I reviewed "${task.title}" but couldn't produce a safe code patch yet. Suggested plan:\n${executionPlan.plan.map((s, i) => `${i + 1}. ${s}`).join("\n") || "No plan produced."}`);
        continue;
      }

      const allowedPaths = new Set(targetFiles);
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
            allowedTargets: targetFiles,
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

      const afterSnapshot = await snapshotTargetFiles(cwd, targetFiles);
      const changedTargetFiles = changedFilesFromSnapshots(beforeSnapshot, afterSnapshot);
      if (changedTargetFiles.length === 0) {
        await prisma.task.update({
          where: { id: task.id },
          data: { status: "blocked", blockedReason: "Agentic execution produced no effective code changes." },
        });
        await emitTaskStatus(roomId, task.id, task.title, "blocked", "No effective code changes were produced.");
        await workerMessage(
          `I attempted "${task.title}" but no effective file delta was produced in safe target files (${targetFiles.join(", ")}). Re-run with more specific implementation instructions.`,
        );
        continue;
      }

      const verificationLogs: string[] = [];
      let verificationFailed = false;
      const verificationCommands = patchPlan.verificationCommands.length > 0
        ? patchPlan.verificationCommands
        : await getFallbackVerificationCommands(cwd);

      if (verificationCommands.length === 0) {
        verificationLogs.push("No runnable verification script found in package.json. Verification skipped.");
      }

      for (const cmd of verificationCommands) {
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

      const gitResult = await commitAndMaybePushRoomRepo({
        roomId,
        workspacePath: cwd,
        taskTitle: task.title,
      });

      if (!gitResult.committed) {
        await prisma.task.update({
          where: { id: task.id },
          data: { status: "blocked", blockedReason: "Agentic execution did not produce a commitable code delta." },
        });
        await emitTaskStatus(roomId, task.id, task.title, "blocked", "No commitable code changes were produced.");
        await workerMessage([
          `I attempted "${task.title}" but there was still no commitable code delta.`,
          `Changed safe target files: ${changedTargetFiles.join(", ") || "none"}.`,
          "Task stays blocked until a concrete code change is produced.",
        ].join("\n"));
        continue;
      }

      await prisma.task.update({
        where: { id: task.id },
        data: { status: "review", blockedReason: null },
      });
      await emitTaskStatus(roomId, task.id, task.title, "review");

      if (gitResult.pushError) {
        await emitEvent({
          roomId,
          visibility: "global",
          type: "master.integration.alert",
          payload: {
            severity: "medium",
            message: `Repo push failed after task "${task.title}". Manual push may be required.`,
            relatedTaskIds: [task.id],
            relatedContractIds: [],
          },
        });
      }

      await prisma.notebookEntry.create({
        data: {
          roomId,
          category: "task_update",
          title: `Agentic code update: ${task.title}`,
          content: `Worker agent edited code for **${task.title}**.\n\nSummary: ${patchPlan.progressSummary}\n\nChanged files: ${changedTargetFiles.join(", ")}\n\nVerification:\n${verificationLogs.length > 0 ? verificationLogs.map((l) => `\`\`\`\n${l}\n\`\`\``).join("\n") : "_No verification commands run_"}`,
          references: { taskIds: [task.id] },
        },
      });

      await workerMessage([
        `I completed an autonomous coding pass for "${task.title}".`,
        `Status moved to **review**.`,
        applyMode === "file_edits" && appliedFiles.length > 0
          ? `Applied direct file edits to: ${appliedFiles.join(", ")}.`
          : "Applied patch successfully.",
        `Changed files: ${changedTargetFiles.join(", ")}.`,
        patchPlan.progressSummary,
        `Created commit${gitResult.commitSha ? ` ${gitResult.commitSha}` : ""}.${gitResult.pushed ? " Pushed to remote." : " Not pushed to remote."}`,
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
