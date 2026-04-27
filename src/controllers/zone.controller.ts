import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { CreateZoneBody, UpdateZoneBody } from "../types/zone";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";
import { formatZone } from "../utils/formatters/zone.formatter";

// CREATE Zone
export const createZone = asyncHandler(
  async (req: Request<{}, {}, CreateZoneBody>, res: Response) => {
    const data = req.body;
    // เช็คข้อมูลบังคับ
    if (
      !data.full_name ||
      !data.short_name ||
      typeof data.building_id !== 'number' ||
      typeof data.zone_type_id !== 'number'
    ) {
      throw badRequest("ข้อมูลไม่ครบถ้วน");
    }

    const zone = await prisma.zone.create({
      data: {
        ...data,
      },
    });

    const { ...safeZone } = zone;
    return res.status(201).json(safeZone);
  }
);

// GET ALL Zone
export const getZones = asyncHandler(async (req: Request, res: Response) => {
  // 🔎 รองรับ search จาก query string
  const rawSearch = req.query.search;
  const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

  // สร้าง where เงื่อนไขค้นหา
  const baseWhere: Prisma.zoneWhereInput = {
    deleted_at: null,
  };

  let where: Prisma.zoneWhereInput = baseWhere;
  if (search) {
    const searchCondition: Prisma.zoneWhereInput = {
      OR: [
        { full_name: { contains: search, mode: "insensitive" } },
        { short_name: { contains: search, mode: "insensitive" } },
        { remark: { contains: search, mode: "insensitive" } },
      ],
    };
    where = { AND: [baseWhere, searchCondition] };
  }

  const zones = await prisma.zone.findMany({
    where,
    orderBy: { id: "asc" },
    include: {
      building: true,
      zone_type: true,
    },
  });

  return res.json(zones.map(formatZone));
});

// GET Zones (WITH PAGINATION)
export const getZonesPaginated = asyncHandler(
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
    const baseWhere: Prisma.zoneWhereInput = {
      deleted_at: null,
    };

    let where: Prisma.zoneWhereInput = baseWhere;
    if (search) {
      const searchCondition: Prisma.zoneWhereInput = {
        OR: [
          { full_name: { contains: search, mode: "insensitive" } },
          { short_name: { contains: search, mode: "insensitive" } },
          { remark: { contains: search, mode: "insensitive" } },
        ],
      };
      where = { AND: [baseWhere, searchCondition] };
    }

    const [zones, total] = await Promise.all([
      prisma.zone.findMany({
        where,
        skip,
        take: limit,
        orderBy: { id: "asc" },
        include: {
          building: true,
          zone_type: true,
        },
      }),
      prisma.zone.count({ where }),
    ]);

    return res.json({
      data: zones.map(formatZone),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  }
);

// GET Zone BY ID
export const getZoneById = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(idParam, 10);
    if (isNaN(id)) throw badRequest("id ต้องเป็นตัวเลข");

    const zone = await prisma.zone.findUnique({
      where: { id },
      include: {
        building: true,
        zone_type: true,
      },
    });
    if (!zone) throw notFound("ไม่พบโซน");
    return res.json(formatZone(zone));
  }
);

// UPDATE Zone
export const updateZone = asyncHandler(
  async (req: Request<{ id: string }, {}, UpdateZoneBody>, res: Response) => {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(idParam, 10);
    if (isNaN(id)) throw badRequest("id ต้องเป็นตัวเลข");

    // 🆕 soft deleted check
    const existingZone = await prisma.zone.findUnique({
      where: { id },
    });
    if (!existingZone) {
      throw notFound("ไม่พบโซน");
    }
    if (existingZone.deleted_at) {
      throw badRequest("โซนถูกลบไปแล้ว");
    }

    const data = req.body;


    const zone = await prisma.zone.update({
      where: { id },
      data: {
        ...data,
        updated_at: new Date(),
      },
    });

    return res.json(zone);
  }
);

// DELETE Zone
export const deleteZone = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(idParam, 10);
    if (isNaN(id)) throw badRequest("id ต้องเป็นตัวเลข");

    const old = await prisma.zone.findUnique({ where: { id } });
    if (!old) throw notFound("ไม่พบโซน");
    if (old.deleted_at) throw badRequest("โซนถูกลบไปแล้ว");

    // เช็คว่ามี zone ที่ใช้ zone_type นี้อยู่หรือไม่
    const relatedLocations = await prisma.location.count({
      where: {
        zone_id: id,
        deleted_at: null,
      },
    });
    if (relatedLocations > 0) {
      throw badRequest(`ไม่สามารถลบประเภทอาคารได้ เนื่องจากมี location ที่เชื่อมโยงอยู่ ${relatedLocations} รายการ`);
    }


    await prisma.zone.update({
      where: { id },
      data: { deleted_at: new Date(), updated_at: new Date() },
    });

    return res.json({ message: "ลบโซนเรียบร้อยแล้ว" });
  }
);
