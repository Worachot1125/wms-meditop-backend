import type { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { CreateBarcodeBody, UpdateBarcodeBody } from "../types/barcode";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";
import { odooDbService } from "../services/odoo.db.service";
import { barcodeSyncService } from "../services/barcode.sync.service";

// Manual Sync Barcodes from Odoo
export const manualSyncBarcodes = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = (req as any).user?.id || "manual";

    try {
      // Fetch barcodes from Odoo
      const odooBarcodes = await odooDbService.getBarcodes();

      // Sync with database
      const result = await barcodeSyncService.syncBarcodes(odooBarcodes, String(userId));

      return res.status(200).json({
        success: true,
        message: "Sync barcodes เรียบร้อย",
        result: {
          total_processed: result.total_processed,
          created: result.created,
          updated: result.updated,
          errors: result.errors.length > 0 ? result.errors : undefined,
        },
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: "Sync barcodes ล้มเหลว",
        error: error.message,
      });
    }
  }
);

// CREATE Barcode
export const createBarcode = asyncHandler(
  async (req: Request<{}, {}, CreateBarcodeBody>, res: Response) => {
    const data = req.body;

    // เช็คข้อมูลบังคับ
    if (!data.barcode) {
      throw badRequest("barcode จำเป็นต้องมี");
    }

    // หา wms_goods_id จาก product_id (ถ้ามี)
    let wmsGoodsId: number | undefined = data.wms_goods_id;
    if (!wmsGoodsId && data.product_id) {
      const wmsGoods = await prisma.wms_mdt_goods.findFirst({
        where: { product_id: data.product_id },
      });
      wmsGoodsId = wmsGoods?.id;
    }

    const barcode = await prisma.barcode.create({
      data: {
        barcode_id: data.barcode_id,
        barcode: data.barcode,
        product_id: data.product_id,
        wms_goods_id: wmsGoodsId,
        product_code: data.product_code,
        product_name: data.product_name,
        tracking: data.tracking,
        ratio: data.ratio,
        lot_start: data.lot_start,
        lot_stop: data.lot_stop,
        exp_start: data.exp_start,
        exp_stop: data.exp_stop,
        barcode_length: data.barcode_length,
        internal_use: data.internal_use ?? false,
        active: data.active ?? true,
      },
      include: {
        wms_goods: true,
        goods_ins: {
          where: { deleted_at: null },
        },
      },
    });

    return res.status(201).json(barcode);
  }
);

// GET ALL Barcode
export const getBarcodes = asyncHandler(async (req: Request, res: Response) => {
  // 🔎 รองรับ search จาก query string
  const rawSearch = req.query.search;
  const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

  // สร้าง where เงื่อนไขค้นหา
  const baseWhere: Prisma.barcodeWhereInput = {
    deleted_at: null,
  };

  let where: Prisma.barcodeWhereInput = baseWhere;
  if (search) {
    // Search เฉพาะ string fields และ barcode_id
    const searchCondition: Prisma.barcodeWhereInput = {
      OR: [
        { barcode: { contains: search, mode: "insensitive" } },
        { product_code: { contains: search, mode: "insensitive" } },
        { product_name: { contains: search, mode: "insensitive" } },
        { tracking: { contains: search, mode: "insensitive" } },
      ],
    };
    
    // ถ้า search เป็นตัวเลข ให้ค้นหา barcode_id ด้วย
    if (!isNaN(Number(search))) {
      searchCondition.OR?.push({ barcode_id: { equals: Number(search) } });
    }
    
    where = { AND: [baseWhere, searchCondition] };
  }

  const barcode = await prisma.barcode.findMany({
    where,
    orderBy: { id: "asc" },
    include: {
      wms_goods: true,
      goods_ins: {
        where: { deleted_at: null },
      },
    },
  });

  return res.json(barcode);
});

// GET Barcodes (WITH PAGINATION)
export const getBarcodesPaginated = asyncHandler(
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
    const baseWhere: Prisma.barcodeWhereInput = {
      deleted_at: null,
    };

    let where: Prisma.barcodeWhereInput = baseWhere;
    if (search) {
      // Search เฉพาะ string fields และ barcode_id
      const searchCondition: Prisma.barcodeWhereInput = {
        OR: [
          { barcode: { contains: search, mode: "insensitive" } },
          { product_code: { contains: search, mode: "insensitive" } },
          { product_name: { contains: search, mode: "insensitive" } },
          { tracking: { contains: search, mode: "insensitive" } },
        ],
      };
      
      // ถ้า search เป็นตัวเลข ให้ค้นหา barcode_id ด้วย
      if (!isNaN(Number(search))) {
        searchCondition.OR?.push({ barcode_id: { equals: Number(search) } });
      }
      
      where = { AND: [baseWhere, searchCondition] };
    }

    const [barcode, total] = await Promise.all([
      prisma.barcode.findMany({
        where,
        skip,
        take: limit,
        orderBy: { id: "asc" },
        include: {
          wms_goods: true,
          goods_ins: {
            where: { deleted_at: null },
          },
        },
      }),
      prisma.barcode.count({ where }),
    ]);

    const safeBarcode = barcode.map((b) => b);

    return res.json({
      data: safeBarcode,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  }
);

// GET Barcode BY ID
export const getBarcodeById = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(idParam);
    
    if (isNaN(id)) {
      throw badRequest("id ต้องเป็นตัวเลข");
    }

    const barcode = await prisma.barcode.findUnique({ 
      where: { id },
      include: {
        wms_goods: true,
        goods_ins: {
          where: { deleted_at: null },
        },
      },
    });
    
    if (!barcode) {
      throw notFound("ไม่พบบาร์โค้ด");
    }

    return res.json(barcode);
  }
);

// UPDATE Barcode
export const updateBarcode = asyncHandler(
  async (
    req: Request<{ id: string }, {}, UpdateBarcodeBody>,
    res: Response
  ) => {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(idParam);
    
    if (isNaN(id)) {
      throw badRequest("id ต้องเป็นตัวเลข");
    }

    const existingBarcode = await prisma.barcode.findUnique({
      where: { id },
    });
    
    if (!existingBarcode) {
      throw notFound("ไม่พบบาร์โค้ด");
    }
    
    if (existingBarcode.deleted_at) {
      throw badRequest("บาร์โค้ดถูกลบไปแล้ว");
    }

    const data = req.body;
    
    // หา wms_goods_id จาก product_id (ถ้ามีการเปลี่ยน product_id)
    let wmsGoodsId: number | null | undefined = undefined;
    if (data.product_id !== undefined) {
      const wmsGoods = await prisma.wms_mdt_goods.findFirst({
        where: { product_id: data.product_id },
      });
      wmsGoodsId = wmsGoods?.id || null;
    }
    
    const barcode = await prisma.barcode.update({
      where: { id },
      data: {
        ...data,
        wms_goods_id: wmsGoodsId,
        updated_at: new Date(),
      },
      include: {
        wms_goods: true,
        goods_ins: {
          where: { deleted_at: null },
        },
      },
    });

    return res.json(barcode);
  }
);

// DELETE Barcode
export const deleteBarcode = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(idParam);
    
    if (isNaN(id)) {
      throw badRequest("id ต้องเป็นตัวเลข");
    }

    const oldBarcode = await prisma.barcode.findUnique({ where: { id } });
    
    if (!oldBarcode) {
      throw notFound("ไม่พบบาร์โค้ด");
    }
    
    if (oldBarcode.deleted_at) {
      throw badRequest("บาร์โค้ดถูกลบไปแล้ว");
    }

    await prisma.barcode.update({
      where: { id },
      data: {
        deleted_at: new Date(),
        updated_at: new Date(),
      },
    });

    return res.json({ message: "ลบบาร์โค้ดเรียบร้อยแล้ว" });
  }
);
