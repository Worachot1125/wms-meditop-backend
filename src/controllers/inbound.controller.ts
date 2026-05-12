import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../utils/asyncHandler";
import { notFound } from "../utils/appError";
import { parseDateInput } from "../utils/parseDate";
import { AuthRequest, buildDepartmentAccessWhere } from "../middleware/auth";
import {
  CreateInboundBody,
  UpdateInboundBody,
  OdooInboundRequest,
} from "../types/inbound";

/**
 * =========================
 * Item matching helpers
 * ✅ เปลี่ยนให้เช็ค items ด้วย:
 *    - product_id
 *    - lot_serial (lot_name)
 * ❌ ไม่ใช้ lot_id ในการเช็ค/เทียบ items แล้ว
 * =========================
 */

// CREATE Inbound
export const createInbound = asyncHandler(
  async (req: Request<{}, {}, CreateInboundBody>, res: Response) => {
    const data = req.body;

    if (
      !data.no ||
      !data.lot ||
      !data.date ||
      data.quantity === undefined ||
      !data.in_type ||
      !data.department
    ) {
      throw badRequest("ข้อมูลไม่ครบถ้วน");
    }

    // กัน quantity ติดลบ
    if (Number.isNaN(Number(data.quantity)) || Number(data.quantity) < 0) {
      throw badRequest("quantity ต้องเป็นตัวเลขและต้องไม่ติดลบ");
    }

    // เช็คซ้ำ no (เพราะเป็น @unique)
    const exists = await prisma.inbound.findUnique({ where: { no: data.no } });
    if (exists) throw badRequest("มี no นี้อยู่แล้ว");

    const inbound = await prisma.inbound.create({
      data: {
        no: data.no,
        lot: data.lot,
        date: parseDateInput(data.date, "date"),
        quantity: Number(data.quantity),
        in_type: data.in_type,
        department: data.department,
        // updated_at ปล่อยให้ null ได้

        invoice:
          data.invoice !== undefined
            ? data.invoice === null
              ? null
              : String(data.invoice).trim() || null
            : null,
      },
    });

    return res.status(201).json(inbound);
  },
);

// GET ALL Inbound
export const getInbounds = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

    const departmentWhere = buildDepartmentAccessWhere(req);

    const baseWhere: Prisma.inboundWhereInput = {
      deleted_at: null,
      ...departmentWhere,
    };

    let where: Prisma.inboundWhereInput = baseWhere;

    if (search) {
      const searchCondition: Prisma.inboundWhereInput = {
        OR: [
          { no: { contains: search, mode: "insensitive" } },
          { lot: { contains: search, mode: "insensitive" } },
          { in_type: { contains: search, mode: "insensitive" } },
          { department: { contains: search, mode: "insensitive" } },
          {
            quantity: {
              equals: isNaN(Number(search)) ? undefined : Number(search),
            },
          },
        ],
      };
      where = { AND: [baseWhere, searchCondition] };
    }

    const inbounds = await prisma.inbound.findMany({
      where,
      orderBy: { created_at: "desc" },
      include: {
        goods_ins: true,
      },
    });

    const departmentIds = [
      ...new Set(
        inbounds
          .map((ib) => ib.department_id)
          .filter((id): id is string => id != null)
          .map((id) => parseInt(id, 10))
          .filter((id) => !isNaN(id)),
      ),
    ];

    const deptMap = new Map<number, string>();
    if (departmentIds.length > 0) {
      const departments = await prisma.department.findMany({
        where: { odoo_id: { in: departmentIds } },
        select: { odoo_id: true, short_name: true },
      });
      departments.forEach((dept) => {
        if (dept.odoo_id) deptMap.set(dept.odoo_id, dept.short_name);
      });
    }

    const formattedInbounds = inbounds.map((inbound) => {
      const deptId = inbound.department_id
        ? parseInt(inbound.department_id, 10)
        : NaN;
      const shortName = !isNaN(deptId) ? deptMap.get(deptId) : undefined;

      return {
        id: inbound.id,
        picking_id: inbound.picking_id,
        no: inbound.no,
        lot: inbound.lot,
        location_id: inbound.location_id,
        location: inbound.location,
        location_dest_id: inbound.location_dest_id,
        location_dest: inbound.location_dest,
        department_id: inbound.department_id,
        department: shortName ?? inbound.department,
        reference: inbound.reference,
        quantity: inbound.quantity,
        origin: inbound.origin,
        date: inbound.date,
        in_type: inbound.in_type,
        created_at: inbound.created_at,
        updated_at: inbound.updated_at,
        items: inbound.goods_ins
          .filter((gi) => !gi.deleted_at)
          .map((gi) => ({
            id: gi.id,
            sequence: gi.sequence,
            product_id: gi.product_id,
            code: gi.code,
            name: gi.name,
            unit: gi.unit,
            tracking: gi.tracking,
            lot_id: gi.lot_id,
            lot: gi.lot,
            lot_serial: gi.lot_serial,
            exp: gi.exp,
            qty: gi.qty,
            quantity_receive: (gi as any).quantity_receive ?? null,
            quantity_count: (gi as any).quantity_count ?? null,
            barcode_id: gi.barcode_id,
          })),
      };
    });

    return res.json(formattedInbounds);
  },
);

const buildInboundSearchCondition = (
  search: string,
): Prisma.inboundWhereInput => {
  const terms = search
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  const searchTerms = terms.length > 0 ? terms : [search];

  const orConditions: Prisma.inboundWhereInput[] = [];

  for (const term of searchTerms) {
    const numericValue = Number(term);

    orConditions.push(
      { no: { contains: term, mode: "insensitive" } },
      { lot: { contains: term, mode: "insensitive" } },
      { in_type: { contains: term, mode: "insensitive" } },
      { department: { contains: term, mode: "insensitive" } },
      { reference: { contains: term, mode: "insensitive" } },
      { origin: { contains: term, mode: "insensitive" } },
      {
        goods_ins: {
          some: {
            deleted_at: null,
            OR: [
              { code: { contains: term, mode: "insensitive" } },
              { name: { contains: term, mode: "insensitive" } },
              { lot: { contains: term, mode: "insensitive" } },
              { lot_serial: { contains: term, mode: "insensitive" } },
            ],
          },
        },
      },
    );

    if (!Number.isNaN(numericValue)) {
      orConditions.push({
        quantity: {
          equals: numericValue,
        },
      });
    }
  }

  return {
    OR: orConditions,
  };
};

const parseDepartmentQuery = (value: unknown): string[] => {
  if (typeof value !== "string") return [];

  return value
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
};

export const getInboundsPaginated = asyncHandler(
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

    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

    const rawStatus = req.query.status;
    const status =
      typeof rawStatus === "string" ? rawStatus.trim().toLowerCase() : "";

    const allowedStatuses = ["pending", "completed"] as const;

    if (
      status &&
      !allowedStatuses.includes(status as (typeof allowedStatuses)[number])
    ) {
      throw badRequest("status ต้องเป็น pending หรือ completed");
    }

    const selectedDepartments = parseDepartmentQuery(req.query.department);

    let selectedDepartmentWhere: Prisma.inboundWhereInput = {};

    if (selectedDepartments.length > 0) {
      const deptRows = await prisma.department.findMany({
        where: {
          OR: [
            {
              short_name: {
                in: selectedDepartments,
                mode: "insensitive",
              },
            },
            {
              full_name: {
                in: selectedDepartments,
                mode: "insensitive",
              },
            },
          ],
        },
        select: {
          odoo_id: true,
          short_name: true,
          full_name: true,
        },
      });

      const selectedDeptIds = deptRows
        .map((d) => d.odoo_id)
        .filter((id): id is number => typeof id === "number")
        .map((id) => String(id));

      selectedDepartmentWhere = {
        OR: [
          {
            department: {
              in: selectedDepartments,
              mode: "insensitive",
            },
          },
          ...(selectedDeptIds.length > 0
            ? [
                {
                  department_id: {
                    in: selectedDeptIds,
                  },
                },
              ]
            : []),
        ],
      };
    }

    const departmentWhere = buildDepartmentAccessWhere(req);

    const baseWhere: Prisma.inboundWhereInput = {
      deleted_at: null,
      ...departmentWhere,
      ...selectedDepartmentWhere,
      ...(status ? { status } : {}),
    };

    let where: Prisma.inboundWhereInput = baseWhere;

    if (search) {
      const searchCondition = buildInboundSearchCondition(search);
      where = { AND: [baseWhere, searchCondition] };
    }

    const baseWhereForCount: Prisma.inboundWhereInput = {
      deleted_at: null,
      ...departmentWhere,
      ...selectedDepartmentWhere,
    };

    let whereForCount: Prisma.inboundWhereInput = baseWhereForCount;

    if (search) {
      const searchCondition = buildInboundSearchCondition(search);
      whereForCount = { AND: [baseWhereForCount, searchCondition] };
    }

    const [inbounds, total, pendingCount, completedCount] = await Promise.all([
      prisma.inbound.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: "desc" },
        include: {
          goods_ins: true,
        },
      }),

      prisma.inbound.count({ where }),

      prisma.inbound.count({
        where: {
          AND: [whereForCount, { status: "pending" }],
        },
      }),

      prisma.inbound.count({
        where: {
          AND: [whereForCount, { status: "completed" }],
        },
      }),
    ]);

    const departmentIds = [
      ...new Set(
        inbounds
          .map((ib) => ib.department_id)
          .filter((id): id is string => id != null)
          .map((id) => parseInt(id, 10))
          .filter((id) => !isNaN(id)),
      ),
    ];

    const deptMap = new Map<number, string>();

    if (departmentIds.length > 0) {
      const departments = await prisma.department.findMany({
        where: { odoo_id: { in: departmentIds } },
        select: { odoo_id: true, short_name: true },
      });

      departments.forEach((dept) => {
        if (dept.odoo_id) deptMap.set(dept.odoo_id, dept.short_name);
      });
    }

    const formattedInbounds = inbounds.map((inbound) => {
      const deptId = inbound.department_id
        ? parseInt(inbound.department_id, 10)
        : NaN;

      const shortName = !isNaN(deptId) ? deptMap.get(deptId) : undefined;

      return {
        id: inbound.id,
        picking_id: inbound.picking_id,
        no: inbound.no,
        lot: inbound.lot,
        quantity: inbound.quantity,
        location_id: inbound.location_id,
        location: inbound.location,
        location_dest_id: inbound.location_dest_id,
        location_dest: inbound.location_dest,
        department_id: inbound.department_id,
        department: shortName ?? inbound.department,
        reference: inbound.reference,
        origin: inbound.origin,
        date: inbound.date,
        in_type: inbound.in_type,
        status: inbound.status,
        created_at: inbound.created_at,
        updated_at: inbound.updated_at,
        items: inbound.goods_ins
          .filter((gi) => !gi.deleted_at)
          .map((gi) => ({
            id: gi.id,
            sequence: gi.sequence,
            product_id: gi.product_id,
            code: gi.code,
            name: gi.name,
            unit: gi.unit,
            tracking: gi.tracking,
            lot_id: gi.lot_id,
            lot: gi.lot,
            lot_serial: gi.lot_serial,
            exp: gi.exp,
            qty: gi.qty,
            quantity_receive: (gi as any).quantity_receive ?? null,
            quantity_count: (gi as any).quantity_count ?? null,
            barcode_id: gi.barcode_id,
          })),
      };
    });

    return res.json({
      data: formattedInbounds,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        statusCounts: {
          pending: pendingCount,
          completed: completedCount,
        },
        department:
          selectedDepartments.length > 0 ? selectedDepartments.join(",") : null,
      },
    });
  },
);

// GET Inbound BY no (unique)
export const getInboundByGr = asyncHandler(
  async (req: Request<{ gr: string }>, res: Response) => {
    const raw = req.params.gr;
    const no = (Array.isArray(raw) ? raw[0] : raw)?.trim();

    if (!no) throw badRequest("กรุณาระบุ no ใน path เช่น /inbounds/:no");

    const inbound = await prisma.inbound.findUnique({
      where: { no },
      include: {
        goods_ins: {
          where: { deleted_at: null },
          orderBy: { created_at: "desc" },
        },
      },
    });

    if (!inbound) throw notFound("ไม่พบ inbound");

    // Lookup department short_name
    let departmentShortName: string | undefined;
    if (inbound.department_id) {
      const deptId = parseInt(inbound.department_id, 10);
      if (!isNaN(deptId)) {
        const dept = await prisma.department.findFirst({
          where: { odoo_id: deptId },
          select: { short_name: true },
        });
        departmentShortName = dept?.short_name;
      }
    }

    const formattedInbound = {
      id: inbound.id,
      picking_id: inbound.picking_id,
      no: inbound.no,
      location_id: inbound.location_id,
      lot: inbound.lot,
      quantity: inbound.quantity,
      location: inbound.location,
      location_dest_id: inbound.location_dest_id,
      location_dest: inbound.location_dest,
      department_id: inbound.department_id,
      department: departmentShortName ?? inbound.department,
      reference: inbound.reference,
      origin: inbound.origin,
      date: inbound.date,
      in_type: inbound.in_type,
      created_at: inbound.created_at,
      updated_at: inbound.updated_at,
      items: inbound.goods_ins.map((gi) => ({
        id: gi.id,
        sequence: gi.sequence,
        product_id: gi.product_id,
        code: gi.code,
        name: gi.name,
        unit: gi.unit,
        tracking: gi.tracking,
        lot_id: gi.lot_id, // ✅ ยังส่งกลับเหมือนเดิม
        lot: gi.lot,
        lot_serial: gi.lot_serial,
        exp: gi.exp,
        qty: gi.qty,
        barcode_id: gi.barcode_id,
      })),
    };

    return res.json(formattedInbound);
  },
);

// UPDATE Inbound
export const updateInbound = asyncHandler(
  async (
    req: Request<{ gr: string }, {}, UpdateInboundBody>,
    res: Response,
  ) => {
    const no = Array.isArray(req.params.gr) ? req.params.gr[0] : req.params.gr;

    const existing = await prisma.inbound.findUnique({ where: { no } });
    if (!existing) throw notFound("ไม่พบ inbound");
    if (existing.deleted_at) throw badRequest("inbound ถูกลบไปแล้ว");

    const data = req.body;

    // validate quantity ถ้ามีส่งมา
    if (data.quantity !== undefined) {
      if (Number.isNaN(Number(data.quantity)) || Number(data.quantity) < 0) {
        throw badRequest("quantity ต้องเป็นตัวเลขและต้องไม่ติดลบ");
      }
    }

    const inbound = await prisma.inbound.update({
      where: { no },
      data: {
        no: data.no,
        lot: data.lot,
        date: data.date ? parseDateInput(data.date, "date") : undefined,
        quantity:
          data.quantity !== undefined ? Number(data.quantity) : undefined,
        in_type: data.in_type,
        department: data.department,
        updated_at: new Date(),
      },
    });

    return res.json(inbound);
  },
);

/// DELETE Inbound
export const deleteInbound = asyncHandler(
  async (req: Request<{ gr: string }>, res: Response) => {
    const no = Array.isArray(req.params.gr) ? req.params.gr[0] : req.params.gr;

    const old = await prisma.inbound.findUnique({ where: { no } });
    if (!old) throw notFound("ไม่พบ inbound");
    if (old.deleted_at) throw badRequest("inbound ถูกลบไปแล้ว");

    await prisma.inbound.update({
      where: { no },
      data: { deleted_at: new Date(), updated_at: new Date() },
    });

    return res.json({ message: "ลบ inbound เรียบร้อยแล้ว" });
  },
);

const badRequest = (message: string) => {
  const err: any = new Error(message);
  err.statusCode = 400;
  return err;
};

function normText(v: unknown) {
  return String(v ?? "")
    .trim()
    .toLowerCase();
}

function normDate(v: unknown) {
  if (!v) return "NULL";
  const d = new Date(v as any);
  if (Number.isNaN(d.getTime())) return "NULL";
  return d.toISOString().slice(0, 10);
}

function qty(v: unknown) {
  return Number(v ?? 0);
}

function buildInKey(item: any) {
  return [
    item.product_id ?? "NULL",
    normText(item.code),
    normText(item.name),
    normText(item.unit),
    item.lot_id ?? "NULL",
    normText(item.lot_serial ?? item.lot),
    normDate(item.exp),
  ].join("|");
}

function buildOutKey(item: any) {
  return [
    item.product_id ?? "NULL",
    normText(item.code),
    normText(item.name),
    normText(item.unit),
    item.lot_id ?? "NULL",
    normText(item.lot_serial),
    normDate((item as any).exp), // ถ้า goods_out_item ไม่มี exp ในบางระบบ จะเป็น NULL
  ].join("|");
}

function summarizeLines(rows: any[], type: "in" | "out") {
  const map = new Map<string, { key: string; qty: number; sample: any }>();

  for (const row of rows) {
    const key = type === "in" ? buildInKey(row) : buildOutKey(row);

    const rowQty =
      type === "in" ? qty(row.quantity_receive ?? row.qty) : qty(row.qty);

    const current = map.get(key);

    if (current) {
      current.qty += rowQty;
    } else {
      map.set(key, { key, qty: rowQty, sample: row });
    }
  }

  return Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key));
}

function assertInboundOutboundMatched(inRows: any[], outRows: any[]) {
  const inSum = summarizeLines(inRows, "in");
  const outSum = summarizeLines(outRows, "out");

  if (inSum.length !== outSum.length) {
    throw badRequest(
      `สินค้าไม่ตรงกัน: inbound มี ${inSum.length} กลุ่ม แต่ outbound มี ${outSum.length} กลุ่ม`,
    );
  }

  const outMap = new Map(outSum.map((x) => [x.key, x]));

  for (const inLine of inSum) {
    const outLine = outMap.get(inLine.key);

    if (!outLine) {
      console.log("INBOUND_KEY_NOT_FOUND:", inLine.key);
      console.log(
        "OUTBOUND_KEYS:",
        outSum.map((x) => ({
          key: x.key,
          qty: x.qty,
          code: x.sample.code,
          lot_id: x.sample.lot_id,
          lot_serial: x.sample.lot_serial,
        })),
      );

      throw badRequest(
        `สินค้าไม่ตรงกัน: ไม่พบสินค้าใน outbound ที่ตรงกับ ${inLine.sample.code ?? "-"} / lot ${inLine.sample.lot_serial ?? inLine.sample.lot ?? "-"}`,
      );
    }

    if (inLine.qty !== outLine.qty) {
      throw badRequest(
        `จำนวนไม่ตรงกัน: ${inLine.sample.code ?? "-"} / lot ${inLine.sample.lot_serial ?? inLine.sample.lot ?? "-"} inbound=${inLine.qty}, outbound=${outLine.qty}`,
      );
    }
  }
}

async function generatePickName(tx: any) {
  const prefix = "PICK_";
  const latest = await tx.batch_outbound.findFirst({
    where: {
      name: {
        startsWith: prefix,
      },
    },
    orderBy: {
      id: "desc",
    },
    select: {
      id: true,
      name: true,
    },
  });

  const nextNo = Number(latest?.id ?? 0) + 1;
  return `${prefix}${String(nextNo).padStart(5, "0")}`;
}

function normLot(v: unknown) {
  return String(v ?? "")
    .trim()
    .replace(/\s+/g, "")
    .toLowerCase();
}

function normNullableId(v: unknown) {
  if (v === null || v === undefined || v === "") return "NULL";
  return String(v);
}

async function attachExpToOutboundGoods(tx: any, goodsOuts: any[]) {
  const or = goodsOuts
    .filter((x) => x.product_id && (x.lot_id || x.lot_serial))
    .map((x) => ({
      product_id: x.product_id,
      ...(x.lot_id ? { lot_id: x.lot_id } : { lot_name: x.lot_serial }),
    }));

  if (or.length === 0) return goodsOuts;

  const masters = await tx.wms_mdt_goods.findMany({
    where: { OR: or },
    select: {
      product_id: true,
      lot_id: true,
      lot_name: true,
      expiration_date: true,
    },
  });

  const byLotId = new Map<string, Date | null>();
  const byLotName = new Map<string, Date | null>();

  for (const m of masters) {
    if (m.product_id && m.lot_id != null) {
      byLotId.set(`${m.product_id}|${m.lot_id}`, m.expiration_date);
    }

    if (m.product_id && m.lot_name) {
      byLotName.set(
        `${m.product_id}|${normText(m.lot_name)}`,
        m.expiration_date,
      );
    }
  }

  return goodsOuts.map((x) => ({
    ...x,
    exp:
      byLotId.get(`${x.product_id}|${x.lot_id}`) ??
      byLotName.get(`${x.product_id}|${normText(x.lot_serial)}`) ??
      null,
  }));
}

export const replaceOutboundByInbound = asyncHandler(
  async (req: Request<{ no: string }>, res: Response) => {
    const no = decodeURIComponent(req.params.no || "").trim();
    const outboundId = Number(req.body?.outbound_id);
    const userId = Number(req.body?.user_id);
    const remark = String(req.body?.remark ?? "").trim();

    if (!no) throw badRequest("ไม่พบเลข inbound");
    if (!Number.isFinite(outboundId))
      throw badRequest("outbound_id ไม่ถูกต้อง");
    if (!Number.isFinite(userId)) throw badRequest("user_id ไม่ถูกต้อง");

    const result = await prisma.$transaction(async (tx) => {
      const inbound = await tx.inbound.findUnique({
        where: { no },
        include: {
          goods_ins: {
            where: { deleted_at: null },
          },
        },
      });

      if (!inbound || inbound.deleted_at) {
        throw badRequest(`ไม่พบ inbound: ${no}`);
      }

      if (inbound.status === "completed") {
        throw badRequest("Inbound นี้ completed แล้ว");
      }

      const outbound = await tx.outbound.findUnique({
        where: { id: outboundId },
        include: {
          goods_outs: {
            where: { deleted_at: null },
          },
          batch_lock: true,
        },
      });

      if (!outbound || outbound.deleted_at) {
        throw badRequest("ไม่พบ outbound");
      }

      if (outbound.batch_lock) {
        throw badRequest(
          `Outbound นี้ถูกสร้าง batch แล้ว: ${outbound.batch_lock.name ?? "-"}`,
        );
      }

      if (!inbound.goods_ins.length) {
        throw badRequest("Inbound ไม่มีรายการสินค้า");
      }

      if (!outbound.goods_outs.length) {
        throw badRequest("Outbound ไม่มีรายการสินค้า");
      }

      const goodsOutsWithExp = await attachExpToOutboundGoods(
        tx,
        outbound.goods_outs,
      );

      assertInboundOutboundMatched(inbound.goods_ins, goodsOutsWithExp);

      const batchName = await generatePickName(tx);

      const batch = await tx.batch_outbound.create({
        data: {
          name: batchName,
          outbound_id: outbound.id,
          user_id: userId,
          status: "completed",
          remark: remark || `Replace outbound from inbound ${inbound.no}`,
          updated_at: new Date(),
          released_at: new Date(),
        },
      });

      for (const item of outbound.goods_outs) {
        const q = qty(item.qty);

        await tx.goods_out_item.update({
          where: { id: item.id },
          data: {
            pick: q,
            confirmed_pick: q,
            status: "completed",
            in_process: true,
            user_pick: String(userId),
            pick_time: new Date(),
            updated_at: new Date(),
          },
        });
      }

      await tx.outbound.update({
        where: { id: outbound.id },
        data: {
          in_process: true,
          updated_at: new Date(),
        },
      });

      await tx.inbound.update({
        where: { id: inbound.id },
        data: {
          status: "completed",
          updated_at: new Date(),
        },
      });

      return {
        inbound_no: inbound.no,
        outbound_id: outbound.id,
        outbound_no: outbound.no,
        batch_id: batch.id,
        batch_name: batch.name,
        batch_status: batch.status,
      };
    });

    return res.json({
      success: true,
      message: "แทนที่ outbound สำเร็จ",
      data: result,
    });
  },
);
