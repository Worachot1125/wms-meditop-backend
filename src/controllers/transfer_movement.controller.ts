import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";
import {
  AuthRequest,
  buildTransferMovementDepartmentAccessWhere,
} from "../middleware/auth";
import type {
  CreateTransferMovementBody,
  UpdateTransferMovementBody,
  ScanMovementLocationBody,
  ScanMovementBarcodeBody,
  ConfirmMovementPickBody,
  ConfirmMovementPutBody,
} from "../types/transfer_movement";
import {
  formatTransferMovement,
  buildInputNumberMap,
} from "../utils/formatters/transfer_movement.formatter";

import {
  resolveBarcodeScan,
  normalizeScanText,
  normalizeBarcodeBaseForMatch,
} from "../utils/helper_scan/barcode";
import { io } from "../index";

// ===== barcode formatter (used by legacy attachBarcodeToMovementItems) =====
type BarcodeFormatter = {
  barcode: string;
  lot_start: number | null;
  lot_stop: number | null;
  exp_start: number | null;
  exp_stop: number | null;
  barcode_length: number | null;
};

/**
 * =========================
 * Barcode helpers (NEW unified) ✅
 * - ใช้แนวคิดใหม่ให้แสดง barcode_text ต่อ item
 * - ไม่กระทบฟังก์ชันเดิม: ยังมี attachBarcodeToMovementItems ไว้
 * =========================
 */

// ===== barcode key (SAME AS STOCKS) ✅ =====
function normalizeLotText(v: unknown): string {
  const s = v == null ? "" : String(v).trim();
  const n = s.replace(/\s+/g, " ").toLowerCase();
  return n.length ? n : "__NULL__";
}

function movementGoodsKey(product_id: number, lot_serial: unknown) {
  return `p:${product_id}|lot:${normalizeLotText(lot_serial)}`;
}

function normalizeText(v: unknown): string {
  return String(v ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * ✅ core helper (ใช้จริง)
 * สร้าง Map<key, barcode_text> จาก transfer_movement_item[]
 *
 * key rule:
 * - pid = item.product_id (ดีที่สุด) หรือ fallback = Number(item.code)
 * - lot = item.lot_serial
 * lookup goods_in:
 * - (product_id == pid) AND (lot_serial == lot)  (case-insensitive)
 * - fallback: (product_id == pid) AND (lot == lot)
 * ใช้แถวล่าสุดก่อน (updated_at/created_at/id desc)
 */
async function buildBarcodeTextMapFromItems(
  items: Array<{
    product_id?: number | null;
    code?: string | null;
    lot_serial?: string | null;
  }>,
): Promise<Map<string, string | null>> {
  // 1) unique pairs (pid + lot_key) ✅ include lot null
  const pairMap = new Map<
    string,
    { pid: number; lot_key: string; lot_name: string | null }
  >();

  for (const it of items) {
    const pidFromItem = Number(it.product_id ?? NaN);
    const pidFromCode = Number(String(it.code ?? "").trim());

    const pid =
      Number.isFinite(pidFromItem) && pidFromItem > 0
        ? pidFromItem
        : pidFromCode;

    if (!Number.isFinite(pid) || pid <= 0) continue;

    const lot_name =
      it.lot_serial == null ? null : String(it.lot_serial).trim() || null;
    const lot_key = normalizeLotText(lot_name);

    const k = movementGoodsKey(pid, lot_name); // p:pid|lot:...
    pairMap.set(k, { pid, lot_key, lot_name });
  }

  const pairs = Array.from(pairMap.values());
  const barcodeTextMap = new Map<string, string | null>();
  if (pairs.length === 0) return barcodeTextMap;

  // 2) build OR where (SAME AS STOCKS) ✅
  const orWhere: Prisma.goods_inWhereInput[] = [];

  for (const p of pairs) {
    // lot null/empty -> match goods_in lot_serial/lot null/""
    if (p.lot_key === "__NULL__") {
      orWhere.push({
        product_id: p.pid,
        deleted_at: null,
        OR: [
          { lot_serial: null },
          { lot_serial: "" },
          { lot: null },
          { lot: "" },
        ],
      });
      continue;
    }

    const lot = String(p.lot_name ?? "").trim();
    orWhere.push({
      product_id: p.pid,
      lot_serial: { equals: lot, mode: "insensitive" as const },
      deleted_at: null,
    });
    orWhere.push({
      product_id: p.pid,
      lot: { equals: lot, mode: "insensitive" as const },
      deleted_at: null,
    });
  }

  // 3) query latest-first
  const rows = await prisma.goods_in.findMany({
    where: { OR: orWhere },
    select: {
      product_id: true,
      lot_serial: true,
      lot: true,
      barcode_text: true,
      updated_at: true,
      created_at: true,
      id: true,
    },
    orderBy: [{ updated_at: "desc" }, { created_at: "desc" }, { id: "desc" }],
  });

  // 4) fill map (first hit per key)
  for (const r of rows) {
    const pid = Number(r.product_id ?? NaN);
    if (!Number.isFinite(pid) || pid <= 0) continue;

    const lotRaw = (r.lot_serial ?? r.lot) as any; // can be null
    const k = movementGoodsKey(pid, lotRaw);

    if (!barcodeTextMap.has(k)) {
      const t = String(r.barcode_text ?? "").trim();
      barcodeTextMap.set(k, t.length > 0 ? t : null);
    }
  }

  return barcodeTextMap;
}

// ✅ payload ที่ formatter ใช้จริง
type AttachBarcodePayload = {
  barcodeTextMap: Map<string, string | null>;
};

/**
 * ✅ NEW: ให้ controller GET เรียกตัวนี้ (แบบที่คุณทำอยู่แล้ว)
 */
async function buildBarcodePayloadFromItems(
  items: Array<{
    product_id?: number | null;
    code?: string | null;
    lot_serial?: string | null;
  }>,
): Promise<AttachBarcodePayload> {
  const barcodeTextMap = await buildBarcodeTextMapFromItems(items);
  return { barcodeTextMap };
}

/**
 * ✅ Legacy: คงชื่อ/โครงเดิมไว้ กันกระทบโค้ดเก่า
 * - return { keyToBarcodeText, barcodeMap }
 * - keyToBarcodeText ใช้ rule ใหม่เดียวกันกับ barcodeTextMap
 */

/**
 * =========================
 * Helpers
 * =========================
 */

function pickIdParam(req: Request): number {
  const raw = (req.params as any).id;
  const idStr = Array.isArray(raw) ? raw[0] : raw;
  const id = Number(idStr);
  if (!Number.isFinite(id)) throw badRequest("id ต้องเป็นตัวเลข");
  return id;
}

function asString(v: any): string {
  return String(v ?? "").trim();
}

function asInt(v: any, field: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw badRequest(`${field} ต้องเป็นตัวเลขจำนวนเต็ม`, { field });
  }
  return n;
}

function asNonEmpty(v: any, field: string): string {
  const s = asString(v);
  if (!s) throw badRequest(`${field} ห้ามว่าง`, { field });
  return s;
}

function asPositiveInt(v: any, field: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw badRequest(`${field} ต้องเป็นจำนวนเต็ม > 0`, { field });
  }
  return n;
}

async function resolveLocationByFullName(full_name: string) {
  const loc = await prisma.location.findFirst({
    where: { full_name, deleted_at: null },
    select: { id: true, full_name: true, ncr_check: true },
  });
  if (!loc) throw badRequest(`ไม่พบ location full_name: ${full_name}`);
  return loc;
}

function asPin(v: any) {
  const s = String(v ?? "").trim();
  if (!/^\d{4,6}$/.test(s)) throw badRequest("กรุณากรอก PIN (4-6 หลัก)");
  return s;
}

function uniqPositiveInts(arr: any, field: string): number[] {
  const list = Array.isArray(arr) ? arr : [];
  const ids = Array.from(
    new Set(
      list
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n) && n > 0 && Number.isInteger(n)),
    ),
  );
  if (ids.length === 0)
    throw badRequest(`${field} ต้องมีอย่างน้อย 1 ค่า`, { field });
  return ids;
}

function uniqPositiveIntsOptional(arr: any): number[] {
  const list = Array.isArray(arr) ? arr : [];
  return Array.from(
    new Set(
      list
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n) && n > 0 && Number.isInteger(n)),
    ),
  );
}

function buildTransferMovementVisibilityWhere(
  req: AuthRequest,
): Prisma.transfer_movementWhereInput {
  const user = req.user;

  if (!user?.id) {
    throw badRequest("Unauthorized");
  }

  const level = String(user.user_level ?? "").trim();

  // ✅ Admin เห็นทั้งหมด
  if (level === "Admin") {
    return {};
  }

  // ✅ Supervisor เห็นเฉพาะเอกสารที่ตัวเองสร้าง
  if (level === "Supervisor") {
    return {
      user_id: user.id,
    };
  }

  // ✅ Operator เห็นเฉพาะเอกสารที่ตัวเองถูก assign ใน movement_user_works
  if (level === "Operator") {
    return {
      movement_user_works: {
        some: {
          user_id: user.id,
        },
      },
    };
  }

  // default: จำกัดแบบปลอดภัย
  return {
    user_id: user.id,
  };
}

/**
 * =========================
 * Stock bucket key (unchanged)
 * =========================
 */

type BuildBucketKeyInput = {
  source: string; // "wms"
  product_id: number;
  product_code?: string | null;
  lot_id?: number | null;
  lot_name?: string | null;
  location_id: number;
  expiration_date?: Date | string | null;
};

function dateOnlyISO(v: Date | string | null | undefined) {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function buildStockBucketKey(input: BuildBucketKeyInput) {
  const source = String(input.source ?? "")
    .trim()
    .toLowerCase();
  const pid = Number(input.product_id ?? 0);
  const pcode = String(input.product_code ?? "")
    .trim()
    .toLowerCase();
  const lotName = String(input.lot_name ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
  const locId = Number(input.location_id ?? 0);
  const exp = dateOnlyISO(input.expiration_date ?? null);

  return [
    `src:${source}`,
    `pid:${pid}`,
    `pcode:${pcode}`,
    `lot:${lotName}`,
    `loc:${locId}`,
    `exp:${exp}`,
  ].join("|");
}

// helper: อ่าน userId จาก auth middleware
function getCreatorUserIdFromReq(req: Request): number | null {
  const u = (req as any).user;
  const id = Number(u?.id ?? NaN);
  return Number.isFinite(id) && id > 0 ? id : null;
}

// =========================
// USER WORK payload helper ✅ (unchanged)
// =========================

type UserWorkLite = {
  id: number;
  first_name: string;
  last_name: string;
  tel: string | null;
  user_level: string | null;
};

async function buildUserWorkMapFromRows(
  rows:
    | Array<{ user_work_id?: number | null }>
    | { user_work_id?: number | null }
    | null
    | undefined,
): Promise<Map<number, UserWorkLite>> {
  const list = Array.isArray(rows) ? rows : rows ? [rows] : [];

  const ids = Array.from(
    new Set(
      list
        .map((r) => Number((r as any)?.user_work_id ?? NaN))
        .filter((x) => Number.isFinite(x) && x > 0),
    ),
  );

  if (ids.length === 0) return new Map();

  const users = await prisma.user.findMany({
    where: { id: { in: ids }, deleted_at: null },
    select: {
      id: true,
      first_name: true,
      last_name: true,
      tel: true,
      user_level: true,
    },
  });

  return new Map(users.map((u) => [u.id, u]));
}

const TM_INCLUDE_FULL = Prisma.validator<Prisma.transfer_movementInclude>()({
  user: true,
  department: true,
  movement_departments: {
    include: { department: true },
  },
  movement_user_works: {
    include: { user: true },
  },
  items: {
    where: { deleted_at: null },
    orderBy: [{ sequence: "asc" }, { created_at: "asc" }],
    include: {
      transferMovementItemLocationPutConfirms: {
        include: {
          location: {
            select: { id: true, full_name: true },
          },
        },
        orderBy: [{ created_at: "asc" }, { id: "asc" }],
      },
    },
  },
});

/**
 * =========================
 * CRUD (unchanged)
 * =========================
 */

// ✅ เพิ่ม helper นี้ (ถ้ายังไม่มีในไฟล์)
function toDateOrNull(v: any): Date | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;

  // "YYYY-MM-DD"
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00.000Z`);

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ✅ แทนที่ createTransferMovement ของคุณด้วยอันนี้
export const createTransferMovement = asyncHandler(
  async (req: Request<{}, {}, CreateTransferMovementBody>, res: Response) => {
    const body = req.body;

    const no = asNonEmpty(body.number, "number");
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0)
      throw badRequest("กรุณาส่ง items อย่างน้อย 1 รายการ");

    // ✅ multi-first + compat fallback
    const department_ids =
      Array.isArray((body as any).department_ids) &&
      (body as any).department_ids.length > 0
        ? uniqPositiveInts((body as any).department_ids, "department_ids")
        : [asInt((body as any).department_id, "department_id")];

    const user_work_ids = Array.isArray((body as any).user_work_ids)
      ? uniqPositiveIntsOptional((body as any).user_work_ids)
      : (body as any).user_work_id != null
        ? [asInt((body as any).user_work_id, "user_work_id")]
        : [];

    const creatorFromToken = getCreatorUserIdFromReq(req);
    const creator_user_id =
      creatorFromToken ??
      ((body as any).user_id != null
        ? asInt((body as any).user_id, "user_id")
        : null);

    if (!creator_user_id)
      throw badRequest("ไม่พบ user ใน token และไม่ได้ส่ง user_id", {
        field: "user_id",
      });

    const primary_department_id = department_ids[0];
    const primary_user_work_id = user_work_ids.length ? user_work_ids[0] : null;

    const exists = await prisma.transfer_movement.findUnique({ where: { no } });
    if (exists) throw badRequest("มี number นี้อยู่แล้ว");

    // ✅ validate departments/users exist (เบสิก)
    const [deptRows, uwRows] = await Promise.all([
      prisma.department.findMany({
        where: { id: { in: department_ids }, deleted_at: null },
        select: { id: true },
      }),
      user_work_ids.length
        ? prisma.user.findMany({
            where: { id: { in: user_work_ids }, deleted_at: null },
            select: { id: true },
          })
        : Promise.resolve([]),
    ]);

    if (deptRows.length !== department_ids.length)
      throw badRequest("มี department บางตัวไม่พบ หรือถูกลบ", {
        field: "department_ids",
      });

    if (user_work_ids.length && uwRows.length !== user_work_ids.length)
      throw badRequest("มี user_work บางตัวไม่พบ หรือถูกลบ", {
        field: "user_work_ids",
      });

    const created = await prisma.$transaction(async (tx) => {
      const header = await tx.transfer_movement.create({
        data: {
          no,
          status: "pick",
          user_id: creator_user_id,

          // ✅ compat fields (ยังอยู่)
          department_id: primary_department_id,
          user_work_id: primary_user_work_id,

          updated_at: new Date(),
        } as any,
      });

      // ✅ join: departments
      await tx.transfer_movement_department.createMany({
        data: department_ids.map((did) => ({
          transfer_movement_id: header.id,
          department_id: did,
        })),
        skipDuplicates: true,
      });

      // ✅ join: user_works
      if (user_work_ids.length) {
        await tx.transfer_movement_user_work.createMany({
          data: user_work_ids.map((uid) => ({
            transfer_movement_id: header.id,
            user_id: uid,
          })),
          skipDuplicates: true,
        });
      }

      // ✅ items create (ใช้ของเดิมคุณได้เลย ตรงนี้ทำตาม pattern เดิมของคุณ)
      await tx.transfer_movement_item.createMany({
        data: items.map((it: any, idx: number) => ({
          transfer_movement_id: header.id,
          sequence: idx + 1,
          product_id: it.product_id ?? null,
          code: String(it.code ?? "").trim() || null,
          name: String(it.name ?? "").trim(),
          lot_serial: String(it.lot_serial ?? "").trim() || null,
          lock_no: String(it.lock_no ?? "").trim() || null,
          lock_no_dest: String(it.lock_no_dest ?? "").trim() || null,
          unit: String(it.unit ?? "").trim(),
          exp: toDateOrNull(it.expire_date ?? it.exp ?? null),
          qty: Math.floor(Number(it.qty ?? 0)),
          status: String(it.status ?? "pick"),
          created_at: new Date(),
          updated_at: new Date(),
          deleted_at: null,
        })),
      });

      return tx.transfer_movement.findUniqueOrThrow({
        where: { id: header.id },
        include: TM_INCLUDE_FULL,
      });
    });

    // payload ที่ create ยังไม่จำเป็นต้องแนบ barcode
    return res
      .status(201)
      .json(
        formatTransferMovement(
          created as any,
          { barcodeTextMap: new Map() } as any,
        ),
      );
  },
);

export const getTransferMovements = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

    const visibilityWhere = buildTransferMovementVisibilityWhere(req);

    let where: Prisma.transfer_movementWhereInput = visibilityWhere;

    if (search) {
      where = {
        AND: [
          visibilityWhere,
          {
            OR: [
              { no: { contains: search, mode: "insensitive" } },
              { status: { contains: search, mode: "insensitive" } },

              {
                user: { first_name: { contains: search, mode: "insensitive" } },
              },
              {
                user: { last_name: { contains: search, mode: "insensitive" } },
              },
              { user: { tel: { contains: search, mode: "insensitive" } } },
              {
                user: { user_level: { contains: search, mode: "insensitive" } },
              },

              {
                department: {
                  full_name: { contains: search, mode: "insensitive" },
                },
              },
              {
                department: {
                  short_name: { contains: search, mode: "insensitive" },
                },
              },

              {
                movement_departments: {
                  some: {
                    department: {
                      OR: [
                        {
                          full_name: { contains: search, mode: "insensitive" },
                        },
                        {
                          short_name: { contains: search, mode: "insensitive" },
                        },
                      ],
                    },
                  },
                },
              },

              {
                movement_user_works: {
                  some: {
                    user: {
                      OR: [
                        {
                          first_name: { contains: search, mode: "insensitive" },
                        },
                        {
                          last_name: { contains: search, mode: "insensitive" },
                        },
                        { tel: { contains: search, mode: "insensitive" } },
                        {
                          user_level: { contains: search, mode: "insensitive" },
                        },
                      ],
                    },
                  },
                },
              },

              {
                items: {
                  some: {
                    OR: [
                      { code: { contains: search, mode: "insensitive" } },
                      { name: { contains: search, mode: "insensitive" } },
                      { lot_serial: { contains: search, mode: "insensitive" } },
                      { lock_no: { contains: search, mode: "insensitive" } },
                      {
                        lock_no_dest: { contains: search, mode: "insensitive" },
                      },
                    ],
                  },
                },
              },

              {
                items: {
                  some: {
                    transferMovementItemLocationPutConfirms: {
                      some: {
                        location: {
                          full_name: {
                            contains: search,
                            mode: "insensitive",
                          },
                        },
                      },
                    },
                  },
                },
              },
            ],
          },
        ],
      };
    }

    const rows = await prisma.transfer_movement.findMany({
      where,
      orderBy: { created_at: "desc" },
      include: TM_INCLUDE_FULL,
    });

    const allItems = rows.flatMap((r) => r.items ?? []);
    const barcodePayload = await buildBarcodePayloadFromItems(allItems);
    const userWorkMap = await buildUserWorkMapFromRows(rows);
    const inputNumberMap = await buildInputNumberMap(allItems);

    return res.json(
      rows.map((r) =>
        formatTransferMovement(
          r as any,
          {
            ...barcodePayload,
            userWorkMap,
            inputNumberMap,
          } as any,
        ),
      ),
    );
  },
);

export const getTransferMovementsPaginated = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const page = Number(req.query.page) || 1;
    const limit =
      req.query.limit !== undefined ? Number(req.query.limit) || 10 : 10;

    if (Number.isNaN(page) || page < 1) {
      throw badRequest("page ต้องเป็นตัวเลขบวกที่มีค่ามากกว่า 0");
    }

    if (Number.isNaN(limit) || limit < 1) {
      throw badRequest("limit ต้องเป็นตัวเลขบวกที่มีค่ามากกว่า 0");
    }

    const skip = (page - 1) * limit;

    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

    const rawStatus = req.query.status;
    const status =
      typeof rawStatus === "string" ? rawStatus.trim().toLowerCase() : "";

    const allowedStatuses = ["pick", "put", "completed"] as const;

    if (
      status &&
      !allowedStatuses.includes(status as (typeof allowedStatuses)[number])
    ) {
      throw badRequest("status ต้องเป็น pick, put หรือ completed");
    }

    const visibilityWhere = buildTransferMovementVisibilityWhere(req);
    const departmentWhere = buildTransferMovementDepartmentAccessWhere(req);

    const baseWhere: Prisma.transfer_movementWhereInput = {
      AND: [visibilityWhere, departmentWhere],
    };

    let whereForCount: Prisma.transfer_movementWhereInput = baseWhere;
    let where: Prisma.transfer_movementWhereInput = status
      ? {
          AND: [
            visibilityWhere,
            departmentWhere,
            {
              status,
            },
          ],
        }
      : baseWhere;

    if (search) {
      const searchCondition: Prisma.transfer_movementWhereInput = {
        OR: [
          { no: { contains: search, mode: "insensitive" } },
          { status: { contains: search, mode: "insensitive" } },

          {
            user: { first_name: { contains: search, mode: "insensitive" } },
          },
          {
            user: { last_name: { contains: search, mode: "insensitive" } },
          },
          { user: { tel: { contains: search, mode: "insensitive" } } },
          {
            user: { user_level: { contains: search, mode: "insensitive" } },
          },

          {
            department: {
              full_name: { contains: search, mode: "insensitive" },
            },
          },
          {
            department: {
              short_name: { contains: search, mode: "insensitive" },
            },
          },

          {
            movement_departments: {
              some: {
                department: {
                  OR: [
                    {
                      full_name: { contains: search, mode: "insensitive" },
                    },
                    {
                      short_name: { contains: search, mode: "insensitive" },
                    },
                  ],
                },
              },
            },
          },

          {
            movement_user_works: {
              some: {
                user: {
                  OR: [
                    {
                      first_name: { contains: search, mode: "insensitive" },
                    },
                    {
                      last_name: { contains: search, mode: "insensitive" },
                    },
                    { tel: { contains: search, mode: "insensitive" } },
                    {
                      user_level: { contains: search, mode: "insensitive" },
                    },
                  ],
                },
              },
            },
          },

          {
            items: {
              some: {
                OR: [
                  { code: { contains: search, mode: "insensitive" } },
                  { name: { contains: search, mode: "insensitive" } },
                  { lot_serial: { contains: search, mode: "insensitive" } },
                  { lock_no: { contains: search, mode: "insensitive" } },
                  {
                    lock_no_dest: { contains: search, mode: "insensitive" },
                  },
                ],
              },
            },
          },

          {
            items: {
              some: {
                transferMovementItemLocationPutConfirms: {
                  some: {
                    location: {
                      full_name: {
                        contains: search,
                        mode: "insensitive",
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      };

      whereForCount = {
        AND: [visibilityWhere, departmentWhere, searchCondition],
      };

      where = {
        AND: [
          visibilityWhere,
          departmentWhere,
          searchCondition,
          ...(status ? [{ status }] : []),
        ],
      };
    }

    const [rows, total, pickCount, putCount, completedCount] =
      await Promise.all([
        prisma.transfer_movement.findMany({
          where,
          skip,
          take: limit,
          orderBy: { created_at: "desc" },
          include: TM_INCLUDE_FULL,
        }),

        prisma.transfer_movement.count({ where }),

        prisma.transfer_movement.count({
          where: {
            AND: [whereForCount, { status: "pick" }],
          },
        }),

        prisma.transfer_movement.count({
          where: {
            AND: [whereForCount, { status: "put" }],
          },
        }),

        prisma.transfer_movement.count({
          where: {
            AND: [whereForCount, { status: "completed" }],
          },
        }),
      ]);

    const allItems = rows.flatMap((r) => r.items ?? []);
    const barcodePayload = await buildBarcodePayloadFromItems(allItems);
    const userWorkMap = await buildUserWorkMapFromRows(rows);
    const inputNumberMap = await buildInputNumberMap(allItems);

    return res.json({
      data: rows.map((r) =>
        formatTransferMovement(
          r as any,
          {
            ...barcodePayload,
            inputNumberMap,
            userWorkMap,
          } as any,
        ),
      ),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        statusCounts: {
          pick: pickCount,
          put: putCount,
          completed: completedCount,
        },
      },
    });
  },
);

export const getTransferMovementById = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const id = pickIdParam(req);

    const row = await prisma.transfer_movement.findUnique({
      where: { id },
      include: TM_INCLUDE_FULL,
    });

    if (!row) throw notFound("ไม่พบ transfer_movement");

    const barcodePayload = await buildBarcodePayloadFromItems(row.items ?? []);
    const userWorkMap = await buildUserWorkMapFromRows(row);
    const inputNumberMap = await buildInputNumberMap(row.items ?? []);

    return res.json(
      formatTransferMovement(
        row as any,
        {
          ...barcodePayload,
          inputNumberMap,
          userWorkMap,
        } as any,
      ),
    );
  },
);

export const getTransferMovementByNo = asyncHandler(
  async (req: Request<{ no: string }>, res: Response) => {
    const rawNo = Array.isArray(req.params.no)
      ? req.params.no[0]
      : req.params.no;

    const no = decodeURIComponent(String(rawNo ?? "").trim());
    if (!no) throw badRequest("กรุณาระบุ no");

    const row = await prisma.transfer_movement.findUnique({
      where: { no },
      include: TM_INCLUDE_FULL,
    });

    if (!row) throw notFound(`ไม่พบ transfer_movement: ${no}`);

    const barcodePayload = await buildBarcodePayloadFromItems(row.items ?? []);
    const userWorkMap = await buildUserWorkMapFromRows(row);
    const inputNumberMap = await buildInputNumberMap(row.items ?? []);

    return res.json(
      formatTransferMovement(
        row as any,
        {
          ...barcodePayload,
          inputNumberMap,
          userWorkMap,
        } as any,
      ),
    );
  },
);

export const updateTransferMovement = asyncHandler(
  async (
    req: Request<{ id: string }, {}, UpdateTransferMovementBody>,
    res: Response,
  ) => {
    const id = pickIdParam(req);

    // =========================
    // ✅ Parse multi-first + compat
    // =========================
    const hasDeptIds = Array.isArray((req.body as any)?.department_ids);
    const hasDeptId = (req.body as any)?.department_id !== undefined;

    const department_ids = hasDeptIds
      ? uniqPositiveInts((req.body as any).department_ids, "department_ids")
      : hasDeptId
        ? [asInt((req.body as any).department_id, "department_id")]
        : null;

    const hasUwIds = Array.isArray((req.body as any)?.user_work_ids);
    const hasUwId = (req.body as any)?.user_work_id !== undefined;

    const user_work_ids = hasUwIds
      ? uniqPositiveIntsOptional((req.body as any).user_work_ids)
      : hasUwId
        ? (req.body as any).user_work_id == null
          ? [] // เคลียร์
          : [asInt((req.body as any).user_work_id, "user_work_id")]
        : null;

    // =========================
    // existence check
    // =========================
    const existing = await prisma.transfer_movement.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw notFound("ไม่พบ transfer_movement");

    const data = req.body;

    const updateData: Prisma.transfer_movementUpdateInput = {
      updated_at: new Date(),
    };

    // =========================
    // Header update (ของเดิม)
    // =========================
    if (data.number !== undefined)
      updateData.no = asNonEmpty(data.number, "number");
    if (data.status !== undefined) updateData.status = data.status;

    // ✅ เปลี่ยน creator (เดิม)
    if (data.user_id !== undefined) {
      const user_id = asInt(data.user_id, "user_id");
      const u = await prisma.user.findUnique({
        where: { id: user_id },
        select: { id: true, deleted_at: true },
      });
      if (!u) throw badRequest("ไม่พบ user", { field: "user_id" });
      if (u.deleted_at)
        throw badRequest("user ถูกลบไปแล้ว", { field: "user_id" });
      updateData.user = { connect: { id: user_id } };
    }

    // ✅ (เดิม) ถ้าส่ง department_id เดี่ยวมา — ยังรองรับ
    // NOTE: ถ้าส่ง department_ids มาด้วย เราจะ set primary จาก department_ids ใน transaction ด้านล่าง
    if (data.department_id !== undefined && department_ids === null) {
      const department_id = asInt(data.department_id, "department_id");
      const d = await prisma.department.findUnique({
        where: { id: department_id },
        select: { id: true, deleted_at: true },
      });
      if (!d) throw badRequest("ไม่พบ department", { field: "department_id" });
      if (d.deleted_at)
        throw badRequest("department ถูกลบไปแล้ว", { field: "department_id" });
      updateData.department = { connect: { id: department_id } };
    }

    // =========================
    // ✅ Items replace
    // =========================
    const hasItems = Array.isArray((data as any)?.items);

    const include = {
      user: true,
      department: true, // primary (compat)
      items: true,
      movement_departments: { include: { department: true } },
      movement_user_works: { include: { user: true } },
    } as const;

    const updated = await prisma.$transaction(async (tx) => {
      // 1) update header
      await tx.transfer_movement.update({
        where: { id },
        data: updateData,
      });

      // =========================
      // 1.5) ✅ replace departments join (ถ้ามีส่งมา)
      // =========================
      if (department_ids) {
        // validate departments exist
        const deptRows = await tx.department.findMany({
          where: { id: { in: department_ids }, deleted_at: null },
          select: { id: true },
        });
        if (deptRows.length !== department_ids.length)
          throw badRequest("มี department บางตัวไม่พบ หรือถูกลบ", {
            field: "department_ids",
          });

        // set primary compat
        await tx.transfer_movement.update({
          where: { id },
          data: {
            department_id: department_ids[0],
            updated_at: new Date(),
          } as any,
        });

        await tx.transfer_movement_department.deleteMany({
          where: { transfer_movement_id: id },
        });

        await tx.transfer_movement_department.createMany({
          data: department_ids.map((did) => ({
            transfer_movement_id: id,
            department_id: did,
          })),
          skipDuplicates: true,
        });
      }

      // =========================
      // 1.6) ✅ replace user_work join (ถ้ามีส่งมา)
      // =========================
      if (user_work_ids !== null) {
        // validate users exist (only if ids not empty)
        if (user_work_ids.length > 0) {
          const uwRows = await tx.user.findMany({
            where: { id: { in: user_work_ids }, deleted_at: null },
            select: { id: true },
          });
          if (uwRows.length !== user_work_ids.length)
            throw badRequest("มี user_work บางตัวไม่พบ หรือถูกลบ", {
              field: "user_work_ids",
            });
        }

        const primaryUw = user_work_ids.length ? user_work_ids[0] : null;

        // set primary compat
        await tx.transfer_movement.update({
          where: { id },
          data: {
            user_work_id: primaryUw,
            updated_at: new Date(),
          } as any,
        });

        await tx.transfer_movement_user_work.deleteMany({
          where: { transfer_movement_id: id },
        });

        if (user_work_ids.length > 0) {
          await tx.transfer_movement_user_work.createMany({
            data: user_work_ids.map((uid) => ({
              transfer_movement_id: id,
              user_id: uid,
            })),
            skipDuplicates: true,
          });
        }
      }

      // =========================
      // 2) replace items ถ้ามีส่งมา
      // =========================
      if (hasItems) {
        const items = (data as any).items as Array<any>;

        for (let i = 0; i < items.length; i++) {
          const it = items[i] ?? {};
          const idx = i + 1;

          const code = String(it.code ?? "").trim();
          if (!code)
            throw badRequest(`items[${idx}] code ห้ามว่าง`, {
              field: "items.code",
            });

          const name = String(it.name ?? "").trim();
          if (!name)
            throw badRequest(`items[${idx}] name ห้ามว่าง`, {
              field: "items.name",
            });

          const unit = String(it.unit ?? "").trim();
          if (!unit)
            throw badRequest(`items[${idx}] unit ห้ามว่าง`, {
              field: "items.unit",
            });

          const lock_no = String(it.lock_no ?? "").trim();
          if (!lock_no)
            throw badRequest(`items[${idx}] lock_no ห้ามว่าง`, {
              field: "items.lock_no",
            });

          const qtyNum = Number(it.qty);
          if (!Number.isFinite(qtyNum) || qtyNum <= 0)
            throw badRequest(`items[${idx}] qty ต้องมากกว่า 0`, {
              field: "items.qty",
            });
        }

        // hard delete old
        await tx.transfer_movement_item.deleteMany({
          where: { transfer_movement_id: id },
        });

        // create new
        if (items.length > 0) {
          await tx.transfer_movement_item.createMany({
            data: items.map((it: any, index: number) => ({
              transfer_movement_id: id,
              sequence: it.sequence ?? index + 1,
              product_id:
                it.product_id === undefined || it.product_id === null
                  ? null
                  : Number(it.product_id),

              code: String(it.code ?? "").trim(),
              name: String(it.name ?? "").trim(),

              lock_no: String(it.lock_no ?? "").trim() || null,
              lock_no_dest:
                it.lock_no_dest === undefined
                  ? null
                  : String(it.lock_no_dest ?? "").trim() || null,

              lot_serial:
                it.lot_serial === undefined
                  ? null
                  : String(it.lot_serial ?? "").trim() || null,

              unit: String(it.unit ?? "").trim(),

              exp:
                it.exp === undefined || it.exp === null || it.exp === ""
                  ? null
                  : new Date(it.exp),

              qty: Math.floor(Number(it.qty)),
              status: it.status ?? "pick",

              created_at: new Date(),
              updated_at: new Date(),
              deleted_at: null,
            })),
          });
        }
      }

      // 3) fetch back with NEW includes
      return tx.transfer_movement.findUniqueOrThrow({
        where: { id },
        include: TM_INCLUDE_FULL,
      });
    });

    // ✅ แนบ barcode payload สำหรับ response ให้ครบ (กัน FE งง)
    const allItems = (updated as any).items ?? [];
    const barcodePayload = await buildBarcodePayloadFromItems(allItems);
    const userWorkMap = await buildUserWorkMapFromRows(updated as any);
    const inputNumberMap = await buildInputNumberMap(allItems);

    return res.json(
      formatTransferMovement(
        updated as any,
        {
          ...barcodePayload,
          inputNumberMap,
          userWorkMap,
        } as any,
      ),
    );
  },
);

export const deleteTransferMovement = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const id = pickIdParam(req);

    const existing = await prisma.transfer_movement.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw notFound("ไม่พบ transfer_movement");

    await prisma.$transaction(async (tx) => {
      await tx.transfer_movement_item.deleteMany({
        where: { transfer_movement_id: id },
      });
      await tx.transfer_movement.delete({ where: { id } });
    });

    return res.status(200).json({ message: "ลบข้อมูลเรียบร้อยแล้ว" });
  },
);

function formatYYMMDD(d: Date | null | undefined): string {
  if (!d) return "999999";
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

function buildMovementBarcodePayload(input: {
  barcode: string | null | undefined;
  lot_serial: string | null | undefined;
  exp: Date | null | undefined;
}) {
  const barcode = String(input.barcode ?? "")
    .trim()
    .replace(/\s+/g, "");

  if (!barcode) return "";

  const lotPart = input.lot_serial
    ? String(input.lot_serial).trim().replace(/\s+/g, "")
    : "XXXXXX";

  const expPart = formatYYMMDD(input.exp);

  return `${barcode}${lotPart}${expPart}`;
}

async function buildMovementPutSummaryTx(
  tx: Prisma.TransactionClient,
  itemId: string,
) {
  const rows = await tx.transfer_movement_item_location_put_confirm.findMany({
    where: { transfer_movement_item_id: itemId },
    include: {
      location: {
        select: { id: true, full_name: true },
      },
    },
    orderBy: [{ created_at: "asc" }, { id: "asc" }],
  });

  const locations = rows
    .map((r) => {
      const qty = Math.max(0, Math.floor(Number(r.confirmed_put ?? 0)));
      if (qty <= 0) return null;

      return {
        id: r.id,
        location_id: r.location_id,
        location_name: r.location?.full_name ?? null,
        confirmed_put: qty,
      };
    })
    .filter(Boolean) as Array<{
    id: number;
    location_id: number;
    location_name: string | null;
    confirmed_put: number;
  }>;

  const totalPut = locations.reduce(
    (sum, r) => sum + Number(r.confirmed_put ?? 0),
    0,
  );

  const summary = locations
    .map((r) => `${r.location_name} (${r.confirmed_put})`)
    .join(", ");

  return {
    locations,
    totalPut,
    summary: summary || null,
  };
}
/**
 * =========================
 * Scan / Confirm (Flow เดิม) ✅ unchanged logic
 * =========================
 */

function normalizeMovementLocationNamesFromBody(body: any): string[] {
  const names: string[] = [];

  const single = String(body?.location_full_name ?? "").trim();
  if (single) names.push(single);

  if (Array.isArray(body?.locations)) {
    for (const loc of body.locations) {
      const name = String(loc?.location_full_name ?? "").trim();
      if (name) names.push(name);
    }
  }

  return Array.from(new Set(names));
}

async function resolveMovementLocationsByFullNames(fullNames: string[]) {
  const normalized = Array.from(
    new Set(fullNames.map((x) => String(x ?? "").trim()).filter(Boolean)),
  );

  if (normalized.length === 0) {
    throw badRequest(
      "กรุณาส่ง location_full_name หรือ locations[].location_full_name",
    );
  }

  const rows = await prisma.location.findMany({
    where: {
      deleted_at: null,
      full_name: { in: normalized },
    },
    select: {
      id: true,
      full_name: true,
      ncr_check: true,
    },
  });

  const byName = new Map(rows.map((x) => [x.full_name, x]));

  for (const name of normalized) {
    if (!byName.has(name)) {
      throw badRequest(`ไม่พบ location full_name: ${name}`);
    }
  }

  return normalized.map((name) => byName.get(name)!);
}

async function seedTransferMovementLocationDraftRowsTx(
  tx: Prisma.TransactionClient,
  input: {
    transfer_movement_id: number;
    location_ids: number[];
  },
) {
  const itemRows = await tx.transfer_movement_item.findMany({
    where: {
      transfer_movement_id: input.transfer_movement_id,
      deleted_at: null,
    },
    select: {
      id: true,
    },
  });

  if (itemRows.length === 0 || input.location_ids.length === 0) return;

  for (const item of itemRows) {
    for (const location_id of input.location_ids) {
      await tx.transfer_movement_item_location_pick_confirm.upsert({
        where: {
          uniq_mm_pick_location: {
            transfer_movement_item_id: item.id,
            location_id,
          },
        },
        update: {},
        create: {
          transfer_movement_item_id: item.id,
          location_id,
          confirmed_pick: 0,
        },
      });

      await tx.transfer_movement_item_location_put_confirm.upsert({
        where: {
          uniq_mm_put_location: {
            transfer_movement_item_id: item.id,
            location_id,
          },
        },
        update: {},
        create: {
          transfer_movement_item_id: item.id,
          location_id,
          confirmed_put: 0,
        },
      });
    }
  }
}

// POST /api/transfer_movements/:no/scan/location
export const scanTransferMovementLocation = asyncHandler(
  async (req: Request, res: Response) => {
    const no = decodeURIComponent(String(req.params.no ?? "").trim());
    if (!no) throw badRequest("Invalid no");

    const doc = await prisma.transfer_movement.findUnique({
      where: { no },
      include: {
        items: {
          where: { deleted_at: null },
        },
      },
    });

    if (!doc || doc.deleted_at) {
      throw badRequest(`ไม่พบ transfer_movement: ${no}`);
    }

    const requestedNames = normalizeMovementLocationNamesFromBody(req.body);
    const locations = await resolveMovementLocationsByFullNames(requestedNames);

    const validLocations = locations.filter((loc) =>
      doc.items.some(
        (it) =>
          !it.deleted_at &&
          (it.lock_no === loc.full_name || it.lock_no_dest === loc.full_name),
      ),
    );

    if (validLocations.length === 0) {
      throw badRequest(
        `ไม่พบรายการในเอกสาร ${no} ที่ตรงกับ location ที่ส่งมา`,
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.transfer_movement.update({
        where: { id: doc.id },
        data: { updated_at: new Date() } as any,
      });
    });

    const payload = {
      transfer_movement_no: no,
      mode: "pick",
      location: {
        location_id: validLocations[0].id,
        location_name: validLocations[0].full_name,
        ncr_check: validLocations[0].ncr_check,
      },
      locations: validLocations.map((loc) => ({
        location_id: loc.id,
        location_name: loc.full_name,
        ncr_check: loc.ncr_check,
      })),
    };

    io.to(`tm:${no}`).emit("tm:scan_location", payload);

    return res.json(payload);
  },
);



// POST /api/transfer_movements/:no/scan/location/put
export const scanTransferMovementPutLocation = asyncHandler(
  async (req: Request, res: Response) => {
    const no = decodeURIComponent(String(req.params.no ?? "").trim());
    if (!no) throw badRequest("Invalid no");

    const doc = await prisma.transfer_movement.findUnique({
      where: { no },
      select: { id: true, no: true, deleted_at: true },
    });

    if (!doc || doc.deleted_at) {
      throw badRequest(`ไม่พบ transfer_movement: ${no}`);
    }

    const requestedNames = normalizeMovementLocationNamesFromBody(req.body);
    const locations = await resolveMovementLocationsByFullNames(requestedNames);

    await prisma.$transaction(async (tx) => {
      await tx.transfer_movement.update({
        where: { id: doc.id },
        data: { updated_at: new Date() } as any,
      });
    });

    const payload = {
      transfer_movement_no: no,
      mode: "put",
      location: {
        location_id: locations[0].id,
        location_name: locations[0].full_name,
        ncr_check: locations[0].ncr_check,
      },
      locations: locations.map((loc) => ({
        location_id: loc.id,
        location_name: loc.full_name,
        ncr_check: loc.ncr_check,
      })),
    };

    io.to(`tm:${no}`).emit("tm:scan_put_location", payload);

    return res.json(payload);
  },
);

// POST /api/transfer_movements/:no/scan/location/ncr
export const scanTransferMovementNcrLocation = asyncHandler(
  async (
    req: Request<{ no: string }, {}, { location_full_name: string }>,
    res: Response,
  ) => {
    const no = decodeURIComponent(String(req.params.no ?? "").trim());
    const location_full_name = asNonEmpty(
      req.body.location_full_name,
      "location_full_name",
    );

    const doc = await prisma.transfer_movement.findUnique({
      where: { no },
      include: {
        user: true,
        department: true,
        movement_departments: { include: { department: true } },
        movement_user_works: { include: { user: true } },
        items: {
          where: { deleted_at: null },
          orderBy: { sequence: "asc" },
          include: {
            transferMovementItemLocationPutConfirms: {
              include: {
                location: {
                  select: { id: true, full_name: true },
                },
              },
              orderBy: [{ created_at: "asc" }, { id: "asc" }],
            },
          },
        },
      },
    });

    if (!doc) throw notFound(`ไม่พบ transfer_movement: ${no}`);

    const loc = await resolveLocationByFullName(location_full_name);
    if (!loc.ncr_check) {
      throw badRequest(
        `Location นี้ไม่ใช่ NCR (ncr_check=false) ไม่อนุญาตให้สแกน: ${loc.full_name}`,
      );
    }

    const payload = await buildBarcodePayloadFromItems(doc.items ?? []);
    const inputNumberMap = await buildInputNumberMap(doc.items ?? []);
    const userWorkMap = await buildUserWorkMapFromRows(doc as any);

    return res.json({
      transfer_movement_no: doc.no,
      location: {
        location_id: loc.id,
        location_name: loc.full_name,
        ncr_check: loc.ncr_check,
      },
      ...formatTransferMovement(
        doc as any,
        {
          ...payload,
          inputNumberMap,
          userWorkMap,
        } as any,
      ),
    });
  },
);


// POST /api/transfer_movements/:no/scan/barcode
export const scanTransferMovementBarcode = asyncHandler(
  async (
    req: Request<{ no: string }, {}, ScanMovementBarcodeBody>,
    res: Response,
  ) => {
    const no = decodeURIComponent(String(req.params.no ?? "").trim());
    const barcode = asNonEmpty(req.body.barcode, "barcode");
    const location_full_name = asNonEmpty(
      req.body.location_full_name,
      "location_full_name",
    );

    const mode = ((req.body as any).mode ?? "inc") as
      | "inc"
      | "set"
      | "dec"
      | "clear";

    const valueRaw = (req.body as any).value;

    const doc = await prisma.transfer_movement.findUnique({
      where: { no },
      include: { items: true },
    });

    if (!doc) throw notFound(`ไม่พบ transfer_movement: ${no}`);

    const loc = await resolveLocationByFullName(location_full_name);

    const parsed = await resolveBarcodeScan(barcode);

    const { barcodeTextMap } = await buildBarcodePayloadFromItems(
      doc.items ?? [],
    );

    const parsedBarcodeBase = normalizeBarcodeBaseForMatch(
      parsed.barcode_text ?? "",
    );

    const item =
      doc.items.find((it) => {
        if (it.deleted_at) return false;
        if (!it.product_id) return false;

        const key = movementGoodsKey(it.product_id, it.lot_serial);
        const barcode_text = barcodeTextMap.get(key);
        if (!barcode_text) return false;

        const itemBarcodeBase = normalizeBarcodeBaseForMatch(barcode_text);
        if (!itemBarcodeBase || itemBarcodeBase !== parsedBarcodeBase) {
          return false;
        }

        const lotMatched =
          normalizeScanText(it.lot_serial ?? "") ===
          normalizeScanText(parsed.lot_serial ?? "");

        const itemExpKey = it.exp
          ? new Date(it.exp).toISOString().slice(0, 10)
          : null;
        const parsedExpKey = parsed.exp
          ? new Date(parsed.exp).toISOString().slice(0, 10)
          : null;

        const expMatched = itemExpKey === parsedExpKey;

        return lotMatched && expMatched;
      }) ?? null;

    if (!item) {
      throw badRequest(`ไม่พบ item ที่ตรงกับ barcode/serial นี้ในใบ: ${no}`);
    }

    const row = await prisma.$transaction(async (tx) => {
      const freshItem = await tx.transfer_movement_item.findUnique({
        where: { id: item.id },
        select: {
          id: true,
          sequence: true,
          product_id: true,
          code: true,
          name: true,
          lot_serial: true,
          lock_no: true,
          lock_no_dest: true,
          unit: true,
          exp: true,
          qty: true,
          qty_pick: true,
          qty_put: true,
          status: true,
          deleted_at: true,
        },
      });

      if (!freshItem || freshItem.deleted_at) {
        throw badRequest("ไม่พบ item ที่ต้องการอัปเดต");
      }

      const liveStatus = (freshItem.status ?? "pick") as
        | "pick"
        | "put"
        | "completed";

      if (liveStatus === "completed") {
        throw badRequest("รายการนี้ completed แล้ว ไม่สามารถสแกนเพิ่มได้");
      }

      const maxQty =
        freshItem.qty != null
          ? Math.max(0, Math.floor(Number(freshItem.qty)))
          : 0;

      if (maxQty <= 0) {
        throw badRequest("รายการนี้ไม่มี qty ที่อนุญาตให้สแกน");
      }

      const calcNext = (current: number) => {
        let next = current;

        if (mode === "inc") {
          next = current + 1;
        } else if (mode === "dec") {
          const dec = valueRaw != null ? asPositiveInt(valueRaw, "value") : 1;
          next = current - dec;
        } else if (mode === "set") {
          next = asNonNegativeInt(valueRaw, "value");
        } else if (mode === "clear") {
          next = 0;
        }

        if (next < 0) next = 0;
        if (next > maxQty) {
          throw badRequest(`สแกนเกินจำนวนในใบไม่ได้ (qty=${maxQty})`);
        }

        return next;
      };

      if (liveStatus !== "put") {
  const currentPick = Math.max(
    0,
    Math.floor(Number(freshItem.qty_pick ?? 0)),
  );

  const nextPick = calcNext(currentPick);
  const deltaPick = nextPick - currentPick;

  const updatedItem = await tx.transfer_movement_item.update({
    where: { id: freshItem.id },
    data: {
      qty_pick: nextPick,
      updated_at: new Date(),
    },
  });

  if (deltaPick !== 0) {
    const existingPick =
      await tx.transfer_movement_item_location_pick_confirm.upsert({
        where: {
          uniq_mm_pick_location: {
            transfer_movement_item_id: freshItem.id,
            location_id: loc.id,
          },
        },
        create: {
          transfer_movement_item_id: freshItem.id,
          location_id: loc.id,
          confirmed_pick: 0,
        },
        update: {},
      });

    const currentPickAtLoc = Math.max(
      0,
      Math.floor(Number(existingPick.confirmed_pick ?? 0)),
    );

    const nextPickAtLoc = Math.max(0, currentPickAtLoc + deltaPick);

    await tx.transfer_movement_item_location_pick_confirm.update({
      where: { id: existingPick.id },
      data: {
        confirmed_pick: nextPickAtLoc,
        updated_at: new Date(),
      },
    });
  }

  return {
    stage: "pick" as const,
    updatedItem,
    confirmedAtLocation: null as number | null,
    putLocations: [] as any[],
    totalPut: null as number | null,
  };
}

      const existing =
        await tx.transfer_movement_item_location_put_confirm.upsert({
          where: {
            uniq_mm_put_location: {
              transfer_movement_item_id: freshItem.id,
              location_id: loc.id,
            },
          },
          create: {
            transfer_movement_item_id: freshItem.id,
            location_id: loc.id,
            confirmed_put: 0,
          },
          update: {},
        });

      const currentPutAtLoc = Math.max(
        0,
        Math.floor(Number(existing.confirmed_put ?? 0)),
      );
      const nextPutAtLoc = calcNext(currentPutAtLoc);

      const otherAgg =
        await tx.transfer_movement_item_location_put_confirm.aggregate({
          where: {
            transfer_movement_item_id: freshItem.id,
            id: { not: existing.id },
          },
          _sum: { confirmed_put: true },
        });

      const otherTotal = Math.max(
        0,
        Math.floor(Number(otherAgg._sum.confirmed_put ?? 0)),
      );

      const totalPutAfterThisScan = otherTotal + nextPutAtLoc;

      if (totalPutAfterThisScan > maxQty) {
        throw badRequest(
          `สแกนเกินจำนวนในใบไม่ได้ (qty=${maxQty}, put รวม=${totalPutAfterThisScan})`,
        );
      }

      await tx.transfer_movement_item_location_put_confirm.update({
        where: { id: existing.id },
        data: { confirmed_put: nextPutAtLoc },
      });

      const putSummary = await buildMovementPutSummaryTx(tx, freshItem.id);

      const updatedItem = await tx.transfer_movement_item.update({
        where: { id: freshItem.id },
        data: {
          qty_put: putSummary.totalPut,
          lock_no_dest: putSummary.summary,
          status: "put",
          updated_at: new Date(),
        },
      });

      return {
        stage: "put" as const,
        updatedItem,
        confirmedAtLocation: nextPutAtLoc,
        putLocations: putSummary.locations,
        totalPut: putSummary.totalPut,
      };
    });

    const payload = {
      transfer_movement_no: no,
      location: { location_id: loc.id, location_name: loc.full_name },
      scanned: {
        barcode: parsed.raw_input,
        normalized_input: parsed.normalized_input,
        barcode_text: parsed.barcode_text,
        lot_serial: parsed.lot_serial,
        exp: parsed.exp ? parsed.exp.toISOString() : null,
        matched_by: parsed.matched_by,
      },
      matched_item: {
        id: row.updatedItem.id,
        sequence: row.updatedItem.sequence,
        product_id: row.updatedItem.product_id,
        code: row.updatedItem.code,
        name: row.updatedItem.name,
        lot_serial: row.updatedItem.lot_serial,
        lock_no: row.updatedItem.lock_no,
        lock_no_dest: row.updatedItem.lock_no_dest,
        unit: row.updatedItem.unit,
        exp: row.updatedItem.exp,
        qty: row.updatedItem.qty,
        status: row.updatedItem.status ?? "pick",
        qty_pick: row.updatedItem.qty_pick ?? 0,
        qty_put: row.updatedItem.qty_put ?? 0,
        lock_no_dest_list: row.putLocations,
      },
      scan_state: {
        mode,
        stage: row.stage,
        confirmed_put_at_location: row.confirmedAtLocation,
        confirmed_put_total: row.totalPut,
      },
    };

    io.to(`tm:${no}`).emit("tm:scan_barcode", payload);
    return res.json(payload);
  },
);

function asNonNegativeInt(v: unknown, name: string) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw badRequest(`${name} ต้องเป็นตัวเลข`);
  const i = Math.floor(n);
  if (i < 0) throw badRequest(`${name} ต้อง >= 0`);
  return i;
}

type ResolvedMovementLot = {
  lot_id: number | null;
  lot_name: string | null;
  expiration_date: Date | null;
};

function toSafeDateOrNull(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  return null;
}

async function resolveMovementLotFromWmsTx(
  tx: Prisma.TransactionClient,
  args: {
    product_id: number;
    lot_serial?: string | null;
    exp?: Date | string | null;
  },
): Promise<ResolvedMovementLot> {
  const lotName = String(args.lot_serial ?? "").trim();
  const expDate = toSafeDateOrNull(args.exp);
  const expKey = expDate ? expDate.toISOString().slice(0, 10) : null;

  const rows = await tx.wms_mdt_goods.findMany({
    where: {
      product_id: args.product_id,
      ...(lotName ? { lot_name: lotName } : {}),
    } as any,
    select: {
      lot_id: true,
      lot_name: true,
      expiration_date: true,
    } as any,
    orderBy: { id: "desc" },
  });

  const matched =
    rows.find((r: any) => {
      if (!expKey) return true;

      const rowExp = toSafeDateOrNull(r.expiration_date);
      const rowExpKey = rowExp ? rowExp.toISOString().slice(0, 10) : null;

      return rowExpKey === expKey;
    }) ??
    rows[0] ??
    null;

  return {
    lot_id:
      matched?.lot_id != null && Number.isFinite(Number(matched.lot_id))
        ? Number(matched.lot_id)
        : null,
    lot_name: matched?.lot_name != null
      ? String(matched.lot_name)
      : lotName || null,
    expiration_date:
      toSafeDateOrNull(matched?.expiration_date) ?? expDate ?? null,
  };
}

type ConfirmPickInput = {
  transfer_movement_id: number;
  user_id: number;
  locations: {
    location_id: number;
    lines: {
      transfer_movement_item_id: string;
      quantity_pick: number;
    }[];
  }[];
};

// POST /api/transfer_movements/:no/confirm/pick
export const confirmTransferMovementPick = asyncHandler(
  async (
    req: Request<{ no: string }, {}, ConfirmMovementPickBody>,
    res: Response,
  ) => {
    const no = decodeURIComponent(String(req.params.no ?? "").trim());

    const doc = await prisma.transfer_movement.findUnique({
      where: { no },
      include: {
        items: {
          where: { deleted_at: null },
        },
      },
    });

    if (!doc || doc.deleted_at) {
      throw notFound(`ไม่พบ transfer_movement: ${no}`);
    }

    const result = await prisma.$transaction(async (tx) => {
      const pickRows =
        await tx.transfer_movement_item_location_pick_confirm.findMany({
          where: {
            confirmed_pick: { gt: 0 },
            transfer_movement_item: {
              transfer_movement_id: doc.id,
              deleted_at: null,
              OR: [{ status: null }, { status: "pick" }],
            },
          },
          include: {
            location: {
              select: {
                id: true,
                full_name: true,
              },
            },
            transfer_movement_item: true,
          },
          orderBy: [{ location_id: "asc" }, { id: "asc" }],
        });

      if (pickRows.length === 0) {
        throw badRequest("ไม่พบรายการที่ scan pick ไว้สำหรับ confirm");
      }

      let decrementedStock = 0;
      let confirmedRows = 0;
      let skipped = 0;

      for (const row of pickRows) {
        const item = row.transfer_movement_item;
        const loc = row.location;

        if (!item || item.deleted_at || !loc) {
          skipped++;
          continue;
        }

        if (!item.product_id) {
          skipped++;
          continue;
        }

        const confirmQty = Math.max(
          0,
          Math.floor(Number(row.confirmed_pick ?? 0)),
        );

        if (confirmQty <= 0) {
          skipped++;
          continue;
        }

        const resolvedLot = await resolveMovementLotFromWmsTx(tx, {
          product_id: item.product_id,
          lot_serial: item.lot_serial ?? null,
          exp: item.exp ?? null,
        });

        const stockExp = resolvedLot.expiration_date;

        let stock = await tx.stock.findFirst({
          where: {
            source: "wms",
            product_id: item.product_id,
            location_id: loc.id,
            lot_id: resolvedLot.lot_id ?? null,
            lot_name: resolvedLot.lot_name ?? null,
            expiration_date: stockExp,
          } as any,
          select: {
            id: true,
            quantity: true,
            expiration_date: true,
          },
          orderBy: { id: "desc" },
        });

        if (!stock) {
          stock = await tx.stock.findFirst({
            where: {
              source: "wms",
              product_id: item.product_id,
              location_id: loc.id,
              lot_name: resolvedLot.lot_name ?? item.lot_serial ?? null,
            } as any,
            select: {
              id: true,
              quantity: true,
              expiration_date: true,
            },
            orderBy: { id: "desc" },
          });
        }

        if (!stock) {
          throw badRequest(
            `ไม่พบ stock สำหรับตัดออก (location=${loc.full_name}, product_id=${item.product_id}, lot=${resolvedLot.lot_name ?? item.lot_serial ?? "-"}, exp=${stockExp ? stockExp.toISOString().slice(0, 10) : "-"})`,
          );
        }

        const stockQty = Number(stock.quantity ?? 0);

        if (stockQty < confirmQty) {
          throw badRequest(
            `stock ไม่พอ (location=${loc.full_name}, product_id=${item.product_id}, lot=${resolvedLot.lot_name ?? item.lot_serial ?? "-"}, need=${confirmQty}, have=${stockQty})`,
          );
        }

        await tx.stock.update({
          where: { id: stock.id },
          data: {
            quantity: {
              decrement: new Prisma.Decimal(confirmQty),
            },
            updated_at: new Date(),
          } as any,
        });

        decrementedStock += confirmQty;
        confirmedRows++;
      }

      const changed = await tx.transfer_movement_item.updateMany({
        where: {
          transfer_movement_id: doc.id,
          deleted_at: null,
          OR: [{ status: null }, { status: "pick" }],
        },
        data: {
          status: "put",
          updated_at: new Date(),
        },
      });

      await tx.transfer_movement.update({
        where: { id: doc.id },
        data: {
          status: "put",
          updated_at: new Date(),
        } as any,
      });

      return {
        changed_items: changed.count,
        confirmed_rows: confirmedRows,
        decremented_stock: decrementedStock,
        skipped,
      };
    });

    return res.json({
      message: "confirmPick สำเร็จ: ตัด stock ตาม location ที่ scan จริงแล้ว",
      transfer_movement_no: no,
      ...result,
    });
  },
);

// POST /api/transfer_movements/:no/confirm/put
export const confirmTransferMovementPut = asyncHandler(
  async (
    req: Request<{ no: string }, {}, ConfirmMovementPutBody>,
    res: Response,
  ) => {
    const no = decodeURIComponent(String(req.params.no ?? "").trim());

    const doc = await prisma.transfer_movement.findUnique({
      where: { no },
      include: {
        items: {
          where: { deleted_at: null },
        },
        user: { select: { id: true, pin: true } },
      },
    });

    if (!doc || doc.deleted_at) {
      throw notFound(`ไม่พบ transfer_movement: ${no}`);
    }

    const pin = asPin((req.body as any)?.pin);
    const expectedPin = String(doc.user?.pin ?? "").trim();

    if (!expectedPin) throw badRequest("ผู้สร้างใบยังไม่ได้ตั้ง PIN");
    if (pin !== expectedPin) throw badRequest("PIN ไม่ถูกต้อง");

    const result = await prisma.$transaction(async (tx) => {
      // ✅ ดึงทุก location ที่มี confirmed_put จริง
      let targetRows =
        await tx.transfer_movement_item_location_put_confirm.findMany({
          where: {
            confirmed_put: { gt: 0 },
            transfer_movement_item: {
              transfer_movement_id: doc.id,
              deleted_at: null,
            },
          },
          include: {
            location: {
              select: {
                id: true,
                full_name: true,
              },
            },
            transfer_movement_item: true,
          },
          orderBy: [{ location_id: "asc" }, { id: "asc" }],
        });

      if (targetRows.length === 0) {
        throw badRequest("ไม่พบรายการที่สแกน put ไว้สำหรับ confirm");
      }

      let stockUpserted = 0;
      let updatedItems = 0;
      let skipped = 0;

      for (const row of targetRows) {
        const it = row.transfer_movement_item;
        const targetLoc = row.location;

        if (!it || it.deleted_at || !targetLoc) {
          skipped++;
          continue;
        }

        const st = (it.status ?? "pick") as
          | "pick"
          | "put"
          | "completed";

        if (st === "completed") {
          skipped++;
          continue;
        }

        if (st !== "put") {
          skipped++;
          continue;
        }

        if (!it.product_id) {
          skipped++;
          continue;
        }

        const putQty = Math.max(
          0,
          Math.floor(Number(row.confirmed_put ?? 0)),
        );

        if (putQty <= 0) {
          skipped++;
          continue;
        }

        // ✅ resolve lot_id จาก wms
        const resolvedLot = await resolveMovementLotFromWmsTx(tx, {
          product_id: it.product_id,
          lot_serial: it.lot_serial ?? null,
          exp: it.exp ?? null,
        });

        const stockExp = resolvedLot.expiration_date;

        // ✅ หา stock เดิม
        let existingStock = await tx.stock.findFirst({
          where: {
            source: "wms",
            product_id: it.product_id,
            location_id: targetLoc.id,
            lot_id: resolvedLot.lot_id ?? null,
            lot_name: resolvedLot.lot_name ?? null,
            expiration_date: stockExp,
          } as any,
          select: {
            id: true,
            quantity: true,
          },
          orderBy: { id: "desc" },
        });

        // fallback เผื่อ lot_id ไม่ตรง
        if (!existingStock) {
          existingStock = await tx.stock.findFirst({
            where: {
              source: "wms",
              product_id: it.product_id,
              location_id: targetLoc.id,
              lot_name: resolvedLot.lot_name ?? it.lot_serial ?? null,
            } as any,
            select: {
              id: true,
              quantity: true,
            },
            orderBy: { id: "desc" },
          });
        }

        if (existingStock) {
          await tx.stock.update({
            where: { id: existingStock.id },
            data: {
              quantity: {
                increment: new Prisma.Decimal(putQty),
              },
              location_id: targetLoc.id,
              location_name: targetLoc.full_name,
              lot_id: resolvedLot.lot_id ?? undefined,
              lot_name: resolvedLot.lot_name ?? undefined,
              expiration_date: stockExp ?? undefined,
              updated_at: new Date(),
            } as any,
          });
        } else {
          await tx.stock.create({
            data: {
              product_id: it.product_id,
              product_code: it.code ?? undefined,
              product_name: it.name ?? undefined,
              unit: it.unit ?? undefined,

              location_id: targetLoc.id,
              location_name: targetLoc.full_name,

              lot_id: resolvedLot.lot_id ?? undefined,
              lot_name: resolvedLot.lot_name ?? undefined,
              expiration_date: stockExp ?? undefined,

              source: "wms",
              quantity: new Prisma.Decimal(putQty),
              active: true,

              bucket_key: buildStockBucketKey({
                source: "wms",
                product_id: it.product_id,
                product_code: it.code ?? null,
                lot_id: resolvedLot.lot_id ?? null,
                lot_name: resolvedLot.lot_name ?? null,
                location_id: targetLoc.id,
                expiration_date: stockExp,
              }),
            } as any,
          });
        }

        stockUpserted++;

        const putSummary = await buildMovementPutSummaryTx(tx, it.id);
        const maxQty = Math.max(0, Math.floor(Number(it.qty ?? 0)));

        const nextStatus =
          maxQty > 0 && putSummary.totalPut >= maxQty
            ? "completed"
            : "put";

        await tx.transfer_movement_item.update({
          where: { id: it.id },
          data: {
            qty_put: putSummary.totalPut,
            lock_no_dest: putSummary.summary,
            status: nextStatus,
            updated_at: new Date(),
          },
        });

        updatedItems++;
      }

      const remain = await tx.transfer_movement_item.count({
        where: {
          transfer_movement_id: doc.id,
          deleted_at: null,
          NOT: { status: "completed" },
        },
      });

      await tx.transfer_movement.update({
        where: { id: doc.id },
        data: {
          status: remain === 0 ? "completed" : "put",
          updated_at: new Date(),
        } as any,
      });

      return {
        stockUpserted,
        updatedItems,
        skipped,
        remain,
      };
    });

    return res.json({
      message:
        "confirmPut สำเร็จ: เพิ่ม stock ตาม location ที่ scan จริงแล้ว",
      transfer_movement_no: no,
      ...result,
    });
  },
);
