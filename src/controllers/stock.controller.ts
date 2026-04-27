import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { CreateStockBody, UpdateStockBody } from "../types/stock";
import { StockBalanceQuery } from "../types/stock_balance";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";
//import { parseDateInput } from "../utils/parseDate";
import { formatStockBalance } from "../utils/formatters/stock_balance.formatter";

// ✅ helper เลือกชื่อสินค้า: เจาะ lot ก่อน ถ้าไม่เจอค่อย fallback
function resolveMeta(
  product_id: number,
  lot_id: number | null,
  goodsByProductLot: Map<
    string,
    { product_name: string | null; unit: string | null }
  >,
  goodsByProduct: Map<
    number,
    { product_name: string | null; unit: string | null }
  >,
) {
  const exact = goodsByProductLot.get(`${product_id}|${lot_id ?? 0}`);
  if (exact) return exact;
  return goodsByProduct.get(product_id) ?? { product_name: null, unit: null };
}

function buildBucketKeyFromBalance(input: {
  source: string;
  product_id: number;
  product_code: string | null;
  lot_id: number | null;
  location_id: number | null;
}) {
  return [
    input.source,
    `p:${input.product_id}`,
    `code:${input.product_code ?? ""}`,
    `lot:${input.lot_id ?? 0}`,
    `loc:${input.location_id ?? 0}`,
  ].join("|");
}

function serializeStock(stock: any) {
  return {
    ...stock,
    quantity: stock.quantity !== null ? Number(stock.quantity) : 0,
  };
}

function parseSortDir(raw: unknown): Prisma.SortOrder {
  return String(raw ?? "desc").trim().toLowerCase() === "asc" ? "asc" : "desc";
}

const STOCK_SORT_FIELDS = new Set([
  "id",
  "bucket_key",
  "product_id",
  "product_code",
  "product_name",
  "unit",
  "location_id",
  "location_name",
  "lot_id",
  "lot_name",
  "expiration_date",
  "source",
  "quantity",
  "count",
  "created_at",
  "updated_at",
]);

function parseStockSortBy(raw: unknown): keyof Prisma.stockOrderByWithRelationInput {
  const sortBy = String(raw ?? "id").trim();
  return STOCK_SORT_FIELDS.has(sortBy) ? (sortBy as keyof Prisma.stockOrderByWithRelationInput) : "id";
}

function buildStockOrderBy(
  sortBy: keyof Prisma.stockOrderByWithRelationInput,
  sortDir: Prisma.SortOrder,
): Prisma.stockOrderByWithRelationInput[] {
  const primary = {
    [sortBy]: sortDir,
  } as Prisma.stockOrderByWithRelationInput;

  if (sortBy === "id") {
    return [primary];
  }

  return [primary, { id: "desc" }];
}

const BOR_SER_SORT_FIELDS = new Set([
  "id",
  "snapshot_date",
  "no",
  "product_id",
  "product_code",
  "product_name",
  "unit",
  "location_id",
  "location_name",
  "location_owner",
  "location_owner_display",
  "location_dest_owner",
  "location_dest_owner_dispalay",
  "lot_id",
  "lot_name",
  "expiration_date",
  "department_id",
  "department_name",
  "source",
  "quantity",
  "count",
  "user_pick",
  "product_last_modified_date",
  "created_at",
  "updated_at",
]);

function parseBorSerSortBy(
  raw: unknown,
):
  | keyof Prisma.bor_stockOrderByWithRelationInput
  | keyof Prisma.ser_stockOrderByWithRelationInput {
  const sortBy = String(raw ?? "snapshot_date").trim();
  return BOR_SER_SORT_FIELDS.has(sortBy)
    ? (sortBy as
        | keyof Prisma.bor_stockOrderByWithRelationInput
        | keyof Prisma.ser_stockOrderByWithRelationInput)
    : "snapshot_date";
}

function buildBorOrderBy(
  sortBy: keyof Prisma.bor_stockOrderByWithRelationInput,
  sortDir: Prisma.SortOrder,
): Prisma.bor_stockOrderByWithRelationInput[] {
  const primary = {
    [sortBy]: sortDir,
  } as Prisma.bor_stockOrderByWithRelationInput;

  if (sortBy === "id") {
    return [primary];
  }

  return [primary, { id: "desc" }];
}

function buildSerOrderBy(
  sortBy: keyof Prisma.ser_stockOrderByWithRelationInput,
  sortDir: Prisma.SortOrder,
): Prisma.ser_stockOrderByWithRelationInput[] {
  const primary = {
    [sortBy]: sortDir,
  } as Prisma.ser_stockOrderByWithRelationInput;

  if (sortBy === "id") {
    return [primary];
  }

  return [primary, { id: "desc" }];
}

export const applyStockBalanceToStock = asyncHandler(
  async (req: Request, res: Response) => {
    const source =
      typeof req.query.source === "string" ? req.query.source : "odoo";

    // ✅ ไม่เช็ค snapshot_date
    const balances = await prisma.stock_balance.findMany({
      where: {
        source,
        // ✅ active อาจเป็น null
        OR: [{ active: true }, { active: null }],
      },
      orderBy: [{ product_code: "asc" }, { lot_name: "asc" }],
    });

    // ✅ เตรียม product_id list
    const productIds = Array.from(
      new Set(balances.map((b) => b.product_id).filter(Boolean)),
    );

    // ✅ ดึง goods ทั้งหมดของ product เหล่านี้ครั้งเดียว (ไม่กรอง active เพื่อให้ได้ product_name)
    const goodsRows = await prisma.wms_mdt_goods.findMany({
      where: {
        product_id: { in: productIds },
      },
      select: {
        product_id: true,
        lot_id: true,
        product_name: true,
        unit: true,
      },
    });

    // ✅ ทำ Map 2 แบบ: (product_id + lot_id) และ fallback เฉพาะ product_id
    // ✅ ให้ความสำคัญกับ product_name ที่ไม่เป็น null
    const goodsByProductLot = new Map<
      string,
      { product_name: string | null; unit: string | null }
    >();
    const goodsByProduct = new Map<
      number,
      { product_name: string | null; unit: string | null }
    >();

    for (const g of goodsRows) {
      // key แบบมี lot
      const k = `${g.product_id}|${g.lot_id ?? 0}`;
      const existing = goodsByProductLot.get(k);

      // ถ้ายังไม่มี หรือ existing ไม่มี product_name แต่ตัวใหม่มี -> อัพเดท
      if (!existing || (!existing.product_name && g.product_name)) {
        goodsByProductLot.set(k, {
          product_name: g.product_name ?? existing?.product_name ?? null,
          unit: g.unit ?? existing?.unit ?? null,
        });
      }

      // fallback key แบบไม่มี lot
      const existingProduct = goodsByProduct.get(g.product_id);

      // ถ้ายังไม่มี หรือ existing ไม่มี product_name แต่ตัวใหม่มี -> อัพเดท
      if (
        !existingProduct ||
        (!existingProduct.product_name && g.product_name)
      ) {
        goodsByProduct.set(g.product_id, {
          product_name: g.product_name ?? existingProduct?.product_name ?? null,
          unit: g.unit ?? existingProduct?.unit ?? null,
        });
      }
    }

    await prisma.$transaction(async (tx) => {
      // ล้างเฉพาะ source นี้
      await tx.stock.deleteMany({ where: { source } });

      if (balances.length === 0) return;

      await tx.stock.createMany({
        data: balances.map((sb) => {
          const meta = resolveMeta(
            sb.product_id,
            sb.lot_id ?? null,
            goodsByProductLot,
            goodsByProduct,
          );

          return {
            bucket_key: buildBucketKeyFromBalance({
              source,
              product_id: sb.product_id,
              product_code: sb.product_code ?? null,
              lot_id: sb.lot_id ?? null,
              location_id: sb.location_id ?? null,
            }),

            product_id: sb.product_id,
            product_code: sb.product_code ?? null,

            // ✅ เติมจาก wms_mdt_goods
            product_name: meta.product_name,
            unit: meta.unit,

            location_id: sb.location_id ?? null,
            location_name: sb.location_name ?? null,

            lot_id: sb.lot_id ?? null,
            lot_name: sb.lot_name ?? null,
            expiration_date: sb.expiration_date ?? null,

            overwrite_remark: null,
            product_last_modified_date: null,

            source,
            quantity: sb.quantity,
            count: 0,

            // ถ้าคุณเพิ่ม field active ใน model stock แล้ว ให้เปิดใช้บรรทัดนี้
            // active: true,
          };
        }),
        // แนะนำกันพังถ้ามี key ซ้ำ
        skipDuplicates: true,
      });
    });

    return res.status(201).json({
      success: true,
      message: `Apply ALL stock_balance(source=${source}) -> stock สำเร็จ`,
      applied: balances.length,
    });
  },
);

// ===== barcode formatter (เหมือนที่คุณใช้ใน inbound) =====
type BarcodeFormatter = {
  barcode: string;
  lot_start: number | null;
  lot_stop: number | null;
  exp_start: number | null;
  exp_stop: number | null;
  barcode_length: number | null;
};

// normalize lot ให้ match เสถียร (กัน space/เคส)
function normalizeLotText(v: unknown): string {
  const s = v == null ? "" : String(v).trim();
  const n = s.replace(/\s+/g, " ").toLowerCase();
  return n.length ? n : "__NULL__";
}

export function stockGoodsKey(
  product_id: number | null | undefined,
  lot_name: any,
) {
  const pid = typeof product_id === "number" ? product_id : 0;
  return `p:${pid}|lot:${normalizeLotText(lot_name)}`;
}

/**
 * เอา stocks ชุดนี้ ไปหา barcode_text จาก goods_ins ด้วย (product_id + lot_serial(lot_name))
 * แล้วเอา barcode_text ไปหา detail ใน barcodes
 */
async function attachBarcodeToStocks(
  stocks: Array<{ product_id: number; lot_name?: string | null }>,
) {
  // 1) unique pairs (product_id + lot_name)
  const pairs = Array.from(
    new Map(
      stocks
        .filter((s) => Number.isFinite(Number(s.product_id)))
        .map((s) => [
          stockGoodsKey(s.product_id, s.lot_name),
          {
            product_id: s.product_id,
            lot_key: normalizeLotText(s.lot_name),
            lot_name: s.lot_name,
          },
        ]),
    ).values(),
  );

  const keyToBarcodeText = new Map<string, string | null>();

  if (pairs.length === 0) {
    return {
      keyToBarcodeText,
      barcodeMap: new Map<string, BarcodeFormatter>(),
    };
  }

  // 2) query goods_ins โดย OR คู่ (product_id + lot_serial) (+ fallback lot)
  const orWhere: Prisma.goods_inWhereInput[] = [];

  for (const p of pairs) {
    // lot เป็น null/empty -> match goods_in ที่ lot_serial/lot เป็น null หรือ ""
    if (p.lot_key === "__NULL__") {
      orWhere.push({
        product_id: p.product_id,
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

    // lot ปกติ
    const lot = String(p.lot_name ?? "").trim();
    orWhere.push({
      product_id: p.product_id,
      lot_serial: { equals: lot, mode: "insensitive" },
      deleted_at: null,
    });
    orWhere.push({
      product_id: p.product_id,
      lot: { equals: lot, mode: "insensitive" },
      deleted_at: null,
    });
  }

  // เอา record ล่าสุดก่อน (กันมีหลายตัว)
  const goodsRows = await prisma.goods_in.findMany({
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

  // 3) fill map key -> barcode_text (เอาอันแรกที่เจอ)
  for (const r of goodsRows) {
    if (r.product_id == null) continue;

    const lotText = normalizeLotText(r.lot_serial ?? r.lot);
    const k = `p:${r.product_id}|lot:${lotText}`;
    if (!keyToBarcodeText.has(k)) {
      const t = (r.barcode_text ?? "").trim();
      keyToBarcodeText.set(k, t.length > 0 ? t : null);
    }
  }

  // 4) query barcodes by barcode_text
  const barcodeTexts = Array.from(
    new Set(
      Array.from(keyToBarcodeText.values())
        .filter(
          (x): x is string => typeof x === "string" && x.trim().length > 0,
        )
        .map((x) => x.trim()),
    ),
  );

  const barcodeMap = new Map<string, BarcodeFormatter>();
  if (barcodeTexts.length > 0) {
    const barcodeRows = await prisma.barcode.findMany({
      where: { barcode: { in: barcodeTexts }, deleted_at: null },
      select: {
        barcode: true,
        lot_start: true,
        lot_stop: true,
        exp_start: true,
        exp_stop: true,
        barcode_length: true,
      },
    });

    for (const b of barcodeRows) {
      barcodeMap.set(b.barcode, {
        barcode: b.barcode,
        lot_start: b.lot_start ?? null,
        lot_stop: b.lot_stop ?? null,
        exp_start: b.exp_start ?? null,
        exp_stop: b.exp_stop ?? null,
        barcode_length: b.barcode_length ?? null,
      });
    }
  }

  return { keyToBarcodeText, barcodeMap };
}

// CREATE Stock
export const createStock = asyncHandler(
  async (req: Request<{}, {}, CreateStockBody>, res: Response) => {
    const data = req.body;

    if (
      !data.bucket_key ||
      !data.product_id ||
      data.quantity === undefined ||
      !data.source
    ) {
      throw badRequest("ข้อมูลไม่ครบถ้วน");
    }

    const stock = await prisma.stock.create({
      data: {
        bucket_key: data.bucket_key,

        product_id: data.product_id,
        product_code: data.product_code,
        product_name: data.product_name,
        unit: data.unit,

        location_id: data.location_id,
        location_name: data.location_name,

        lot_id: data.lot_id,
        lot_name: data.lot_name,
        expiration_date: data.expiration_date
          ? new Date(data.expiration_date)
          : undefined,

        overwrite_remark: data.overwrite_remark,
        product_last_modified_date: data.product_last_modified_date,

        source: data.source,
        quantity: data.quantity,
        count: data.count ?? 0,
      },
    });

    return res.status(201).json(stock);
  },
);

// GET ALL Stock
export const getStocks = asyncHandler(async (req: Request, res: Response) => {
  const rawSearch = req.query.search;
  const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

  let where: Prisma.stockWhereInput = {};

  if (search) {
    const isNumber = !isNaN(Number(search));

    where = {
      OR: [
        { bucket_key: { contains: search, mode: "insensitive" } },
        { product_code: { contains: search, mode: "insensitive" } },
        { product_name: { contains: search, mode: "insensitive" } },
        { location_name: { contains: search, mode: "insensitive" } },
        { lot_name: { contains: search, mode: "insensitive" } },
        { source: { contains: search, mode: "insensitive" } },
        ...(isNumber
          ? [
              { quantity: { equals: Number(search) } },
              { count: { equals: Number(search) } },
            ]
          : []),
      ],
    };
  }

  const stocks = await prisma.stock.findMany({
    where,
    orderBy: { id: "asc" },
  });

  // ✅ attach barcode_text + barcode detail
  const { keyToBarcodeText, barcodeMap } = await attachBarcodeToStocks(
    stocks.map((s) => ({ product_id: s.product_id, lot_name: s.lot_name })),
  );

  return res.json(
    stocks.map((s) => {
      const base = serializeStock(s);

      const k = stockGoodsKey(s.product_id, s.lot_name);
      const barcode_text = keyToBarcodeText.get(k) ?? null;
      const barcode = barcode_text
        ? (barcodeMap.get(barcode_text) ?? null)
        : null;

      return {
        ...base,
        barcode_text,
        barcode,
      };
    }),
  );
});

// GET Stocks (WITH PAGINATION)
export const getStocksPaginated = asyncHandler(
  async (req: Request, res: Response) => {
    const page = Number(req.query.page) || 1;
    const limit =
      req.query.limit !== undefined ? Number(req.query.limit) || 10 : 10;

    if (Number.isNaN(page) || page < 1) {
      throw badRequest("page ต้องเป็นตัวเลขบวกที่มากกว่า 0");
    }

    if (Number.isNaN(limit) || limit < 1) {
      throw badRequest("limit ต้องเป็นตัวเลขบวกที่มากกว่า 0");
    }

    const skip = (page - 1) * limit;
    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

    const sortBy = parseStockSortBy(req.query.sortBy);
    const sortDir = parseSortDir(req.query.sortDir);

    let where: Prisma.stockWhereInput = {};

    if (search) {
      const isNumber = !isNaN(Number(search));

      where = {
        OR: [
          { bucket_key: { contains: search, mode: "insensitive" } },
          { product_code: { contains: search, mode: "insensitive" } },
          { product_name: { contains: search, mode: "insensitive" } },
          { location_name: { contains: search, mode: "insensitive" } },
          { lot_name: { contains: search, mode: "insensitive" } },
          { source: { contains: search, mode: "insensitive" } },
          ...(isNumber
            ? [
                { quantity: { equals: Number(search) } },
                { count: { equals: Number(search) } },
              ]
            : []),
        ],
      };
    }

    const orderBy = buildStockOrderBy(sortBy, sortDir);

    const [stocks, total] = await Promise.all([
      prisma.stock.findMany({
        where,
        skip,
        take: limit,
        orderBy,
      }),
      prisma.stock.count({ where }),
    ]);

    // ✅ attach barcode_text + barcode detail (เฉพาะหน้า page นี้)
    const { keyToBarcodeText, barcodeMap } = await attachBarcodeToStocks(
      stocks.map((s) => ({ product_id: s.product_id, lot_name: s.lot_name })),
    );

    const data = stocks.map((s) => {
      const base = serializeStock(s);

      const k = stockGoodsKey(s.product_id, s.lot_name);
      const barcode_text = keyToBarcodeText.get(k) ?? null;
      const barcode = barcode_text
        ? (barcodeMap.get(barcode_text) ?? null)
        : null;

      return {
        ...base,
        barcode_text,
        barcode,
      };
    });

    return res.json({
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        sortBy,
        sortDir,
      },
    });
  },
);

// GET Stock BY ID
export const getStockById = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    if (isNaN(id)) throw badRequest("ID ต้องเป็นตัวเลข");

    const stock = await prisma.stock.findUnique({ where: { id } });
    if (!stock) throw notFound("ไม่พบสต็อก");

    return res.json(serializeStock(stock));
  },
);

// UPDATE Stock
export const updateStock = asyncHandler(
  async (req: Request<{ id: string }, {}, UpdateStockBody>, res: Response) => {
    const id = Number(req.params.id);
    if (isNaN(id)) throw badRequest("ID ต้องเป็นตัวเลข");

    const existing = await prisma.stock.findUnique({ where: { id } });
    if (!existing) throw notFound("ไม่พบสต็อก");

    const data = req.body;

    const stock = await prisma.stock.update({
      where: { id },
      data: {
        product_code: data.product_code,
        product_name: data.product_name,
        unit: data.unit,

        location_id: data.location_id,
        location_name: data.location_name,

        lot_id: data.lot_id,
        lot_name: data.lot_name,
        expiration_date: data.expiration_date
          ? new Date(data.expiration_date)
          : undefined,

        overwrite_remark: data.overwrite_remark,
        product_last_modified_date: data.product_last_modified_date,

        quantity: data.quantity,
        count: data.count,
      },
    });

    return res.json(stock);
  },
);

// DELETE Stock
export const deleteStock = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    if (isNaN(id)) throw badRequest("ID ต้องเป็นตัวเลข");

    const existing = await prisma.stock.findUnique({ where: { id } });
    if (!existing) throw notFound("ไม่พบสต็อก");

    await prisma.stock.delete({ where: { id } });

    return res.json({ message: "ลบข้อมูลเรียบร้อยแล้ว" });
  },
);

// START Stock COUNT
export const startStockCount = asyncHandler(
  async (_req: Request, res: Response) => {
    const stocks = await prisma.stock.findMany({
      select: { id: true, quantity: true, count: true },
    });

    if (stocks.length === 0) {
      throw badRequest("ไม่พบ stock ในระบบ");
    }

    const updatable = stocks.filter(
      (s) => (s.count ?? 0) < s.quantity.toNumber(),
    );

    const updated = await prisma.$transaction(
      updatable.map((s) =>
        prisma.stock.update({
          where: { id: s.id },
          data: {
            count: (s.count ?? 0) + 1,
          },
        }),
      ),
    );

    return res.json({
      message: "Start count สำเร็จ",
      meta: {
        totalStocks: stocks.length,
        updatedCount: updated.length,
        skippedCount: stocks.length - updated.length,
      },
    });
  },
);
/**
 * Sync Stock Balance จาก Odoo (Manual Sync)
 * POST /api/stocks/sync
 */
export const syncStockFromOdoo = asyncHandler(
  async (req: Request, res: Response) => {
    const { stockSyncService } = await import("../services/stock.sync.service");

    const triggeredBy = (req as any).user?.id || "manual";
    const result = await stockSyncService.syncOdooStock(String(triggeredBy));

    return res.status(201).json({
      success: result.success,
      message: `Sync Odoo Stock Balance สำเร็จ`,
      snapshot_date: result.snapshot_date,
      total_synced: result.total_synced,
      errors: result.errors.length > 0 ? result.errors : undefined,
    });
  },
);

/**
 * สร้าง Stock Balance Snapshot ของ WMS (Manual Trigger)
 * POST /api/stocks/create-snapshot
 */
export const createWmsStockSnapshot = asyncHandler(
  async (req: Request, res: Response) => {
    const { stockSyncService } = await import("../services/stock.sync.service");

    const triggeredBy = (req as any).user?.id || "manual";
    const result = await stockSyncService.createWmsSnapshot(
      String(triggeredBy),
    );

    return res.status(201).json({
      success: result.success,
      message: `สร้าง WMS Stock Snapshot สำเร็จ`,
      snapshot_date: result.snapshot_date,
      total_snapshot: result.total_snapshot,
      errors: result.errors.length > 0 ? result.errors : undefined,
    });
  },
);

/**
 * ดูรายงาน Stock Balance ตามวันที่
 * GET /api/stocks/balance?date=2026-02-01&source=odoo
 */
export const getStockBalance = asyncHandler(
  async (
    req: Request<
      {},
      {},
      {},
      { date?: string; source?: string; product_code?: string }
    >,
    res: Response,
  ) => {
    const { date, source, product_code } = req.query;

    const targetDate = date ? new Date(date) : new Date();
    targetDate.setHours(0, 0, 0, 0);

    const whereCondition: any = {
      snapshot_date: targetDate,
    };

    if (source) {
      whereCondition.source = source;
    }

    if (product_code) {
      whereCondition.product_code = product_code;
    }

    const stockBalances = await prisma.stock_balance.findMany({
      where: whereCondition,
      orderBy: [{ product_code: "asc" }, { lot_name: "asc" }],
    });

    return res.json({
      snapshot_date: targetDate.toISOString().split("T")[0],
      source: source || "all",
      total: stockBalances.length,
      data: stockBalances,
    });
  },
);

/**
 * เปรียบเทียบ Stock Balance ระหว่าง Odoo กับ WMS
 * GET /api/stocks/compare?date=2026-02-01
 */
export const compareStockBalance = asyncHandler(
  async (req: Request<{}, {}, {}, { date?: string }>, res: Response) => {
    const { date } = req.query;

    const targetDate = date ? new Date(date) : new Date();
    targetDate.setHours(0, 0, 0, 0);

    const odooStocks = await prisma.stock_balance.findMany({
      where: {
        snapshot_date: targetDate,
        source: "odoo",
      },
    });

    const wmsStocks = await prisma.stock_balance.findMany({
      where: {
        snapshot_date: targetDate,
        source: "wms",
      },
    });

    const odooMap = new Map(
      odooStocks.map((s) => [
        `${s.product_code}_${s.lot_name || ""}`,
        s.quantity.toNumber(),
      ]),
    );

    const wmsMap = new Map(
      wmsStocks.map((s) => [
        `${s.product_code}_${s.lot_name || ""}`,
        s.quantity.toNumber(),
      ]),
    );

    const differences = [];

    for (const [key, odooQty] of odooMap.entries()) {
      const wmsQty = wmsMap.get(key) || 0;
      if (odooQty !== wmsQty) {
        const [code, lot] = key.split("_");
        differences.push({
          product_code: code,
          lot_name: lot || null,
          odoo_qty: odooQty,
          wms_qty: wmsQty,
          diff: wmsQty - odooQty,
        });
      }
    }

    for (const [key, wmsQty] of wmsMap.entries()) {
      if (!odooMap.has(key)) {
        const [code, lot] = key.split("_");
        differences.push({
          product_code: code,
          lot_name: lot || null,
          odoo_qty: 0,
          wms_qty: wmsQty,
          diff: wmsQty,
        });
      }
    }

    return res.json({
      snapshot_date: targetDate.toISOString().split("T")[0],
      total_differences: differences.length,
      odoo_total_items: odooStocks.length,
      wms_total_items: wmsStocks.length,
      differences,
    });
  },
);

/**
 * ดูประวัติ Stock Balance (แสดงหลายวัน)
 * GET /api/stocks/history?product_code=PROD-001&days=7
 */
export const getStockHistory = asyncHandler(
  async (
    req: Request<
      {},
      {},
      {},
      { product_code: string; days?: string; source?: string }
    >,
    res: Response,
  ) => {
    const { product_code, days = "7", source } = req.query;

    if (!product_code) {
      throw badRequest("กรุณาระบุ product_code");
    }

    const daysCount = parseInt(days, 10);
    const endDate = new Date();
    endDate.setHours(0, 0, 0, 0);

    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - daysCount);

    const whereCondition: any = {
      product_code,
      snapshot_date: {
        gte: startDate,
        lte: endDate,
      },
    };

    if (source) {
      whereCondition.source = source;
    }

    const history = await prisma.stock_balance.findMany({
      where: whereCondition,
      orderBy: { snapshot_date: "asc" },
    });

    // Query wms_mdt_goods เพื่อดึง product_name
    const productIds = [...new Set(history.map((sb) => sb.product_id))];
    const products = await prisma.wms_mdt_goods.findMany({
      where: { product_id: { in: productIds } },
      select: { product_id: true, product_name: true },
    });
    const productMap = new Map(
      products.map((p) => [p.product_id, p.product_name]),
    );

    return res.json({
      product_code,
      period: {
        start: startDate.toISOString().split("T")[0],
        end: endDate.toISOString().split("T")[0],
      },
      total: history.length,
      data: history.map((sb) =>
        formatStockBalance(sb, productMap.get(sb.product_id)),
      ),
    });
  },
);

// ============================================
// Stock Balance CRUD Operations
// ============================================

/**
 * GET ALL Stock Balances
 * GET /api/stock_balances/getAll
 */
export const getAllStockBalances = asyncHandler(
  async (req: Request<{}, {}, {}, StockBalanceQuery>, res: Response) => {
    const { date, source, product_code, product_id, location_id, lot_id } =
      req.query;

    // สร้าง where condition
    const where: Prisma.stock_balanceWhereInput = {};

    if (date) {
      const targetDate = new Date(date);
      targetDate.setHours(0, 0, 0, 0);
      where.snapshot_date = targetDate;
    }

    if (source) {
      where.source = source;
    }

    if (product_code) {
      where.product_code = { contains: product_code, mode: "insensitive" };
    }

    if (product_id) {
      where.product_id = Number(product_id);
    }

    if (location_id) {
      where.location_id = Number(location_id);
    }

    if (lot_id) {
      where.lot_id = Number(lot_id);
    }

    const stockBalances = await prisma.stock_balance.findMany({
      where,
      orderBy: [
        { snapshot_date: "desc" },
        { product_code: "asc" },
        { lot_name: "asc" },
      ],
    });

    // Query wms_mdt_goods เพื่อดึง product_name
    const productIds = [...new Set(stockBalances.map((sb) => sb.product_id))];
    const products = await prisma.wms_mdt_goods.findMany({
      where: { product_id: { in: productIds } },
      select: { product_id: true, product_name: true },
    });
    const productMap = new Map(
      products.map((p) => [p.product_id, p.product_name]),
    );

    return res.json(
      stockBalances.map((sb) =>
        formatStockBalance(sb, productMap.get(sb.product_id)),
      ),
    );
  },
);

/**
 * GET Stock Balances with Pagination
 * GET /api/stock_balances/get?page=1&limit=10
 */
export const getStockBalancesPaginated = asyncHandler(
  async (req: Request<{}, {}, {}, StockBalanceQuery>, res: Response) => {
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

    const { date, source, search } = req.query;

    // ✅ parse columns: รองรับ columns=product_id,product_code และ columns[]=...
    const rawColumns = req.query.columns;
    let searchColumns: string[] = [];

    if (Array.isArray(rawColumns)) {
      searchColumns = rawColumns
        .flatMap((x: any) => x.toString().split(","))
        .map((s: string) => s.trim())
        .filter(Boolean);
    } else if (typeof rawColumns === "string") {
      searchColumns = rawColumns
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
    }

    // ✅ columns= (ว่าง) -> not found
    if (req.query.columns !== undefined && searchColumns.length === 0) {
      return res.json({
        data: [],
        meta: { page, limit, total: 0, totalPages: 0 },
      });
    }

    // ✅ mapping field จาก frontend -> prisma field
    const fieldMapping: Record<string, string> = {
      product_id: "product_id",
      product_code: "product_code",
      location_id: "location_id",
      location_path: "location_path",
      location_name: "location_name",
      lot_id: "lot_id",
      lot_name: "lot_name",
      quantity: "quantity",
      source: "source",
      active: "active",
    };

    const allowedColumns = new Set(Object.keys(fieldMapping));
    const numericFields = new Set(["product_id", "location_id", "lot_id"]);
    const textFields = new Set([
      "product_code",
      "location_path",
      "location_name",
      "lot_name",
      "source",
    ]);

    // สร้าง base where condition
    const baseWhere: Prisma.stock_balanceWhereInput = {};

    if (date) {
      const targetDate = new Date(date);
      targetDate.setHours(0, 0, 0, 0);
      baseWhere.snapshot_date = targetDate;
    }

    if (source) {
      baseWhere.source = source;
    }

    let where: Prisma.stock_balanceWhereInput = baseWhere;

    // เพิ่ม search condition แบบ columns filter
    if (search) {
      const searchTrim = search.trim();
      const isNumericSearch = /^\d+$/.test(searchTrim);
      const orConditions: any[] = [];

      // ✅ ถ้าไม่ส่ง columns เลย -> search all
      const columnsToSearch =
        searchColumns.length === 0
          ? Array.from(allowedColumns)
          : searchColumns.filter((c) => allowedColumns.has(c));

      for (const col of columnsToSearch) {
        const dbField = fieldMapping[col];
        if (!dbField) continue;

        // numeric field -> equals เฉพาะตอน search เป็นตัวเลข
        if (numericFields.has(dbField)) {
          if (isNumericSearch) {
            orConditions.push({ [dbField]: { equals: Number(searchTrim) } });
          }
          continue;
        }

        // quantity field (Decimal)
        if (dbField === "quantity") {
          if (isNumericSearch) {
            orConditions.push({ [dbField]: { equals: Number(searchTrim) } });
          }
          continue;
        }

        // boolean field
        if (dbField === "active") {
          if (searchTrim.toLowerCase() === "true") {
            orConditions.push({ [dbField]: { equals: true } });
          } else if (searchTrim.toLowerCase() === "false") {
            orConditions.push({ [dbField]: { equals: false } });
          }
          continue;
        }

        // text field -> contains
        if (textFields.has(dbField)) {
          orConditions.push({
            [dbField]: { contains: searchTrim, mode: "insensitive" as const },
          });
        }
      }

      // ✅ ไม่มี field ให้ค้นหา -> not found
      if (orConditions.length === 0) {
        return res.json({
          data: [],
          meta: { page, limit, total: 0, totalPages: 0 },
        });
      }

      where = { AND: [baseWhere, { OR: orConditions }] };
    }

    const [stockBalances, total] = await Promise.all([
      prisma.stock_balance.findMany({
        where,
        skip,
        take: limit,
        orderBy: [
          { snapshot_date: "desc" },
          { product_code: "asc" },
          { lot_name: "asc" },
        ],
      }),
      prisma.stock_balance.count({ where }),
    ]);

    // Query wms_mdt_goods เพื่อดึง product_name
    const productIds = [...new Set(stockBalances.map((sb) => sb.product_id))];
    const products = await prisma.wms_mdt_goods.findMany({
      where: { product_id: { in: productIds } },
      select: { product_id: true, product_name: true },
    });
    const productMap = new Map(
      products.map((p) => [p.product_id, p.product_name]),
    );

    return res.json({
      data: stockBalances.map((sb) =>
        formatStockBalance(sb, productMap.get(sb.product_id)),
      ),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  },
);

/**
 * GET Stock Balance by ID
 * GET /api/stock_balances/get/:id
 */
export const getStockBalanceById = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);

    if (isNaN(id)) {
      throw badRequest("ID ต้องเป็นตัวเลข");
    }

    const stockBalance = await prisma.stock_balance.findUnique({
      where: { id },
    });

    if (!stockBalance) {
      throw notFound("ไม่พบข้อมูล Stock Balance");
    }

    // Query wms_mdt_goods เพื่อดึง product_name
    const product = await prisma.wms_mdt_goods.findFirst({
      where: { product_id: stockBalance.product_id },
      select: { product_name: true },
    });

    return res.json(formatStockBalance(stockBalance, product?.product_name));
  },
);

/**
 * UPDATE Stock Balance (สำหรับ Overwrite ข้อมูล)
 * PATCH /api/stock_balances/update/:id
 * ต้องมีสิทธิ์: Admin, Supervisor, UAT
 */
export const updateStockBalance = asyncHandler(
  async (
    req: Request<{ id: string }, {}, { quantity?: number; active?: boolean }>,
    res: Response,
  ) => {
    const id = Number(req.params.id);

    if (isNaN(id)) {
      throw badRequest("ID ต้องเป็นตัวเลข");
    }

    const existing = await prisma.stock_balance.findUnique({
      where: { id },
    });

    if (!existing) {
      throw notFound("ไม่พบข้อมูล Stock Balance");
    }

    const { quantity, active } = req.body;
    const updateData: any = {
      updated_at: new Date(),
    };

    if (quantity !== undefined) {
      updateData.quantity = quantity;
    }

    if (active !== undefined) {
      updateData.active = active;
    }

    const updated = await prisma.stock_balance.update({
      where: { id },
      data: updateData,
    });

    // Query wms_mdt_goods เพื่อดึง product_name
    const product = await prisma.wms_mdt_goods.findFirst({
      where: { product_id: updated.product_id },
      select: { product_name: true },
    });

    return res.json({
      message: "Update Stock Balance สำเร็จ",
      data: formatStockBalance(updated, product?.product_name),
    });
  },
);

function serializeBorSerStock(row: any) {
  return {
    ...row,
    quantity: row?.quantity != null ? Number(row.quantity) : 0,
    count: row?.count != null ? Number(row.count) : 0,
    snapshot_date: row?.snapshot_date
      ? new Date(row.snapshot_date).toISOString()
      : null,
    expiration_date: row?.expiration_date
      ? new Date(row.expiration_date).toISOString()
      : null,
    created_at: row?.created_at
      ? new Date(row.created_at).toISOString()
      : null,
    updated_at: row?.updated_at
      ? new Date(row.updated_at).toISOString()
      : null,
  };
}

function parseBorSerSearchColumns(raw: unknown) {
  if (typeof raw !== "string") return [];

  const allowed = new Set([
    "snapshot_date",
    "no",
    "product_id",
    "product_code",
    "product_name",
    "unit",
    "location_id",
    "location_name",
    "location_owner",
    "location_owner_display",
    "location_dest_owner",
    "location_dest_owner_dispalay",
    "lot_id",
    "lot_name",
    "expiration_date",
    "department_id",
    "department_name",
    "source",
    "quantity",
    "count",
    "user_pick",
    "product_last_modified_date",
  ]);

  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => allowed.has(s));
}

function resolveBorSerSearchValue(req: Request) {
  const rawSearch = req.query.search;
  if (typeof rawSearch === "string" && rawSearch.trim()) {
    return rawSearch.trim();
  }

  const rawSnapshotDate = req.query.snapshot_date;
  if (typeof rawSnapshotDate === "string" && rawSnapshotDate.trim()) {
    return rawSnapshotDate.trim();
  }

  return "";
}

function buildBorSerSearchWhere(
  search: string,
  columns: string[],
): Prisma.bor_stockWhereInput | Prisma.ser_stockWhereInput {
  if (!search) return {};

  const orConditions: any[] = [];
  const numericValue = Number(search);
  const isNumber = !Number.isNaN(numericValue);

  if (columns.includes("snapshot_date")) {
    const maybeDate = new Date(search);
    if (!Number.isNaN(maybeDate.getTime())) {
      const yyyy = maybeDate.getUTCFullYear();
      const mm = String(maybeDate.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(maybeDate.getUTCDate()).padStart(2, "0");

      orConditions.push({
        snapshot_date: {
          gte: new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`),
          lt: new Date(`${yyyy}-${mm}-${dd}T23:59:59.999Z`),
        },
      });
    }
  }

  if (columns.includes("no")) {
    orConditions.push({
      no: { contains: search, mode: "insensitive" },
    });
  }

  if (columns.includes("product_id") && isNumber) {
    orConditions.push({
      product_id: { equals: numericValue },
    });
  }

  if (columns.includes("product_code")) {
    orConditions.push({
      product_code: { contains: search, mode: "insensitive" },
    });
  }

  if (columns.includes("product_name")) {
    orConditions.push({
      product_name: { contains: search, mode: "insensitive" },
    });
  }

  if (columns.includes("unit")) {
    orConditions.push({
      unit: { contains: search, mode: "insensitive" },
    });
  }

  if (columns.includes("location_id") && isNumber) {
    orConditions.push({
      location_id: { equals: numericValue },
    });
  }

  if (columns.includes("location_name")) {
    orConditions.push({
      location_name: { contains: search, mode: "insensitive" },
    });
  }

  if (columns.includes("location_owner")) {
    orConditions.push({
      location_owner: { contains: search, mode: "insensitive" },
    });
  }

  if (columns.includes("location_owner_display")) {
    orConditions.push({
      location_owner_display: { contains: search, mode: "insensitive" },
    });
  }

  if (columns.includes("location_dest_owner")) {
    orConditions.push({
      location_dest_owner: { contains: search, mode: "insensitive" },
    });
  }

  if (columns.includes("location_dest_owner_dispalay")) {
    orConditions.push({
      location_dest_owner_dispalay: {
        contains: search,
        mode: "insensitive",
      },
    });
  }

  if (columns.includes("lot_id") && isNumber) {
    orConditions.push({
      lot_id: { equals: numericValue },
    });
  }

  if (columns.includes("lot_name")) {
    orConditions.push({
      lot_name: { contains: search, mode: "insensitive" },
    });
  }

  if (columns.includes("expiration_date")) {
    const maybeDate = new Date(search);
    if (!Number.isNaN(maybeDate.getTime())) {
      const yyyy = maybeDate.getUTCFullYear();
      const mm = String(maybeDate.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(maybeDate.getUTCDate()).padStart(2, "0");

      orConditions.push({
        expiration_date: {
          gte: new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`),
          lt: new Date(`${yyyy}-${mm}-${dd}T23:59:59.999Z`),
        },
      });
    }
  }

  if (columns.includes("department_id")) {
    orConditions.push({
      department_id: { contains: search, mode: "insensitive" },
    });
  }

  if (columns.includes("department_name")) {
    orConditions.push({
      department_name: { contains: search, mode: "insensitive" },
    });
  }

  if (columns.includes("source")) {
    orConditions.push({
      source: { contains: search, mode: "insensitive" },
    });
  }

  if (columns.includes("quantity") && isNumber) {
    orConditions.push({
      quantity: { equals: numericValue },
    });
  }

  if (columns.includes("count") && isNumber) {
    orConditions.push({
      count: { equals: Math.floor(numericValue) },
    });
  }

  if (columns.includes("user_pick")) {
    orConditions.push({
      user_pick: { contains: search, mode: "insensitive" },
    });
  }

  if (columns.includes("product_last_modified_date")) {
    orConditions.push({
      product_last_modified_date: {
        contains: search,
        mode: "insensitive",
      },
    });
  }

  if (orConditions.length === 0) {
    return { id: -1 } as any;
  }

  return {
    OR: orConditions,
  };
}

export const getBorStocksPaginated = asyncHandler(
  async (req: Request, res: Response) => {
    const page = Number(req.query.page) || 1;
    const limit =
      req.query.limit !== undefined ? Number(req.query.limit) || 10 : 10;

    if (Number.isNaN(page) || page < 1) {
      throw badRequest("page ต้องเป็นตัวเลขบวกที่มากกว่า 0");
    }

    if (Number.isNaN(limit) || limit < 1) {
      throw badRequest("limit ต้องเป็นตัวเลขบวกที่มากกว่า 0");
    }

    const skip = (page - 1) * limit;
    const search = resolveBorSerSearchValue(req);
    const columns = parseBorSerSearchColumns(req.query.columns);

    const sortBy = parseBorSerSortBy(
      req.query.sortBy,
    ) as keyof Prisma.bor_stockOrderByWithRelationInput;
    const sortDir = parseSortDir(req.query.sortDir);

    const where: Prisma.bor_stockWhereInput = {
      deleted_at: null,
      ...(buildBorSerSearchWhere(
        search,
        columns,
      ) as Prisma.bor_stockWhereInput),
    };

    const orderBy = buildBorOrderBy(sortBy, sortDir);

    const [rows, total] = await Promise.all([
      prisma.bor_stock.findMany({
        where,
        skip,
        take: limit,
        orderBy,
      }),
      prisma.bor_stock.count({ where }),
    ]);

    const data = rows.map((row) => serializeBorSerStock(row));

    return res.json({
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        sortBy,
        sortDir,
      },
    });
  },
);

export const getSerStocksPaginated = asyncHandler(
  async (req: Request, res: Response) => {
    const page = Number(req.query.page) || 1;
    const limit =
      req.query.limit !== undefined ? Number(req.query.limit) || 10 : 10;

    if (Number.isNaN(page) || page < 1) {
      throw badRequest("page ต้องเป็นตัวเลขบวกที่มากกว่า 0");
    }

    if (Number.isNaN(limit) || limit < 1) {
      throw badRequest("limit ต้องเป็นตัวเลขบวกที่มากกว่า 0");
    }

    const skip = (page - 1) * limit;
    const search = resolveBorSerSearchValue(req);
    const columns = parseBorSerSearchColumns(req.query.columns);

    const sortBy = parseBorSerSortBy(
      req.query.sortBy,
    ) as keyof Prisma.ser_stockOrderByWithRelationInput;
    const sortDir = parseSortDir(req.query.sortDir);

    const where: Prisma.ser_stockWhereInput = {
      deleted_at: null,
      ...(buildBorSerSearchWhere(
        search,
        columns,
      ) as Prisma.ser_stockWhereInput),
    };

    const orderBy = buildSerOrderBy(sortBy, sortDir);

    const [rows, total] = await Promise.all([
      prisma.ser_stock.findMany({
        where,
        skip,
        take: limit,
        orderBy,
      }),
      prisma.ser_stock.count({ where }),
    ]);

    const data = rows.map((row) => serializeBorSerStock(row));

    return res.json({
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        sortBy,
        sortDir,
      },
    });
  },
);