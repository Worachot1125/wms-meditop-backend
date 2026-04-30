import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";
import { formatWmsMdtGoods } from "../utils/formatters/wms_mdt_goods.formatter";
import {
  buildWmsMdtGoodsWhere,
  parseSearchColumns,
} from "../utils/wms_mdt_goods.helper";

const getPagination = (req: Request) => {
  const page = Number(req.query.page) || 1;
  const limit =
    req.query.limit !== undefined ? Number(req.query.limit) || 10 : 10;

  if (isNaN(page) || page < 1) {
    throw badRequest("page ต้องเป็นตัวเลขบวกที่มีค่ามากกว่า 0");
  }

  if (isNaN(limit) || limit < 1) {
    throw badRequest("limit ต้องเป็นตัวเลขบวกที่มีค่ามากกว่า 0");
  }

  return {
    page,
    limit,
    skip: (page - 1) * limit,
  };
};

// GET /wms_mdt_goods/getAll
export const getWmsMdtGoods = asyncHandler(
  async (req: Request, res: Response) => {
    const { page, limit, skip } = getPagination(req);

    const search =
      typeof req.query.search === "string" ? req.query.search.trim() : "";

    const searchColumns = parseSearchColumns(req.query.columns);

    if (req.query.columns !== undefined && searchColumns.length === 0) {
      return res.json({
        data: [],
        meta: { page, limit, total: 0, totalPages: 0 },
      });
    }

    const where = buildWmsMdtGoodsWhere({
      search,
      columns: searchColumns,
    });

    if (where === null) {
      return res.json({
        data: [],
        meta: { page, limit, total: 0, totalPages: 0 },
      });
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
  },
);

// GET /wms_mdt_goods/getAllProducts
export const getAllProduct = asyncHandler(
  async (_req: Request, res: Response) => {
    const goods = await prisma.wms_mdt_goods.findMany({
      orderBy: { id: "asc" },
    });

    return res.json(goods.map(formatWmsMdtGoods));
  },
);

// GET /wms_mdt_goods/get
export const getWmsMdtGoodsPaginated = asyncHandler(
  async (req: Request, res: Response) => {
    const { page, limit, skip } = getPagination(req);

    const search =
      typeof req.query.search === "string" ? req.query.search.trim() : "";

    const searchColumns = parseSearchColumns(req.query.columns);

    if (req.query.columns !== undefined && searchColumns.length === 0) {
      return res.json({
        data: [],
        meta: { page, limit, total: 0, totalPages: 0 },
      });
    }

    const where = buildWmsMdtGoodsWhere({
      search,
      columns: searchColumns,
    });

    if (where === null) {
      return res.json({
        data: [],
        meta: { page, limit, total: 0, totalPages: 0 },
      });
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
  },
);

// GET /wms_mdt_goods/get/:id
export const getWmsMdtGoodsById = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const id = parseInt(
      Array.isArray(req.params.id) ? req.params.id[0] : req.params.id,
      10,
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

// PATCH /wms_mdt_goods/update/:id
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

    const sku = (existing.product_code ?? "").trim();
    const now = new Date();

    const result = await prisma.$transaction(async (tx) => {
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
          input_number:
            data.input_number !== undefined ? data.input_number : undefined,
          product_last_modified_date: now,
        },
      });

      let skuUpdatedCount = 0;

      if (data.input_number !== undefined) {
        if (!sku) {
          throw badRequest(
            "ไม่พบ product_code ของสินค้าชิ้นนี้ ไม่สามารถกระจาย input_number ได้",
          );
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