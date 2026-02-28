import { execFile } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { prisma } from "../db";

type RoomRepoInput = {
  id: string;
  title: string;
  workspacePath?: string | null;
  repoRemoteUrl?: string | null;
  repoDefaultBranch?: string | null;
};

type GitHubRepoResult = {
  cloneUrl: string;
  htmlUrl: string;
  defaultBranch: string;
};

export type RoomRepoStatus = {
  workspacePath: string;
  repoReady: boolean;
  repoRemoteUrl: string | null;
  repoDefaultBranch: string;
  repoLastError: string | null;
  branch: string | null;
  changedFiles: number;
  mergeConflictFiles: string[];
  trackedEnvFiles: string[];
  potentialSecrets: string[];
  aheadBy: number;
  behindBy: number;
};

const roomLocks = new Map<string, Promise<void>>();

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "room";
}

function resolveBaseWorkspaceDir() {
  const raw = process.env.ROOM_WORKSPACES_DIR?.trim();
  if (!raw) {
    return path.resolve(process.cwd(), "room-workspaces");
  }
  return path.resolve(raw);
}

function resolveWorkspacePath(room: RoomRepoInput): string {
  if (room.workspacePath) return room.workspacePath;
  const slug = slugify(room.title);
  return path.join(resolveBaseWorkspaceDir(), `${room.id}-${slug}`);
}

function runCmd(cwd: string, cmd: string, args: string[], timeoutMs = 120000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 10 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${cmd} ${args.join(" ")}\n${stderr || stdout || error.message}`));
          return;
        }
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

async function pathExists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureGitInitialized(workspacePath: string, branch: string) {
  await fs.mkdir(workspacePath, { recursive: true });
  const gitDir = path.join(workspacePath, ".git");
  if (!(await pathExists(gitDir))) {
    try {
      await runCmd(workspacePath, "git", ["init", "-b", branch], 60000);
    } catch {
      await runCmd(workspacePath, "git", ["init"], 60000);
      await runCmd(workspacePath, "git", ["checkout", "-B", branch], 60000).catch(() => undefined);
    }
  }

  await runCmd(workspacePath, "git", ["config", "user.name", "DevRoom Agent"], 60000).catch(() => undefined);
  await runCmd(workspacePath, "git", ["config", "user.email", "devroom-agent@local"], 60000).catch(() => undefined);
}

async function ensureInitialReadme(workspacePath: string, title: string, roomId: string) {
  const readmePath = path.join(workspacePath, "README.md");
  if (await pathExists(readmePath)) return;

  const content = `# ${title}

Room ID: ${roomId}

This workspace is managed by DevRoom agentic execution.
`;
  await fs.writeFile(readmePath, content, "utf8");
}

async function ensureRemote(workspacePath: string, repoRemoteUrl: string) {
  const current = await runCmd(workspacePath, "git", ["remote", "get-url", "origin"], 60000)
    .then((r) => r.stdout.trim())
    .catch(() => "");

  if (!current) {
    await runCmd(workspacePath, "git", ["remote", "add", "origin", repoRemoteUrl], 60000);
    return;
  }
  if (current !== repoRemoteUrl) {
    await runCmd(workspacePath, "git", ["remote", "set-url", "origin", repoRemoteUrl], 60000);
  }
}

async function commitIfNeeded(workspacePath: string) {
  const status = await runCmd(workspacePath, "git", ["status", "--porcelain"], 60000)
    .then((r) => r.stdout.trim())
    .catch(() => "");
  if (!status) return;

  await runCmd(workspacePath, "git", ["add", "-A"], 60000);
  await runCmd(workspacePath, "git", ["commit", "-m", "Initialize room workspace"], 60000).catch(() => undefined);
}

function sanitizeRepoName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "devroom-room";
}

export async function maybeCreateGitHubRepo(params: {
  roomId: string;
  roomTitle: string;
  requestedName?: string;
  visibility?: "private" | "public";
}): Promise<GitHubRepoResult | null> {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) return null;

  const roomSlug = slugify(params.roomTitle);
  const defaultRepoName = sanitizeRepoName(`devroom-${roomSlug}-${params.roomId.slice(0, 8)}`);
  const repoName = sanitizeRepoName(params.requestedName?.trim() || defaultRepoName);
  const visibility = params.visibility ?? (process.env.GITHUB_DEFAULT_VISIBILITY === "public" ? "public" : "private");
  const requestedOwner = process.env.GITHUB_OWNER?.trim();

  const userResp = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "devroom-agent",
    },
  });
  if (!userResp.ok) {
    throw new Error(`GitHub auth failed (${userResp.status}). Set a valid GITHUB_TOKEN.`);
  }
  const userJson = await userResp.json() as { login?: string };
  const login = userJson.login;
  if (!login) {
    throw new Error("GitHub auth response missing account login.");
  }

  const owner = requestedOwner || login;
  const endpoint = owner === login
    ? "https://api.github.com/user/repos"
    : `https://api.github.com/orgs/${owner}/repos`;

  const createResp = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "devroom-agent",
    },
    body: JSON.stringify({
      name: repoName,
      private: visibility !== "public",
      auto_init: false,
      has_issues: true,
      has_wiki: false,
      description: `DevRoom workspace for "${params.roomTitle}"`,
    }),
  });

  if (!createResp.ok) {
    const errBody = await createResp.text();
    throw new Error(`GitHub repo create failed (${createResp.status}): ${errBody.slice(0, 400)}`);
  }

  const created = await createResp.json() as {
    clone_url?: string;
    html_url?: string;
    default_branch?: string;
  };

  if (!created.clone_url || !created.html_url) {
    throw new Error("GitHub repo created but clone_url/html_url missing.");
  }

  return {
    cloneUrl: created.clone_url,
    htmlUrl: created.html_url,
    defaultBranch: created.default_branch || "main",
  };
}

async function withRoomLock(roomId: string, fn: () => Promise<void>) {
  const running = roomLocks.get(roomId);
  if (running) {
    await running;
  }
  const next = fn()
    .finally(() => {
      if (roomLocks.get(roomId) === next) {
        roomLocks.delete(roomId);
      }
    });
  roomLocks.set(roomId, next);
  await next;
}

export async function ensureRoomRepoWorkspace(room: RoomRepoInput) {
  let workspacePath = resolveWorkspacePath(room);
  const repoDefaultBranch = (room.repoDefaultBranch || "main").trim() || "main";
  let repoLastError: string | null = null;
  let repoReady = false;
  const repoRemoteUrl = room.repoRemoteUrl?.trim() || null;

  try {
    await withRoomLock(room.id, async () => {
      await fs.mkdir(path.dirname(workspacePath), { recursive: true });
      const workspaceExists = await pathExists(workspacePath);

      if (!workspaceExists && repoRemoteUrl) {
        try {
          await runCmd(path.dirname(workspacePath), "git", ["clone", "--depth", "1", repoRemoteUrl, workspacePath], 180000);
        } catch (err) {
          repoLastError = `Clone failed: ${String(err).slice(0, 500)}`;
        }
      }

      await ensureGitInitialized(workspacePath, repoDefaultBranch);
      await ensureInitialReadme(workspacePath, room.title, room.id);

      if (repoRemoteUrl) {
        try {
          await ensureRemote(workspacePath, repoRemoteUrl);
        } catch (err) {
          repoLastError = `Remote setup failed: ${String(err).slice(0, 500)}`;
        }
      }

      await commitIfNeeded(workspacePath).catch(() => undefined);

      repoReady = await runCmd(workspacePath, "git", ["rev-parse", "--is-inside-work-tree"], 60000)
        .then((r) => r.stdout.trim() === "true")
        .catch(() => false);
    });
  } catch (err) {
    repoReady = false;
    repoLastError = `Workspace bootstrap failed: ${String(err).slice(0, 500)}`;
  }

  await prisma.room.update({
    where: { id: room.id },
    data: {
      workspacePath,
      repoReady,
      repoLastError,
      repoRemoteUrl: repoRemoteUrl ?? undefined,
      repoDefaultBranch,
      repoLastSyncedAt: repoReady ? new Date() : undefined,
    },
  }).catch(() => undefined);

  return {
    workspacePath,
    repoReady,
    repoRemoteUrl,
    repoDefaultBranch,
    repoLastError,
  };
}

function parseGitStatusFiles(statusOutput: string) {
  const lines = statusOutput
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);

  const changedFiles = lines.map((line) => line.slice(3).trim()).filter(Boolean);
  const mergeConflictFiles = lines
    .filter((line) => line.startsWith("UU ") || line.startsWith("AA ") || line.startsWith("DD "))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);

  return { changedFiles, mergeConflictFiles };
}

export async function getRoomRepoStatus(roomId: string): Promise<RoomRepoStatus> {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: {
      id: true,
      title: true,
      workspacePath: true,
      repoRemoteUrl: true,
      repoDefaultBranch: true,
      repoReady: true,
      repoLastError: true,
    },
  });
  if (!room) {
    throw new Error("Room not found");
  }

  const setup = await ensureRoomRepoWorkspace(room);
  const workspacePath = setup.workspacePath;

  let branch: string | null = null;
  let changedFilesCount = 0;
  let mergeConflictFiles: string[] = [];
  let trackedEnvFiles: string[] = [];
  let potentialSecrets: string[] = [];
  let aheadBy = 0;
  let behindBy = 0;
  let repoLastError: string | null = setup.repoLastError;

  try {
    branch = await runCmd(workspacePath, "git", ["rev-parse", "--abbrev-ref", "HEAD"], 60000)
      .then((r) => r.stdout.trim())
      .catch(() => null);

    const statusOut = await runCmd(workspacePath, "git", ["status", "--porcelain"], 60000)
      .then((r) => r.stdout)
      .catch(() => "");
    const parsed = parseGitStatusFiles(statusOut);
    changedFilesCount = parsed.changedFiles.length;
    mergeConflictFiles = parsed.mergeConflictFiles;

    trackedEnvFiles = await runCmd(workspacePath, "git", ["ls-files"], 60000)
      .then((r) => r.stdout.split("\n").map((s) => s.trim()).filter(Boolean))
      .then((files) => files.filter((file) => file.startsWith(".env") && !file.endsWith(".example")))
      .catch(() => []);

    const secretScan = await runCmd(
      workspacePath,
      "bash",
      [
        "-lc",
        "rg -n --hidden --glob '!.git' --glob '!node_modules' --glob '!.next' --glob '!dist' \"(AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----)\" . || true",
      ],
      120000,
    ).then((r) => r.stdout);
    potentialSecrets = secretScan
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 10);

    const upstreamCounts = await runCmd(workspacePath, "bash", ["-lc", "git rev-list --left-right --count HEAD...@{u} 2>/dev/null || true"], 60000)
      .then((r) => r.stdout.trim());
    if (upstreamCounts) {
      const [behindRaw, aheadRaw] = upstreamCounts.split(/\s+/);
      behindBy = Number(behindRaw || 0) || 0;
      aheadBy = Number(aheadRaw || 0) || 0;
    }
  } catch (err) {
    repoLastError = `Repo status check failed: ${String(err).slice(0, 500)}`;
  }

  if (repoLastError !== setup.repoLastError) {
    await prisma.room.update({
      where: { id: roomId },
      data: {
        repoLastError,
        repoLastSyncedAt: new Date(),
      },
    }).catch(() => undefined);
  }

  return {
    workspacePath,
    repoReady: setup.repoReady,
    repoRemoteUrl: setup.repoRemoteUrl,
    repoDefaultBranch: setup.repoDefaultBranch,
    repoLastError,
    branch,
    changedFiles: changedFilesCount,
    mergeConflictFiles,
    trackedEnvFiles,
    potentialSecrets,
    aheadBy,
    behindBy,
  };
}

export async function syncRoomRepo(roomId: string) {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: {
      id: true,
      title: true,
      workspacePath: true,
      repoRemoteUrl: true,
      repoDefaultBranch: true,
    },
  });
  if (!room) {
    throw new Error("Room not found");
  }

  const setup = await ensureRoomRepoWorkspace(room);
  if (!setup.repoRemoteUrl) {
    const status = await getRoomRepoStatus(roomId);
    return { synced: false, reason: "No remote configured", status };
  }

  let syncError: string | null = null;
  try {
    await runCmd(setup.workspacePath, "git", ["fetch", "origin"], 120000);
    await runCmd(setup.workspacePath, "git", ["pull", "--ff-only", "origin", setup.repoDefaultBranch], 180000);
  } catch (err) {
    syncError = String(err).slice(0, 500);
  }

  await prisma.room.update({
    where: { id: roomId },
    data: {
      repoLastSyncedAt: new Date(),
      repoLastError: syncError,
    },
  }).catch(() => undefined);

  return {
    synced: !syncError,
    error: syncError,
    status: await getRoomRepoStatus(roomId),
  };
}

export async function commitAndMaybePushRoomRepo(params: {
  roomId: string;
  workspacePath: string;
  taskTitle: string;
}) {
  const { roomId, workspacePath, taskTitle } = params;

  const status = await runCmd(workspacePath, "git", ["status", "--porcelain"], 60000)
    .then((r) => r.stdout.trim())
    .catch(() => "");
  if (!status) {
    return { committed: false, pushed: false, commitSha: null as string | null, pushError: null as string | null };
  }

  await runCmd(workspacePath, "git", ["add", "-A"], 60000);
  await runCmd(workspacePath, "git", ["commit", "-m", `worker: ${taskTitle}`], 120000);

  const commitSha = await runCmd(workspacePath, "git", ["rev-parse", "--short", "HEAD"], 60000)
    .then((r) => r.stdout.trim())
    .catch(() => null);

  const branch = await runCmd(workspacePath, "git", ["rev-parse", "--abbrev-ref", "HEAD"], 60000)
    .then((r) => r.stdout.trim())
    .catch(() => "main");

  let pushed = false;
  let pushError: string | null = null;
  const remote = await runCmd(workspacePath, "git", ["remote", "get-url", "origin"], 60000)
    .then((r) => r.stdout.trim())
    .catch(() => "");

  if (remote) {
    try {
      await runCmd(workspacePath, "git", ["push", "origin", branch], 180000);
      pushed = true;
    } catch (err) {
      pushError = String(err).slice(0, 500);
    }
  }

  await prisma.room.update({
    where: { id: roomId },
    data: {
      repoLastSyncedAt: new Date(),
      repoLastError: pushError,
    },
  }).catch(() => undefined);

  return { committed: true, pushed, commitSha, pushError };
}
