import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { prisma } from "../lib/prisma";
import { badRequest } from "../utils/appError"; // ใช้ของเดิมคุณ
import { wmsDailySnapshotService } from "../services/stockdaily.snapshot.service";

/**
 * POST /api/wms-stock-daily/snapshot?date=2026-02-01
 */
export const createWmsDailySnapshot = asyncHandler(async (req: Request, res: Response) => {
  const date = typeof req.query.date === "string" ? req.query.date : undefined;
  const triggeredBy = (req as any).user?.id || "manual";

  const result = await wmsDailySnapshotService.createDailySnapshot(String(triggeredBy), date);

  return res.status(201).json({
    success: result.success,
    message: "สร้าง WMS Stock Daily Snapshot สำเร็จ",
    snapshot_date: result.snapshot_date,
    total_snapshot: result.total_snapshot,
    errors: result.errors.length ? result.errors : undefined,
  });
});

/**
 * GET /api/wms-stock-daily?date=2026-02-01
 * GET /api/wms-stock-daily?start=2026-02-01&end=2026-02-07&product_code=XXX
 */
export const getWmsDaily = asyncHandler(async (req: Request, res: Response) => {
  const date = typeof req.query.date === "string" ? req.query.date : undefined;
  const start = typeof req.query.start === "string" ? req.query.start : undefined;
  const end = typeof req.query.end === "string" ? req.query.end : undefined;
  const product_code = typeof req.query.product_code === "string" ? req.query.product_code : undefined;

  if (!date && !(start && end)) {
    throw badRequest("ต้องระบุ date หรือ start+end");
  }

  const where: any = {};
  if (product_code) where.product_code = product_code;

  if (date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    where.snapshot_date = d;
  } else {
    const s = new Date(start!); s.setHours(0, 0, 0, 0);
    const e = new Date(end!); e.setHours(0, 0, 0, 0);
    where.snapshot_date = { gte: s, lte: e };
  }

  const rows = await prisma.wms_stock_daily.findMany({
    where,
    orderBy: [{ snapshot_date: "asc" }, { product_code: "asc" }, { lot_name: "asc" }],
  });

  return res.json({
    total: rows.length,
    data: rows,
  });
});



