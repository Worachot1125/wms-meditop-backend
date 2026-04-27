import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { CreateZoneTypeBody, UpdateZoneTypeBody } from "../types/zone_type";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";
import { odooDbService } from "../services/odoo.db.service";
import { zoneTypeSyncService } from "../services/zone_type.sync.service";

// Manual Sync Zone Types from Odoo
export const manualSyncZoneTypes = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = (req as any).user?.id || "manual";

    try {
      // Fetch zone types from Odoo
      const odooZoneTypes = await odooDbService.getZoneTypes();

      // Sync with database
      const result = await zoneTypeSyncService.syncZoneTypes(odooZoneTypes, String(userId));

      return res.status(200).json({
        success: true,
        message: "Sync zone types เรียบร้อย",
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
        message: "Sync zone types ล้มเหลว",
        error: error.message,
      });
    }
  }
);

// CREATE ZoneType
export const createZoneType = asyncHandler(
  async (req: Request<{}, {}, CreateZoneTypeBody>, res: Response) => {
    const data = req.body;
    // เช็คข้อมูลบังคับ
    if (!data.full_name || !data.short_name) {
      throw badRequest("ข้อมูลไม่ครบถ้วน");
    }

    const zoneType = await prisma.zone_type.create({
      data: {
        ...data,
      },
    });

    const { ...safeZoneType } = zoneType;
    return res.status(201).json(safeZoneType);
  }
);

// GET ALL ZoneType
export const getZoneTypes = asyncHandler(
  async (req: Request, res: Response) => {
    // 🔎 รองรับ search จาก query string
    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

    // สร้าง where เงื่อนไขค้นหา
    const baseWhere: Prisma.zone_typeWhereInput = {
      deleted_at: null,
    };

    let where: Prisma.zone_typeWhereInput = baseWhere;
    if (search) {
      const searchCondition: Prisma.zone_typeWhereInput = {
        OR: [
          { full_name: { contains: search, mode: "insensitive" } },
          { short_name: { contains: search, mode: "insensitive" } },
          { remark: { contains: search, mode: "insensitive" } },
        ],
      };
      where = { AND: [baseWhere, searchCondition] };
    }

    const zoneType = await prisma.zone_type.findMany({
      where,
      orderBy: { id: "asc" },
    });

    return res.json(zoneType);
  }
);

// GET ZoneTypes (WITH PAGINATION)
export const getZoneTypesPaginated = asyncHandler(
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
    const baseWhere: Prisma.zone_typeWhereInput = {
      deleted_at: null,
    };

    let where: Prisma.zone_typeWhereInput = baseWhere;
    if (search) {
      const searchCondition: Prisma.zone_typeWhereInput = {
        OR: [
          { full_name: { contains: search, mode: "insensitive" } },
          { short_name: { contains: search, mode: "insensitive" } },
          { remark: { contains: search, mode: "insensitive" } },
        ],
      };
      where = { AND: [baseWhere, searchCondition] };
    }

    const [zoneType, total] = await Promise.all([
      prisma.zone_type.findMany({
        where,
        skip,
        take: limit,
        orderBy: { id: "asc" },
      }),
      prisma.zone_type.count({ where }),
    ]);

    const safeZoneType = zoneType.map((zt) => zt);

    return res.json({
      data: safeZoneType,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  }
);

// GET ZoneType BY ID
export const getZoneTypeById = asyncHandler(
  async (req: Request, res: Response) => {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(idParam, 10);
    if (isNaN(id)) throw badRequest("id ต้องเป็นตัวเลข");

    const zoneType = await prisma.zone_type.findUnique({ where: { id } });
    if (!zoneType) {
      throw notFound("ไม่พบประเภทโซน");
    }

    return res.json(zoneType);
  }
);

// UPDATE ZoneType
export const updateZoneType = asyncHandler(
  async (
    req: Request<{ id: string }, {}, UpdateZoneTypeBody>,
    res: Response
  ) => {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(idParam, 10);
    if (isNaN(id)) throw badRequest("id ต้องเป็นตัวเลข");

    // 🆕 soft deleted check
    const existingZoneType = await prisma.zone_type.findUnique({
      where: { id },
    });
    if (!existingZoneType) {
      throw notFound("ไม่พบประเภทโซน");
    }
    if (existingZoneType.deleted_at) {
      throw badRequest("ประเภทโซนถูกลบไปแล้ว");
    }

    const data = req.body;
    const zoneType = await prisma.zone_type.update({
      where: { id },
      data: {
        ...data,
        updated_at: new Date(),
      },
    });

    return res.json(zoneType);
  }
);

// DELETE ZoneType
export const deleteZoneType = asyncHandler(
  async (req: Request, res: Response) => {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(idParam, 10);
    if (isNaN(id)) throw badRequest("id ต้องเป็นตัวเลข");

    // เช็คว่ามีอยู่จริงไหม
    const oldZoneType = await prisma.zone_type.findUnique({ where: { id } });
    if (!oldZoneType) {
      throw notFound("ไม่พบประเภทโซน");
    }
    if (oldZoneType.deleted_at) {
      throw badRequest("ประเภทโซนถูกลบไปแล้ว");
    }

    // เช็คว่ามี zone ที่ใช้ zone_type นี้อยู่หรือไม่
    const relatedZones = await prisma.zone.count({
      where: {
        zone_type_id: id,
        deleted_at: null,
      },
    });
    if (relatedZones > 0) {
      throw badRequest(`ไม่สามารถลบประเภทโซนได้ เนื่องจากมี Zone ที่เชื่อมโยงอยู่ ${relatedZones} รายการ`);
    }

    // ทำ soft delete
    await prisma.zone_type.update({
      where: { id },
      data: {
        deleted_at: new Date(),
        updated_at: new Date(),
      },
    });

    return res.status(200).send({ message: "ลบข้อมูลเรียบร้อยแล้ว" });
  }
);
