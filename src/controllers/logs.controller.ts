import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest } from "../utils/appError";
import { getLogFiles, readLogFile } from "../utils/odooLogger";
import { prisma } from "../lib/prisma";

/**
 * ดึงรายชื่อไฟล์ log ทั้งหมด
 * GET /api/logs/odoo
 */
export const getOdooLogFiles = asyncHandler(
  async (req: Request, res: Response) => {
    const files = getLogFiles();
    
    return res.json({
      total: files.length,
      files: files.map((file) => ({
        name: file,
        path: `/api/logs/odoo/${file}`,
      })),
    });
  }
);

/**
 * อ่านเนื้อหาไฟล์ log
 * GET /api/logs/odoo/:filename
 */
export const getOdooLogContent = asyncHandler(
  async (req: Request<{ filename: string }>, res: Response) => {
    const { filename } = req.params;
    
    if (!filename || !filename.endsWith(".log")) {
      throw badRequest("ชื่อไฟล์ไม่ถูกต้อง ต้องลงท้ายด้วย .log");
    }
    
    const content = readLogFile(filename);
    
    if (!content) {
      throw badRequest(`ไม่พบไฟล์ log: ${filename}`);
    }
    
    // ส่งกลับเป็น plain text
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.send(content);
  }
);

/**
 * ดึง Odoo request logs จาก database
 * GET /api/logs/odoo/database
 */
export const getOdooRequestLogs = asyncHandler(
  async (req: Request, res: Response) => {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      prisma.odoo_request_log.findMany({
        orderBy: { created_at: "desc" },
        skip,
        take: limit,
      }),
      prisma.odoo_request_log.count(),
    ]);

    return res.json({
      data: logs,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  }
);

/**
 * ดึง Odoo request log ตาม ID
 * GET /api/logs/odoo/database/:id
 */
export const getOdooRequestLogById = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);

    if (isNaN(id)) {
      throw badRequest("ID ต้องเป็นตัวเลข");
    }

    const log = await prisma.odoo_request_log.findUnique({
      where: { id },
    });

    if (!log) {
      throw badRequest(`ไม่พบ log ID: ${id}`);
    }

    return res.json(log);
  }
);
