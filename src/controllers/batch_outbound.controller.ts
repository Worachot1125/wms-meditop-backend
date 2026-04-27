import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../utils/asyncHandler";
import { generateBatchPickName } from "../utils/createBatchOutboundsName";
import { badRequest, notFound, conflict } from "../utils/appError";
import { AuthRequest } from "../middleware/auth";

function normalizeNumberArray(input: any, field: string): number[] {
  if (input === undefined || input === null || input === "") return [];
  const arr = Array.isArray(input) ? input : [input];

  const nums = arr
    .flatMap((x) => {
      if (typeof x === "string") {
        if (x.includes(",")) return x.split(",").map((s) => s.trim());
      }
      return [x];
    })
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n));

  const uniq = Array.from(new Set(nums));
  if (uniq.length === 0)
    throw badRequest(`ต้องระบุ ${field} อย่างน้อย 1 ค่า`, { field });
  return uniq;
}

function getUserId(req: Request): number {
  const fromReqUser = (req as any).user?.id;
  const fromBody = (req.body as any)?.user_id;

  const id = Number(fromReqUser ?? fromBody);
  if (!Number.isFinite(id))
    throw badRequest("ไม่พบ user_id (ต้อง login หรือส่ง user_id มา)", {
      field: "user_id",
    });
  return id;
}

function parseSearchDateRange(search: string): { gte: Date; lt: Date } | null {
  const raw = String(search ?? "").trim();
  if (!raw) return null;

  const normalized = raw.replace(/\s*,\s*/g, " ").replace(/\s+/g, " ").trim();

  // dd/MM/yyyy [HH:mm[:ss]]
  const dmyMatch = normalized.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  );

  if (dmyMatch) {
    const dd = Number(dmyMatch[1]);
    const mm = Number(dmyMatch[2]);
    const yyyy = Number(dmyMatch[3]);
    const hh = dmyMatch[4] != null ? Number(dmyMatch[4]) : null;
    const mi = dmyMatch[5] != null ? Number(dmyMatch[5]) : null;
    const ss = dmyMatch[6] != null ? Number(dmyMatch[6]) : 0;

    if (hh != null && mi != null) {
      const start = new Date(Date.UTC(yyyy, mm - 1, dd, hh, mi, ss, 0));
      const end = new Date(start.getTime() + 60 * 1000);
      return { gte: start, lt: end };
    }

    return {
      gte: new Date(Date.UTC(yyyy, mm - 1, dd, 0, 0, 0, 0)),
      lt: new Date(Date.UTC(yyyy, mm - 1, dd + 1, 0, 0, 0, 0)),
    };
  }

  // yyyy-MM-dd [HH:mm[:ss]]
  const ymdMatch = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  );

  if (ymdMatch) {
    const yyyy = Number(ymdMatch[1]);
    const mm = Number(ymdMatch[2]);
    const dd = Number(ymdMatch[3]);
    const hh = ymdMatch[4] != null ? Number(ymdMatch[4]) : null;
    const mi = ymdMatch[5] != null ? Number(ymdMatch[5]) : null;
    const ss = ymdMatch[6] != null ? Number(ymdMatch[6]) : 0;

    if (hh != null && mi != null) {
      const start = new Date(Date.UTC(yyyy, mm - 1, dd, hh, mi, ss, 0));
      const end = new Date(start.getTime() + 60 * 1000);
      return { gte: start, lt: end };
    }

    return {
      gte: new Date(Date.UTC(yyyy, mm - 1, dd, 0, 0, 0, 0)),
      lt: new Date(Date.UTC(yyyy, mm - 1, dd + 1, 0, 0, 0, 0)),
    };
  }

  const maybe = new Date(raw);
  if (!Number.isNaN(maybe.getTime())) {
    const yyyy = maybe.getUTCFullYear();
    const mm = maybe.getUTCMonth();
    const dd = maybe.getUTCDate();

    return {
      gte: new Date(Date.UTC(yyyy, mm, dd, 0, 0, 0, 0)),
      lt: new Date(Date.UTC(yyyy, mm, dd + 1, 0, 0, 0, 0)),
    };
  }

  return null;
}

function buildBatchGroupSearchWhere(
  search: string,
): Prisma.batch_outboundWhereInput {
  const trimmed = String(search ?? "").trim();
  if (!trimmed) return {};

  const dateRange = parseSearchDateRange(trimmed);

  const orConditions: Prisma.batch_outboundWhereInput[] = [
    {
      name: { contains: trimmed, mode: "insensitive" },
    },
  ];

  if (dateRange) {
    orConditions.push({
      created_at: {
        gte: dateRange.gte,
        lt: dateRange.lt,
      },
    });
  }

  return {
    OR: orConditions,
  };
}

/**
 * ✅ CREATE Batch Locks (เลือกหลาย outbound แล้ว lock)
 * POST /api/batch-outbounds
 * body: { outbound_ids: number[] }  (หรือ outbound_ids เป็น string "1,2,3" ก็ได้)
 */
export const createBatchOutbounds = asyncHandler(
  async (
    req: Request<{}, {}, { outbound_ids: any; user_id?: any }>,
    res: Response,
  ) => {
    const userId = getUserId(req);
    const outboundIds = normalizeNumberArray(
      (req.body as any).outbound_ids ?? (req.body as any)["outbound_ids[]"],
      "outbound_ids",
    );

    const now = new Date();

    try {
      const result = await prisma.$transaction(async (tx) => {
        const outbounds = await tx.outbound.findMany({
          where: { id: { in: outboundIds }, deleted_at: null },
          select: { id: true, no: true, deleted_at: true },
        });

        if (outbounds.length !== outboundIds.length) {
          const found = new Set(outbounds.map((o) => o.id));
          const missing = outboundIds.filter((id) => !found.has(id));
          throw notFound(
            `ไม่พบ outbound บางรายการ หรือถูกลบแล้ว: ${missing.join(", ")}`,
          );
        }

        const locked = await tx.batch_outbound.findMany({
          where: { outbound_id: { in: outboundIds }, status: "process" },
          select: { outbound_id: true, user_id: true, created_at: true },
        });

        if (locked.length > 0) {
          throw conflict("มี Outbound บางรายการถูกล็อกอยู่แล้ว", {
            field: "outbound_ids",
            locked,
          });
        }

        const batchName = await generateBatchPickName(tx, now);

        await tx.batch_outbound.createMany({
          data: outboundIds.map((outbound_id) => ({
            name: batchName,
            outbound_id,
            user_id: userId,
            status: "process",
            created_at: now,
            updated_at: now,
          })),
          skipDuplicates: false,
        });

        const created = await tx.batch_outbound.findMany({
          where: { outbound_id: { in: outboundIds }, status: "process" },
          include: {
            outbound: {
              select: {
                id: true,
                no: true,
                outbound_barcode: true,
                out_type: true,
              },
            },
            user: {
              select: {
                id: true,
                username: true,
                first_name: true,
                last_name: true,
              },
            },
          },
          orderBy: { id: "asc" },
        });

        return { batch_name: batchName, rows: created };
      });

      return res.status(201).json({
        message: "สร้าง Batch INV (lock outbound) สำเร็จ",
        batch_name: result.batch_name,
        data: result.rows,
      });
    } catch (e: any) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002"
      ) {
        throw conflict("มี Outbound บางรายการถูกล็อกอยู่แล้ว (ชน unique outbound_id)", {
          field: "outbound_ids",
        });
      }
      throw e;
    }
  },
);

/**
 * ✅ LIST ALL Locks
 * GET /api/batch-outbounds?status=OPEN
 */
export const getBatchOutbounds = asyncHandler(async (req: Request, res: Response) => {
  const status = typeof req.query.status === "string" ? req.query.status.trim() : undefined;

  const where: any = {};
  if (status) where.status = status;

  const rows = await prisma.batch_outbound.findMany({
    where,
    include: {
      outbound: { select: { id: true, no: true, outbound_barcode: true, out_type: true } },
      user: { select: { id: true, username: true, first_name: true, last_name: true } },
    },
    orderBy: { created_at: "desc" },
  });

  return res.json({ total: rows.length, data: rows });
});

/**
 * ✅ LIST My Locks
 * GET /api/batch-outbounds/my
 */
export const getMyBatchOutbounds = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = getUserId(req);

    const rows = await prisma.batch_outbound.findMany({
      where: { user_id: userId, status: "process" },
      include: {
        outbound: {
          select: {
            id: true,
            no: true,
            outbound_barcode: true,
            out_type: true,
          },
        },
      },
      orderBy: { created_at: "desc" },
    });

    return res.json({ total: rows.length, data: rows });
  },
);

type BatchGroupRow = {
  name: string;
  status: string;
  created_at: Date;
  total_outbounds: number;
  user_pick: string | null;
};

export const buildBatchOutboundDepartmentWhere = (
  req: AuthRequest,
): Prisma.batch_outboundWhereInput => {
  const access = req.departmentAccess;

  if (!access) {
    throw new Error(
      "departmentAccess is missing. Please use attachDepartmentAccess middleware before controller.",
    );
  }

  const requestedDepartmentId =
    typeof req.query.department_id === "string"
      ? req.query.department_id.trim()
      : "";

  if (access.isPrivileged) {
    if (requestedDepartmentId) {
      return {
        outbound: {
          department_id: requestedDepartmentId,
        },
      };
    }

    return {};
  }

  const allowedDepartmentIds = access.allowedDepartmentIds ?? [];

  if (allowedDepartmentIds.length === 0) {
    return {
      outbound: {
        department_id: { in: [] },
      },
    };
  }

  if (requestedDepartmentId) {
    if (!allowedDepartmentIds.includes(requestedDepartmentId)) {
      return {
        outbound: {
          department_id: { in: [] },
        },
      };
    }

    return {
      outbound: {
        department_id: requestedDepartmentId,
      },
    };
  }

  return {
    outbound: {
      department_id: { in: allowedDepartmentIds },
    },
  };
};


export const getMyBatchOutboundGroups = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const page = Number(req.query.page) || 1;
    const limit =
      req.query.limit !== undefined ? Number(req.query.limit) || 10 : 10;

    if (isNaN(page) || page < 1) {
      throw badRequest("page ต้องเป็นตัวเลขบวกที่มีค่ามากกว่า 0");
    }

    if (isNaN(limit) || limit < 1) {
      throw badRequest("limit ต้องเป็นตัวเลขบวกที่มีค่ามากกว่า 0");
    }

    const skip = (page - 1) * limit;

    const rawStatus =
      typeof req.query.status === "string" ? req.query.status.trim() : "";
    const status = rawStatus.toLowerCase();

    const search =
      typeof req.query.search === "string" ? req.query.search.trim() : "";

    const allowedStatuses = ["completed", "process"] as const;

    if (
      status &&
      !allowedStatuses.includes(status as (typeof allowedStatuses)[number])
    ) {
      throw badRequest("status ต้องเป็น completed หรือ process");
    }

    if (!req.departmentAccess) {
      throw badRequest(
        "กรุณาเรียก middleware attachDepartmentAccess ก่อนใช้งาน endpoint นี้",
      );
    }

    const departmentWhere = buildBatchOutboundDepartmentWhere(req);
    const searchWhere = buildBatchGroupSearchWhere(search);

    // where สำหรับ list
    const listWhere = {
      ...(status ? { status } : {}),
      ...departmentWhere,
      ...searchWhere,
    };

    // where สำหรับ statusCounts (ไม่นับติด status filter ปัจจุบัน)
    const countWhere = {
      ...departmentWhere,
      ...searchWhere,
    };

    const allGroups = await prisma.batch_outbound.groupBy({
      by: ["name"],
      where: listWhere,
      _count: { outbound_id: true },
      _min: { created_at: true },
      _max: { status: true },
      orderBy: { _min: { created_at: "desc" } },
    });

    const filteredGroups = allGroups.filter(
      (g) => (g.name ?? "").trim() !== "",
    );

    const total = filteredGroups.length;

    const pagedGroups = filteredGroups.slice(skip, skip + limit);

    const groupNames = pagedGroups
      .map((g) => g.name)
      .filter((n): n is string => !!n && n.trim() !== "");

    const batchRows = await prisma.batch_outbound.findMany({
      where: {
        name: { in: groupNames },
        ...departmentWhere,
      },
      select: {
        name: true,
        outbound_id: true,
      },
    });

    const outboundIds = batchRows.map((b) => b.outbound_id);

    const goodsOutItems = await prisma.goods_out_item.findMany({
      where: {
        outbound_id: { in: outboundIds },
        deleted_at: null,
        user_pick: { not: null },
      },
      select: {
        outbound_id: true,
        user_pick: true,
      },
    });

    const outboundUserPickMap = new Map<number, string>();

    for (const row of goodsOutItems) {
      if (!outboundUserPickMap.has(row.outbound_id)) {
        outboundUserPickMap.set(row.outbound_id, row.user_pick!);
      }
    }

    const groupUserPickMap = new Map<string, string>();

    for (const row of batchRows) {
      const user = outboundUserPickMap.get(row.outbound_id);
      if (user && row.name && !groupUserPickMap.has(row.name)) {
        groupUserPickMap.set(row.name, user);
      }
    }

    const data: BatchGroupRow[] = pagedGroups.map((g) => ({
      name: g.name as string,
      status: g._max.status ?? "unknown",
      created_at: g._min.created_at ?? new Date(0),
      total_outbounds: g._count.outbound_id,
      user_pick: groupUserPickMap.get(g.name as string) ?? null,
    }));

    // statusCounts
    const [processGroups, completedGroups] = await Promise.all([
      prisma.batch_outbound.groupBy({
        by: ["name"],
        where: {
          ...countWhere,
          status: "process",
        },
        _count: { outbound_id: true },
      }),
      prisma.batch_outbound.groupBy({
        by: ["name"],
        where: {
          ...countWhere,
          status: "completed",
        },
        _count: { outbound_id: true },
      }),
    ]);

    const processCount = processGroups.filter(
      (g) => (g.name ?? "").trim() !== "",
    ).length;

    const completedCount = completedGroups.filter(
      (g) => (g.name ?? "").trim() !== "",
    ).length;

    return res.json({
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        statusCounts: {
          process: processCount,
          completed: completedCount,
        },
      },
    });
  },
);

/**
 * ✅ RELEASE Locks (ปลดล็อกหลาย outbound_id)
 * PATCH /api/batch-outbounds/release
 * body: { outbound_ids: number[] }
 *
 * - ปลดได้เฉพาะของตัวเอง (ถ้าต้องการให้ admin ปลดได้ ให้เพิ่มเงื่อนไข)
 */
export const releaseBatchOutbounds = asyncHandler(
  async (req: Request<{}, {}, { outbound_ids: any; user_id?: any }>, res: Response) => {
    const userId = getUserId(req);
    const outboundIds = normalizeNumberArray((req.body as any).outbound_ids ?? (req.body as any)["outbound_ids[]"], "outbound_ids");

    const now = new Date();

    // เช็คว่ามี lock ของ user นี้จริง
    const existing = await prisma.batch_outbound.findMany({
      where: { outbound_id: { in: outboundIds }, status: "OPEN" },
      select: { id: true, outbound_id: true, user_id: true },
    });

    if (existing.length === 0) {
      return res.json({ message: "ไม่มีรายการที่ต้องปลดล็อก", released: 0 });
    }

    const notMine = existing.filter((x) => x.user_id !== userId);
    if (notMine.length > 0) {
      throw conflict("มีบางรายการไม่ได้ถูกล็อกโดยคุณ", {
        field: "outbound_ids",
        not_mine: notMine.map((x) => x.outbound_id),
      });
    }

    const updated = await prisma.batch_outbound.updateMany({
      where: { outbound_id: { in: outboundIds }, user_id: userId, status: "process" },
      data: { status: "RELEASED", released_at: now, updated_at: now },
    });

    return res.json({
      message: "ปลดล็อก Batch INV สำเร็จ",
      released: updated.count,
      outbound_ids: outboundIds,
    });
  }
);

/**
 * ✅ DELETE Batch by name (ลบทั้งชุด)
 * DELETE /api/batch-outbounds/by-name/:name
 *
 * - ลบเฉพาะ batch ของ user ใน token
 * - ลบเฉพาะ status = OPEN (แนะนำ)
 */
export const deleteBatchOutboundsByName = asyncHandler(
  async (req: Request<{ name: string }>, res: Response) => {
    const userId = getUserId(req);

    const rawName = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
    const name = decodeURIComponent(String(rawName ?? "")).trim();
    if (!name) throw badRequest("กรุณาระบุ batch name");

    // 1) ดึง rows ของ batch ตามชื่อ (เฉพาะ process ของ user นี้) ไว้ตอบกลับ
    const rows = await prisma.batch_outbound.findMany({
      where: { name, user_id: userId, status: "process" },
      select: { outbound_id: true },
      orderBy: { id: "asc" },
    });

    if (rows.length === 0) {
      throw notFound(`ไม่พบ batch name: ${name}`);
    }

    // 2) ลบทั้งชุดตามชื่อ
    const deleted = await prisma.batch_outbound.deleteMany({
      where: { name, user_id: userId, status: "process" },
    });

    return res.json({
      message: "ลบ Batch สำเร็จ",
      name,
      deleted: deleted.count,
      outbound_ids: rows.map((x) => x.outbound_id),
    });
  },
);

/**
 * ✅ DELETE Batch rows by outbound_id
 * DELETE /api/batch-outbounds/by-outbound/:outbound_id
 *
 * - ลบเฉพาะ batch ของ user ใน token
 * - ลบเฉพาะ status = process
 * - ลบทุกแถวที่ผูก outbound_id นี้ (เผื่อกรณีมีหลาย name)
 */
export const deleteBatchOutboundsByOutboundId = asyncHandler(
  async (req: Request<{ outbound_id: string }>, res: Response) => {
    const userId = getUserId(req);

    const raw = Array.isArray(req.params.outbound_id)
      ? req.params.outbound_id[0]
      : req.params.outbound_id;

    const outboundId = Number(decodeURIComponent(String(raw ?? "")).trim());
    if (!Number.isFinite(outboundId) || outboundId <= 0) {
      throw badRequest("outbound_id ต้องเป็นตัวเลข > 0");
    }

    // 1) ดึง rows (ไว้ตอบกลับ) — เผื่อมีหลาย name
    const rows = await prisma.batch_outbound.findMany({
      where: { outbound_id: outboundId, user_id: userId, status: "process" },
      select: { id: true, outbound_id: true, name: true, created_at: true },
      orderBy: { id: "asc" },
    });

    if (rows.length === 0) {
      throw notFound(`ไม่พบ batch ของ outbound_id=${outboundId} (status=process)`);
    }

    // 2) ลบ
    const deleted = await prisma.batch_outbound.deleteMany({
      where: { outbound_id: outboundId, user_id: userId, status: "process" },
    });

    return res.json({
      message: "ลบ Batch (by outbound_id) สำเร็จ",
      outbound_id: outboundId,
      deleted: deleted.count,
      names: Array.from(new Set(rows.map((x) => x.name).filter(Boolean))),
      rows,
    });
  },
);
