import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { CreateGoodsBody, UpdateGoodsBody } from "../types/goods";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";
import { formatGoods } from "../utils/formatters/goods.formatter";
import { formatWmsMdtGoods } from "../utils/formatters/wms_mdt_goods.formatter";
import { parseDateInput } from "../utils/parseDate";

// CREATE Goods
export const createGoods = asyncHandler(
  async (req: Request<{}, {}, CreateGoodsBody>, res: Response) => {
    const data = req.body;
    // เช็คข้อมูลบังคับ
    if (
      !data.id ||
      !data.sku ||
      !data.name ||
      !data.lot ||
      !data.exp_date_start ||
      !data.exp_date_end ||
      !data.unit ||
      typeof data.department_id !== 'number' ||
      typeof data.zone_type_id !== 'number'
    ) {
      throw badRequest("ข้อมูลไม่ครบถ้วน");
    }

    const goods = await prisma.goods.create({
      data: {
        ...data,
        exp_date_start: parseDateInput(data.exp_date_start, "exp_date_start"),
        exp_date_end: parseDateInput(data.exp_date_end, "exp_date_end"),
      },
    });

    const { ...safeGoods } = goods;
    return res.status(201).json(safeGoods);
  },
);

// GET ALL Goods
export const getGoods = asyncHandler(async (req: Request, res: Response) => {
  // 🔎 รองรับ search จาก query string
  const rawSearch = req.query.search;
  const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

  // สร้าง where เงื่อนไขค้นหา
  const baseWhere: Prisma.goodsWhereInput = {
    deleted_at: null,
  };

  let where: Prisma.goodsWhereInput = baseWhere;
  if (search) {
    const searchCondition: Prisma.goodsWhereInput = {
      OR: [
        { id: { contains: search, mode: "insensitive" } },
        { sku: { contains: search, mode: "insensitive" } },
        { name: { contains: search, mode: "insensitive" } },
        { lot: { contains: search, mode: "insensitive" } },
        { unit: { contains: search, mode: "insensitive" } },
        {
          zone_type: {
            OR: [{ short_name: { contains: search, mode: "insensitive" } }],
          },
        },
        { remark: { contains: search, mode: "insensitive" } },
      ],
    };
    where = { AND: [baseWhere, searchCondition] };
  }

  const goods = await prisma.goods.findMany({
    where,
    orderBy: { id: "asc" },
    include: {
      department: true,
      zone_type: true,
    },
  });

  return res.json(goods.map(formatGoods));
});

// GET Goods (WITH PAGINATION)
export const getGoodsPaginated = asyncHandler(
  async (req: Request, res: Response) => {
    const page = Number(req.query.page) || 1;
    const limit =
      req.query.limit !== undefined ? Number(req.query.limit) || 10 : 10;

    if (isNaN(page) || page < 1) {
      throw badRequest("page ต้องเป็นตัวเลขบวกที่มีค่ามากกว่า 0");
    }

    const skip = (page - 1) * limit;

    // 🔎 รองรับ search จาก query string
    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

    // สร้าง where เงื่อนไขค้นหา
    const baseWhere: Prisma.goodsWhereInput = {
      deleted_at: null,
    };

    let where: Prisma.goodsWhereInput = baseWhere;
    if (search) {
      const searchCondition: Prisma.goodsWhereInput = {
        OR: [
          { id: { contains: search, mode: "insensitive" } },
          { sku: { contains: search, mode: "insensitive" } },
          { name: { contains: search, mode: "insensitive" } },
          { lot: { contains: search, mode: "insensitive" } },
          { unit: { contains: search, mode: "insensitive" } },
          {
            zone_type: {
              OR: [{ short_name: { contains: search, mode: "insensitive" } }],
            },
          },
          { remark: { contains: search, mode: "insensitive" } },
        ],
      };
      where = { AND: [baseWhere, searchCondition] };
    }

    const [goods, total] = await Promise.all([
      prisma.goods.findMany({
        where,
        skip,
        take: limit,
        orderBy: { id: "asc" },
        include: {
          department: true,
          zone_type: true,
        },
      }),
      prisma.goods.count({ where }),
    ]);

    return res.json({
      data: goods.map(formatGoods),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  },
);

// GET Goods BY ID
export const getGoodsById = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const goods = await prisma.goods.findUnique({
      where: { id },
      include: {
        department: true,
        zone_type: true,
      },
    });
    if (!goods) throw notFound("ไม่พบสินค้า");
    return res.json(formatGoods(goods));
  },
);

// UPDATE Goods
export const updateGoods = asyncHandler(
  async (req: Request<{ id: string }, {}, UpdateGoodsBody>, res: Response) => {
    // 🆕 soft deleted check
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    // 🆕 soft deleted check
    const existingGoods = await prisma.goods.findUnique({
      where: { id: id },
    });
    if (!existingGoods) {
      throw notFound("ไม่พบสินค้า");
    }
    if (existingGoods.deleted_at) {
      throw badRequest("สินค้า ถูกลบไปแล้ว");
    }

    const data = req.body;
    const goods = await prisma.goods.update({
      where: { id: id },
      data: {
        ...data,
        exp_date_start: data.exp_date_start
          ? parseDateInput(data.exp_date_start, "exp_date_start")
          : undefined,
        exp_date_end: data.exp_date_end
          ? parseDateInput(data.exp_date_end, "exp_date_end")
          : undefined,
        updated_at: new Date(),
      },
    });

    return res.json(goods);
  },
);

// DELETE Goods
export const deleteGoods = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const old = await prisma.goods.findUnique({ where: { id } });
    if (!old) throw notFound("ไม่พบสินค้า");
    if (old.deleted_at) throw badRequest("สินค้าถูกลบไปแล้ว");

    await prisma.goods.update({
      where: { id },
      data: { deleted_at: new Date(), updated_at: new Date() },
    });

    return res.json({ message: "ลบสินค้าเรียบร้อยแล้ว" });
  },
);

// ============================================
// WMS_MDT_GOODS CONTROLLERS
// ============================================

// GET ALL WMS_MDT_GOODS
export const getWmsMdtGoods = asyncHandler(async (req: Request, res: Response) => {
  const page = Number(req.query.page) || 1;
  const limit = req.query.limit !== undefined ? Number(req.query.limit) || 10 : 10;

  if (isNaN(page) || page < 1) {
    throw badRequest("page ต้องเป็นตัวเลขบวกที่มีค่ามากกว่า 0");
  }
  if (isNaN(limit) || limit < 1) {
    throw badRequest("limit ต้องเป็นตัวเลขบวกที่มีค่ามากกว่า 0");
  }

  const skip = (page - 1) * limit;

  const rawSearch = req.query.search;
  const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

  // ✅ parse columns: รองรับ columns=product_id,product_code และ columns[]=...
  const rawColumns = req.query.columns;
  let searchColumns: string[] = [];

  if (Array.isArray(rawColumns)) {
    searchColumns = rawColumns
      .flatMap((x) => x.toString().split(","))
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (typeof rawColumns === "string") {
    searchColumns = rawColumns
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // ✅ columns= (ว่าง) -> not found (ตามที่คุณต้องการ)
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
    product_name: "product_name",
    lot_id: "lot_id",
    lot_name: "lot_name",
    expiration_date: "expiration_date",
    expiration_date_end: "expiration_date", // ⚠️ ถ้ามี field จริงชื่อ expiration_date_end ให้แก้
    department_id: "department_id",
    department_code: "department_code",
    department_name: "department_name",
    zone_id: "zone_id",
    zone_type: "zone_type",
    unit: "unit",
    remark: "user_manaul_url",
  };

  const allowedColumns = new Set(Object.keys(fieldMapping));
  const numericFields = new Set(["product_id", "lot_id", "department_id", "zone_id"]);
  const textFields = new Set([
    "product_code",
    "product_name",
    "lot_name",
    "department_code",
    "department_name",
    "zone_type",
    "unit",
    "user_manaul_url",
  ]);

  let where: Prisma.wms_mdt_goodsWhereInput = {};

  if (search) {
    const isNumericSearch = /^\d+$/.test(search);
    const orConditions: any[] = [];

    // ✅ ถ้าไม่ส่ง columns เลย -> search all (หรือถ้าคุณอยาก strict ก็ปรับให้ return [] ได้)
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
          orConditions.push({ [dbField]: { equals: Number(search) } });
        }
        continue;
      }

      // date field (ยังไม่ทำ)
      if (dbField === "expiration_date") {
        continue;
      }

      // text field -> contains
      if (textFields.has(dbField)) {
        orConditions.push({
          [dbField]: { contains: search, mode: "insensitive" as const },
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

    where = { OR: orConditions };
  }

  const [goods, total] = await Promise.all([
    prisma.wms_mdt_goods.findMany({
      where,
      skip,
      take: limit,
      orderBy: { id: "asc" },
    }),
    prisma.wms_mdt_goods.count({ where }),
  ]);

  return res.json({
    data: goods.map(formatWmsMdtGoods),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

// GET ALL PRODUCTS (NO SEARCH, NO PAGINATION)
export const getAllProduct = asyncHandler(async (req: Request, res: Response) => {
  const goods = await prisma.wms_mdt_goods.findMany({
    orderBy: { id: "asc" },
  });

  return res.json(goods.map(formatWmsMdtGoods));
});

// GET WMS_MDT_GOODS WITH PAGINATION AND SEARCH & COLUMN FILTER
export const getWmsMdtGoodsPaginated = asyncHandler(
  async (req: Request, res: Response) => {
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

    // ✅ parse columns
    const rawColumns = req.query.columns;
    let searchColumns: string[] = [];

    if (Array.isArray(rawColumns)) {
      searchColumns = rawColumns
        .flatMap((x) => x.toString().split(","))
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (typeof rawColumns === "string") {
      searchColumns = rawColumns
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    // ✅ columns= (ว่าง) -> return []
    if (req.query.columns !== undefined && searchColumns.length === 0) {
      return res.json({
        data: [],
        meta: { page, limit, total: 0, totalPages: 0 },
      });
    }

    const fieldMapping: Record<string, string> = {
      product_id: "product_id",
      product_code: "product_code",
      product_name: "product_name",
      lot_id: "lot_id",
      lot_name: "lot_name",
      expiration_date: "expiration_date",
      expiration_date_end: "expiration_date", // ⚠️ ถ้ามี field จริงชื่อ expiration_date_end ให้แก้
      department_id: "department_id",
      department_code: "department_code",
      department_name: "department_name",
      zone_id: "zone_id",
      zone_type: "zone_type",
      unit: "unit",
      remark: "user_manaul_url",
    };

    const allowedColumns = new Set(Object.keys(fieldMapping));

    const numericFields = new Set(["product_id", "lot_id", "department_id", "zone_id"]);
    const textFields = new Set([
      "product_code",
      "product_name",
      "lot_name",
      "department_code",
      "department_name",
      "zone_type",
      "unit",
      "user_manaul_url",
    ]);

    let where: Prisma.wms_mdt_goodsWhereInput = {};

    if (search) {
      const isNumericSearch = /^\d+$/.test(search);
      const orConditions: any[] = [];

      const columnsToSearch =
        searchColumns.length === 0
          ? Array.from(allowedColumns)
          : searchColumns.filter((c) => allowedColumns.has(c));

      for (const col of columnsToSearch) {
        const dbField = fieldMapping[col];
        if (!dbField) continue;

        if (numericFields.has(dbField)) {
          if (isNumericSearch) {
            orConditions.push({ [dbField]: { equals: Number(search) } });
          }
          continue;
        }

        if (dbField === "expiration_date") {
          // ยังไม่ทำค้นหา date ในช่อง search
          continue;
        }

        if (textFields.has(dbField)) {
          orConditions.push({
            [dbField]: { contains: search, mode: "insensitive" as const },
          });
        }
      }

      if (orConditions.length > 0) {
        where = { OR: orConditions };
      } else {
        return res.json({
          data: [],
          meta: { page, limit, total: 0, totalPages: 0 },
        });
      }
    }

    const [goods, total] = await Promise.all([
      prisma.wms_mdt_goods.findMany({
        where,
        skip,
        take: limit,
        orderBy: { id: "asc" },
      }),
      prisma.wms_mdt_goods.count({ where }),
    ]);

    return res.json({
      data: goods.map(formatWmsMdtGoods),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  }
);

// GET WMS_MDT_GOODS BY ID
export const getWmsMdtGoodsById = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const id = parseInt(
      Array.isArray(req.params.id) ? req.params.id[0] : req.params.id,
    );

    if (isNaN(id)) {
      throw badRequest("id ต้องเป็นตัวเลข");
    }

    const goods = await prisma.wms_mdt_goods.findUnique({
      where: { id },
    });

    if (!goods) throw notFound("ไม่พบสินค้า WMS MDT");

    return res.json(formatWmsMdtGoods(goods));
  },
);

// UPDATE WMS_MDT_GOODS BY ID
export const updateWmsMdtGoods = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const id = parseInt(
      Array.isArray(req.params.id) ? req.params.id[0] : req.params.id,
      10,
    );

    if (Number.isNaN(id)) throw badRequest("id ต้องเป็นตัวเลข");

    const data = req.body ?? {};

    const existing = await prisma.wms_mdt_goods.findUnique({
      where: { id },
      select: { id: true, product_code: true },
    });
    if (!existing) throw notFound("ไม่พบสินค้า WMS MDT");

    // ใช้ sku จาก record เดิมเป็นหลัก (กัน user ส่ง product_code มามั่ว)
    const sku = (existing.product_code ?? "").trim();

    // ถ้าจะอนุญาตให้เปลี่ยน product_code จริง ๆ ค่อยปรับ logic เพิ่ม
    // (แต่ตอนนี้คุณต้องการผูกตาม sku เดิม)

    const now = new Date();

    const result = await prisma.$transaction(async (tx) => {
      // 1) update record ตาม id (field อื่น ๆ ยังเป็น per-row)
      const updated = await tx.wms_mdt_goods.update({
        where: { id },
        data: {
          product_code: data.product_code ?? undefined,
          product_name: data.product_name ?? undefined,
          product_type: data.product_type ?? undefined,
          lot_id: data.lot_id ?? undefined,
          lot_name: data.lot_name ?? undefined,
          expiration_date: data.expiration_date
            ? new Date(data.expiration_date)
            : undefined,
          department_code: data.department_code ?? undefined,
          department_name: data.department_name ?? undefined,
          department_id: data.department_id ?? undefined,
          unit: data.unit ?? undefined,
          zone_type: data.zone_type ?? undefined,
          zone_id: data.zone_id ?? undefined,
          tracking: data.tracking ?? undefined,
          active: data.active !== undefined ? data.active : undefined,

          // ✅ จุดสำคัญ: ถ้ามี input_number ส่งมา "อย่าเพิ่งตัดสินใจตรงนี้"
          // ให้ไปกระจายด้านล่าง
          input_number:
            data.input_number !== undefined ? data.input_number : undefined,

          product_last_modified_date: now,
        },
      });

      // 2) ถ้ามี input_number ถูกส่งมา -> update ทุก record ที่ product_code เดียวกัน
      let skuUpdatedCount = 0;

      if (data.input_number !== undefined) {
        if (!sku) {
          // ถ้า record นี้ไม่มี sku จะกระจายไม่ได้
          throw badRequest("ไม่พบ product_code ของสินค้าชิ้นนี้ ไม่สามารถกระจาย input_number ได้");
        }

        const bulk = await tx.wms_mdt_goods.updateMany({
          where: {
            product_code: sku,
          },
          data: {
            input_number: Boolean(data.input_number),
            product_last_modified_date: now,
          },
        });

        skuUpdatedCount = bulk.count;
      }

      return { updated, skuUpdatedCount, sku };
    });

    return res.json({
      message:
        result.skuUpdatedCount > 0
          ? `อัพเดทสำเร็จ และกระจาย input_number ไปทั้ง SKU (${result.sku}) จำนวน ${result.skuUpdatedCount} รายการ`
          : "อัพเดทสินค้า WMS MDT สำเร็จ",
      data: formatWmsMdtGoods(result.updated),
      sku: result.sku,
      sku_updated_count: result.skuUpdatedCount,
    });
  },
);
