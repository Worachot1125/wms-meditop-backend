// controllers/transfer.controller.ts
import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";
import { parseDateInput } from "../utils/parseDate";
import {
  CreateTransferDocBody,
  UpdateTransferDocBody,
} from "../types/transfer_doc";
import { AuthRequest, buildDepartmentAccessWhere } from "../middleware/auth";

/**
 * =========================
 * Item matching helpers
 * ✅ เปลี่ยนให้เช็ค items ด้วย:
 *    - product_id
 *    - lot_serial (lot_name)
 * ❌ ไม่ใช้ lot_id ในการเช็ค/เทียบ items แล้ว
 * =========================
 */

// normalize lot_serial/lot_name ให้เทียบกันได้เสถียร (กัน space/เคส)
function normalizeLotSerial(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * key สำหรับการเช็ค/เทียบ item (ตัวเดียวกันหรือไม่)
 * - ต้องมี product_id
 * - lot_serial อาจว่างได้ แต่ยังถือว่าเป็นส่วนหนึ่งของ key
 */
function itemKey(productId: unknown, lotSerial: unknown): string {
  const pid = Number(productId);
  const pidPart = Number.isFinite(pid) ? String(pid) : "NaN";
  const lotPart = normalizeLotSerial(lotSerial);
  return `${pidPart}|${lotPart}`;
}

/**
 * เทียบว่า item สองตัวเป็น "ตัวเดียวกัน" ไหม ตามกติกาใหม่
 */
function isSameItem(
  a: { product_id: unknown; lot_serial?: unknown; lot?: unknown },
  b: { product_id: unknown; lot_serial?: unknown; lot?: unknown },
): boolean {
  const aLot = a.lot_serial ?? a.lot;
  const bLot = b.lot_serial ?? b.lot;
  return itemKey(a.product_id, aLot) === itemKey(b.product_id, bLot);
}

// ===== transfer stock location helpers =====
type StockKey = string;
const stockKeyOf = (
  product_id: number | null | undefined,
  lot_name: string | null | undefined,
) => `p:${product_id ?? "null"}|lot:${(lot_name ?? "").trim()}`;

export type StockLocRow = { location_name: string; qty: number };

export async function buildStockLocationMapFromTransferItems(
  items: Array<{
    product_id?: number | null;
    lot_serial?: string | null;
    lot?: string | null;
  }>,
) {
  const keys = items.map((x) =>
    stockKeyOf(x.product_id ?? null, x.lot_serial ?? x.lot ?? null),
  );

  const uniqueKeys = Array.from(new Set(keys));
  const map = new Map<StockKey, StockLocRow[]>();
  if (uniqueKeys.length === 0) return map;

  const pids = Array.from(
    new Set(
      items
        .map((x) => (typeof x.product_id === "number" ? x.product_id : null))
        .filter((x): x is number => x != null),
    ),
  );
  if (pids.length === 0) return map;

  // ดึง stock ทุกแถวของ product ที่เกี่ยวข้อง (แล้วค่อย filter ด้วย key)
  const rows = await prisma.stock.findMany({
    where: {
      source: "wms",
      product_id: { in: pids },
    } as any,
    select: {
      product_id: true,
      lot_name: true,
      location_name: true,
      quantity: true,
    },
    orderBy: [{ product_id: "asc" }, { location_name: "asc" }],
  });

  // temp: key -> (location_name -> qtySum)
  const temp = new Map<StockKey, Map<string, number>>();

  for (const r of rows as any[]) {
    const k = stockKeyOf(r.product_id, r.lot_name ?? null);
    if (!uniqueKeys.includes(k)) continue;

    const locName = String(r.location_name ?? "").trim();
    if (!locName) continue;

    const qty = Number(r.quantity ?? 0);
    if (!Number.isFinite(qty) || qty === 0) continue;

    if (!temp.has(k)) temp.set(k, new Map<string, number>());
    const byLoc = temp.get(k)!;
    byLoc.set(locName, (byLoc.get(locName) ?? 0) + qty);
  }

  // build final map
  for (const [k, byLoc] of temp.entries()) {
    const arr: StockLocRow[] = Array.from(byLoc.entries())
      .map(([location_name, qty]) => ({ location_name, qty }))
      .sort((a, b) => b.qty - a.qty); // ✅ เรียงเยอะ -> น้อย

    map.set(k, arr);
  }

  // ensure every key exists (แม้ไม่เจอ stock)
  for (const k of uniqueKeys) {
    if (!map.has(k)) map.set(k, []);
  }

  return map;
}

export function resolveStockLocationsFromMap(
  map: Map<StockKey, StockLocRow[]>,
  product_id: number | null | undefined,
  lot_serial_or_name: string | null | undefined,
) {
  return (
    map.get(stockKeyOf(product_id ?? null, lot_serial_or_name ?? null)) ?? []
  );
}

export function resolveStockNoListFromMap(
  map: Map<StockKey, StockLocRow[]>,
  product_id: number | null | undefined,
  lot_serial_or_name: string | null | undefined,
) {
  const locs = resolveStockLocationsFromMap(
    map,
    product_id,
    lot_serial_or_name,
  );
  return locs.map((x) => `${x.location_name} (จำนวน ${x.qty})`);
}

/**
 * =========================
 * CREATE transfer_doc
 * =========================
 */
export const createTransferDoc = asyncHandler(
  async (req: Request<{}, {}, CreateTransferDocBody>, res: Response) => {
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
    const exists = await prisma.transfer_doc.findUnique({
      where: { no: data.no },
    });
    if (exists) throw badRequest("มี no นี้อยู่แล้ว");

    const doc = await prisma.transfer_doc.create({
      data: {
        no: data.no,
        lot: data.lot,
        date: parseDateInput(data.date, "date"),
        quantity: Number(data.quantity),
        in_type: data.in_type,
        department: data.department,
      },
    });

    return res.status(201).json(doc);
  },
);

/**
 * =========================
 * GET ALL transfer_docs
 * =========================
 */
export const getTransferDocs = asyncHandler(
  async (req: Request, res: Response) => {
    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

    const baseWhere: Prisma.transfer_docWhereInput = {
      deleted_at: null,
    };

    let where: Prisma.transfer_docWhereInput = baseWhere;

    if (search) {
      const searchCondition: Prisma.transfer_docWhereInput = {
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

    const docs = await prisma.transfer_doc.findMany({
      where,
      orderBy: { created_at: "desc" },
      include: {
        transfer_doc_items: true,
      },
    });

    // Lookup department short_name
    const departmentIds = [
      ...new Set(
        docs
          .map((d) => d.department_id)
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

    const formatted = docs.map((doc) => {
      const deptId = doc.department_id ? parseInt(doc.department_id, 10) : NaN;
      const shortName = !isNaN(deptId) ? deptMap.get(deptId) : undefined;

      return {
        id: doc.id,
        picking_id: doc.picking_id,
        no: doc.no,
        lot: doc.lot,
        location_id: doc.location_id,
        location: doc.location,
        location_dest_id: doc.location_dest_id,
        location_dest: doc.location_dest,
        department_id: doc.department_id,
        department: shortName ?? doc.department,
        reference: doc.reference,
        quantity: doc.quantity,
        origin: doc.origin,
        date: doc.date,
        in_type: doc.in_type,
        created_at: doc.created_at,
        updated_at: doc.updated_at,
        items: doc.transfer_doc_items
          .filter((it) => !it.deleted_at)
          .map((it) => ({
            id: it.id,
            sequence: it.sequence,
            product_id: it.product_id,
            code: it.code,
            name: it.name,
            unit: it.unit,
            tracking: it.tracking,
            lot_id: it.lot_id,
            lot: it.lot,
            lot_serial: it.lot_serial,
            exp: it.exp,
            qty: it.qty,
            quantity_receive: it.quantity_receive ?? null,
            quantity_count: it.quantity_count ?? null,
            quantity_put: (it as any).quantity_put ?? null,
            ncr_location: (it as any).ncr_location ?? null, // ✅ NEW
            barcode_id: it.barcode_id,
            user_ref: (it as any).user_ref ?? null,
          })),
      };
    });

    return res.json(formatted);
  },
);

function parseTransferDocSearchColumns(raw: unknown) {
  if (typeof raw !== "string") return [];

  const allowed = new Set([
    "date",
    "no",
    "lot",
    "in_type",
    "department",
    "quantity",
    "location",
    "location_dest",
    "reference",
    "origin",
  ]);

  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => allowed.has(s));
}

function buildTransferDocSearchWhere(
  search: string,
  columns: string[],
): Prisma.transfer_docWhereInput {
  const baseWhere: Prisma.transfer_docWhereInput = { deleted_at: null };

  if (!search) return baseWhere;

  const orConditions: Prisma.transfer_docWhereInput[] = [];

  if (columns.includes("date")) {
    const maybeDate = new Date(search);
    if (!Number.isNaN(maybeDate.getTime())) {
      const yyyy = maybeDate.getUTCFullYear();
      const mm = String(maybeDate.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(maybeDate.getUTCDate()).padStart(2, "0");

      orConditions.push({
        date: {
          gte: new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`),
          lt: new Date(`${yyyy}-${mm}-${dd}T23:59:59.999Z`),
        },
      } as any);
    }
  }

  if (columns.includes("no")) {
    orConditions.push({
      no: { contains: search, mode: "insensitive" },
    });
  }

  if (columns.includes("lot")) {
    orConditions.push({
      lot: { contains: search, mode: "insensitive" },
    });
  }

  if (columns.includes("in_type")) {
    orConditions.push({
      in_type: { contains: search, mode: "insensitive" },
    });
  }

  if (columns.includes("department")) {
    orConditions.push({
      department: { contains: search, mode: "insensitive" },
    });
  }

  if (columns.includes("quantity")) {
    const qty = Number(search);
    if (!Number.isNaN(qty)) {
      orConditions.push({
        quantity: { equals: qty },
      });
    }
  }

  if (columns.includes("location")) {
    orConditions.push({
      location: { contains: search, mode: "insensitive" },
    });
  }

  if (columns.includes("location_dest")) {
    orConditions.push({
      location_dest: { contains: search, mode: "insensitive" },
    });
  }

  if (columns.includes("reference")) {
    orConditions.push({
      reference: { contains: search, mode: "insensitive" },
    });
  }

  if (columns.includes("origin")) {
    orConditions.push({
      origin: { contains: search, mode: "insensitive" },
    });
  }

  // มี search แต่ไม่มี column ที่เลือก หรือ parse ไม่ได้
  if (orConditions.length === 0) {
    return {
      AND: [baseWhere, { id: -1 }],
    };
  }

  return {
    AND: [baseWhere, { OR: orConditions }],
  };
}

const buildTransferDocSearchWhereByTerms = (
  search: string,
  selectedColumns: ReturnType<typeof parseTransferDocSearchColumns>,
): Prisma.transfer_docWhereInput => {
  const terms = search
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  const searchTerms = terms.length > 0 ? terms : [search];

  if (!search || searchTerms.length === 0) return {};

  return {
    OR: searchTerms.map((term) =>
      buildTransferDocSearchWhere(term, selectedColumns),
    ),
  };
};

const parseDepartmentNames = (value: unknown): string[] => {
  if (typeof value !== "string") return [];

  return value
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
};

/**
 * =========================
 * GET transfer_docs (PAGINATED)
 * =========================
 */
export const getTransferDocsPaginated = asyncHandler(
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

    const allowedStatuses = ["pending", "process", "completed"] as const;

    if (
      status &&
      !allowedStatuses.includes(status as (typeof allowedStatuses)[number])
    ) {
      throw badRequest("status ต้องเป็น pending, process หรือ completed");
    }

    const selectedDepartments = parseDepartmentNames(req.query.department);

    let selectedDepartmentWhere: Prisma.transfer_docWhereInput = {};

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

    const selectedColumns = parseTransferDocSearchColumns(req.query.columns);

    const searchWhere = buildTransferDocSearchWhereByTerms(
      search,
      selectedColumns,
    );

    const departmentWhere = buildDepartmentAccessWhere(req);

    const where: Prisma.transfer_docWhereInput = {
      AND: [
        searchWhere,
        departmentWhere,
        selectedDepartmentWhere,
        ...(status ? [{ status }] : []),
      ],
    };

    const whereForCount: Prisma.transfer_docWhereInput = {
      AND: [searchWhere, departmentWhere, selectedDepartmentWhere],
    };

    const [docs, total, pendingCount, processCount, completedCount] =
      await Promise.all([
        prisma.transfer_doc.findMany({
          where,
          skip,
          take: limit,
          orderBy: { created_at: "desc" },
          include: { transfer_doc_items: true },
        }),

        prisma.transfer_doc.count({ where }),

        prisma.transfer_doc.count({
          where: {
            AND: [whereForCount, { status: "pending" }],
          },
        }),

        prisma.transfer_doc.count({
          where: {
            AND: [whereForCount, { status: "process" }],
          },
        }),

        prisma.transfer_doc.count({
          where: {
            AND: [whereForCount, { status: "completed" }],
          },
        }),
      ]);

    const departmentIds = Array.from(
      new Set(
        docs
          .map((d) => d.department_id)
          .filter((id): id is string => id != null)
          .map((id) => parseInt(id, 10))
          .filter((id) => !isNaN(id)),
      ),
    );

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

    const allItems = docs.flatMap((d) => d.transfer_doc_items || []);
    const stockLocMap = await buildStockLocationMapFromTransferItems(
      allItems.map((it) => ({
        product_id: it.product_id,
        lot_serial: it.lot_serial,
        lot: it.lot,
      })),
    );

    const formatted = docs.map((doc) => {
      const deptId = doc.department_id ? parseInt(doc.department_id, 10) : NaN;
      const shortName = !isNaN(deptId) ? deptMap.get(deptId) : undefined;

      return {
        id: doc.id,
        picking_id: doc.picking_id,
        no: doc.no,
        lot: doc.lot,
        quantity: doc.quantity,
        location_id: doc.location_id,
        location: doc.location,
        location_dest_id: doc.location_dest_id,
        location_dest: doc.location_dest,
        department_id: doc.department_id,
        department: shortName ?? doc.department,
        reference: doc.reference,
        origin: doc.origin,
        date: doc.date,
        in_type: doc.in_type,
        status: doc.status,
        created_at: doc.created_at,
        updated_at: doc.updated_at,

        items: (doc.transfer_doc_items || [])
          .filter((it) => !it.deleted_at)
          .map((it) => {
            const lotText = (it.lot_serial ?? it.lot ?? null) as string | null;

            const lock_locations = resolveStockLocationsFromMap(
              stockLocMap,
              it.product_id,
              lotText,
            );

            const lock_no_list = lock_locations.map(
              (x) => `${x.location_name} (จำนวน ${x.qty})`,
            );

            return {
              id: it.id,
              sequence: it.sequence,
              product_id: it.product_id,
              code: it.code,
              name: it.name,
              unit: it.unit,
              tracking: it.tracking,
              lot_id: it.lot_id,
              lot: it.lot,
              lot_serial: it.lot_serial,
              exp: it.exp,
              qty: it.qty,
              quantity_receive: it.quantity_receive ?? null,
              quantity_count: it.quantity_count ?? null,
              quantity_put: (it as any).quantity_put ?? null,
              ncr_location: (it as any).ncr_location ?? null,
              barcode_id: it.barcode_id,
              user_ref: (it as any).user_ref ?? null,

              lock_locations,
              lock_no_list,
            };
          }),
      };
    });

    return res.json({
      data: formatted,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        statusCounts: {
          pending: pendingCount,
          process: processCount,
          completed: completedCount,
        },
        department:
          selectedDepartments.length > 0 ? selectedDepartments.join(",") : null,
      },
    });
  },
);

/**
 * =========================
 * GET transfer_doc BY no (unique)
 * =========================
 */
export const getTransferDocByNo = asyncHandler(
  async (req: Request<{ no: string }>, res: Response) => {
    const raw = req.params.no;
    const no = (Array.isArray(raw) ? raw[0] : raw)?.trim();

    if (!no) throw badRequest("กรุณาระบุ no ใน path เช่น /transfer_docs/:no");

    const doc = await prisma.transfer_doc.findUnique({
      where: { no },
      include: {
        transfer_doc_items: {
          where: { deleted_at: null },
          orderBy: { sequence: "asc" },
        },
      },
    });

    if (!doc) throw notFound("ไม่พบ transfer_doc");
    if (doc.deleted_at) throw badRequest("transfer_doc ถูกลบไปแล้ว");

    // Lookup department short_name
    let departmentShortName: string | undefined;
    if (doc.department_id) {
      const deptId = parseInt(doc.department_id, 10);
      if (!isNaN(deptId)) {
        const dept = await prisma.department.findFirst({
          where: { odoo_id: deptId },
          select: { short_name: true },
        });
        departmentShortName = dept?.short_name;
      }
    }

    // ✅ build stock location map for this doc
    const stockLocMap = await buildStockLocationMapFromTransferItems(
      (doc.transfer_doc_items || []).map((it) => ({
        product_id: it.product_id,
        lot_serial: it.lot_serial,
        lot: it.lot,
      })),
    );

    const formatted = {
      id: doc.id,
      picking_id: doc.picking_id,
      no: doc.no,
      location_id: doc.location_id,
      lot: doc.lot,
      quantity: doc.quantity,
      location: doc.location,
      location_dest_id: doc.location_dest_id,
      location_dest: doc.location_dest,
      department_id: doc.department_id,
      department: departmentShortName ?? doc.department,
      reference: doc.reference,
      origin: doc.origin,
      date: doc.date,
      in_type: doc.in_type,
      created_at: doc.created_at,
      updated_at: doc.updated_at,

      items: (doc.transfer_doc_items || []).map((it) => {
        const lotText = (it.lot_serial ?? it.lot ?? null) as string | null;

        const lock_locations = resolveStockLocationsFromMap(
          stockLocMap,
          it.product_id,
          lotText,
        );

        const lock_no_list = lock_locations.map(
          (x) => `${x.location_name} (จำนวน ${x.qty})`,
        );

        return {
          id: it.id,
          sequence: it.sequence,
          product_id: it.product_id,
          code: it.code,
          name: it.name,
          unit: it.unit,
          tracking: it.tracking,
          lot_id: it.lot_id,
          lot: it.lot,
          lot_serial: it.lot_serial,
          exp: it.exp,
          qty: it.qty,
          quantity_receive: (it as any).quantity_receive ?? null,
          quantity_count: (it as any).quantity_count ?? null,
          quantity_put: (it as any).quantity_put ?? null,
          ncr_location: (it as any).ncr_location ?? null, // ✅ NEW
          barcode_id: it.barcode_id,
          user_ref: (it as any).user_ref ?? null,

          lock_locations,
          lock_no_list,
        };
      }),
    };

    return res.json(formatted);
  },
);

/**
 * =========================
 * UPDATE transfer_doc
 * =========================
 */
export const updateTransferDoc = asyncHandler(
  async (
    req: Request<{ no: string }, {}, UpdateTransferDocBody>,
    res: Response,
  ) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;

    const existing = await prisma.transfer_doc.findUnique({ where: { no } });
    if (!existing) throw notFound("ไม่พบ transfer_doc");
    if (existing.deleted_at) throw badRequest("transfer_doc ถูกลบไปแล้ว");

    const data = req.body;

    if (data.quantity !== undefined) {
      if (Number.isNaN(Number(data.quantity)) || Number(data.quantity) < 0) {
        throw badRequest("quantity ต้องเป็นตัวเลขและต้องไม่ติดลบ");
      }
    }

    const doc = await prisma.transfer_doc.update({
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

    return res.json(doc);
  },
);

/**
 * =========================
 * DELETE transfer_doc (soft)
 * =========================
 */
export const deleteTransferDoc = asyncHandler(
  async (req: Request<{ no: string }>, res: Response) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;

    const old = await prisma.transfer_doc.findUnique({ where: { no } });
    if (!old) throw notFound("ไม่พบ transfer_doc");
    if (old.deleted_at) throw badRequest("transfer_doc ถูกลบไปแล้ว");

    await prisma.transfer_doc.update({
      where: { no },
      data: { deleted_at: new Date(), updated_at: new Date() },
    });

    return res.json({ message: "ลบ transfer_doc เรียบร้อยแล้ว" });
  },
);
