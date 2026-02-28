import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireAuth } from "../middleware/auth";
import { emitEvent } from "../websocket";
import { masterHandleContractPublished } from "../agents/master";
import { emitSecurityAlert } from "../security";

const router = Router();

async function getContractWithAccess(contractId: string, userId: string) {
  const contract = await prisma.contract.findUnique({ where: { id: contractId } });
  if (!contract) return null;
  const membership = await prisma.membership.findUnique({
    where: { roomId_userId: { roomId: contract.roomId, userId } },
  });
  if (!membership) return null;
  return { contract, membership };
}

// GET /contracts/:id
router.get("/:id", requireAuth, async (req, res) => {
  const user = res.locals.user;
  const result = await getContractWithAccess(req.params.id, user.id);
  if (!result) { res.status(403).json({ error: "Not found or no access" }); return; }

  const versions = await prisma.contractVersion.findMany({
    where: { contractId: result.contract.id },
    orderBy: { version: "desc" },
  });

  res.json({ ...result.contract, versions });
});

// POST /contracts/:id/propose
router.post("/:id/propose", requireAuth, async (req, res) => {
  const user = res.locals.user;
  const result = await getContractWithAccess(req.params.id, user.id);
  if (!result) { res.status(403).json({ error: "Not found or no access" }); return; }

  const data = z.object({
    summary: z.string().min(1),
    breaking: z.boolean(),
    proposedContent: z.string().min(1),
  }).parse(req.body);

  const { contract } = result;

  await emitEvent({
    roomId: contract.roomId,
    visibility: "global",
    type: "contract.proposed_change",
    payload: {
      contractId: contract.id,
      contractName: contract.name,
      proposedByUserId: user.id,
      proposedByName: user.name,
      breaking: data.breaking,
      summary: data.summary,
      proposedContent: data.proposedContent,
    },
  });

  // Notebook entry for the proposal
  await prisma.notebookEntry.create({
    data: {
      roomId: contract.roomId,
      category: "contract_change",
      title: `Contract change proposed: ${contract.name}`,
      content: `**${user.name}** proposed a change to **${contract.name}**.\n\n**Summary:** ${data.summary}\n\n**Breaking:** ${data.breaking ? "Yes ⚠️" : "No"}`,
      references: { contractIds: [contract.id] },
    },
  });

  res.json({ ok: true });
});

// POST /contracts/:id/publish (admin/owner only)
router.post("/:id/publish", requireAuth, async (req, res) => {
  const user = res.locals.user;
  const result = await getContractWithAccess(req.params.id, user.id);
  if (!result) { res.status(403).json({ error: "Not found or no access" }); return; }

  const { contract, membership } = result;
  if (membership.role === "collaborator") {
    emitSecurityAlert({
      roomId: contract.roomId,
      userId: user.id,
      userName: user.name,
      action: "contract.publish",
      detail: `contractId=${contract.id}`,
      severity: "high",
    }).catch(console.error);
    res.status(403).json({ error: "Admin role required to publish contracts" });
    return;
  }

  const data = z.object({
    summary: z.string().min(1),
    breaking: z.boolean(),
    content: z.string().min(1),
  }).parse(req.body);

  // Detect breaking change heuristically if not marked
  let breaking = data.breaking;
  if (!breaking) {
    const currentVersion = contract.currentVersionId
      ? await prisma.contractVersion.findUnique({ where: { id: contract.currentVersionId } })
      : null;
    if (currentVersion) {
      breaking = detectBreakingChange(contract.type, currentVersion.content, data.content);
    }
  }

  // Get next version number
  const lastVersion = await prisma.contractVersion.findFirst({
    where: { contractId: contract.id },
    orderBy: { version: "desc" },
  });
  const nextVersion = (lastVersion?.version ?? 0) + 1;

  const version = await prisma.contractVersion.create({
    data: {
      contractId: contract.id,
      version: nextVersion,
      content: data.content,
      summary: data.summary,
      breaking,
      proposedBy: user.id,
    },
  });

  await prisma.contract.update({
    where: { id: contract.id },
    data: { currentVersionId: version.id },
  });

  await emitEvent({
    roomId: contract.roomId,
    visibility: "global",
    type: "contract.published",
    payload: {
      contractId: contract.id,
      contractName: contract.name,
      contractVersionId: version.id,
      breaking,
      summary: data.summary,
    },
  });

  // Trigger master impact analysis
  await masterHandleContractPublished(contract.roomId, contract.id, version.id, breaking, data.summary);

  res.json({ ...version, contract });
});

function detectBreakingChange(type: string, oldContent: string, newContent: string): boolean {
  if (type === "openapi") {
    // Simple heuristic: look for removed endpoint paths
    const oldPaths = (oldContent.match(/\/[a-zA-Z0-9/_{}]+/g) ?? []);
    const newPaths = new Set(newContent.match(/\/[a-zA-Z0-9/_{}]+/g) ?? []);
    return oldPaths.some((p) => !newPaths.has(p));
  }
  if (type === "typescript") {
    // Look for removed exports
    const oldExports = (oldContent.match(/export\s+(?:type\s+)?(?:interface\s+|class\s+|function\s+|const\s+)?(\w+)/g) ?? []);
    const newContent_ = newContent;
    return oldExports.some((e) => !newContent_.includes(e));
  }
  // For other types, basic string removal check
  const oldLines = new Set(oldContent.split("\n").map((l) => l.trim()).filter(Boolean));
  const newLines = new Set(newContent.split("\n").map((l) => l.trim()).filter(Boolean));
  let removedCount = 0;
  for (const line of oldLines) {
    if (!newLines.has(line)) removedCount++;
  }
  return removedCount > oldLines.size * 0.2; // >20% removal is likely breaking
}

export default router;
