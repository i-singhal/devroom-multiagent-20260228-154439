import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireAuth, requireRoomMember } from "../middleware/auth";

const router = Router();

// GET /rooms/:roomId/notebook?q=&category=
router.get("/:roomId/notebook", requireAuth, requireRoomMember, async (req, res) => {
  const { roomId } = req.params;
  const q = req.query.q as string | undefined;
  const category = req.query.category as string | undefined;

  const entries = await prisma.notebookEntry.findMany({
    where: {
      roomId,
      ...(category ? { category: category as any } : {}),
      ...(q ? {
        OR: [
          { title: { contains: q, mode: "insensitive" } },
          { content: { contains: q, mode: "insensitive" } },
        ],
      } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  res.json(entries);
});

// POST /rooms/:roomId/notebook (admin/master only in production; open for MVP)
router.post("/:roomId/notebook", requireAuth, requireRoomMember, async (req, res) => {
  const { roomId } = req.params;

  const data = z.object({
    category: z.enum(["decision", "contract_change", "task_update", "integration", "blocker", "summary"]),
    title: z.string().min(1),
    content: z.string().min(1),
    references: z.object({
      taskIds: z.array(z.string()).optional(),
      contractIds: z.array(z.string()).optional(),
      messageIds: z.array(z.string()).optional(),
      links: z.array(z.string()).optional(),
    }).optional(),
  }).parse(req.body);

  const entry = await prisma.notebookEntry.create({
    data: {
      roomId,
      category: data.category,
      title: data.title,
      content: data.content,
      references: data.references || {},
    },
  });

  res.status(201).json(entry);
});

export default router;
