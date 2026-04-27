import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { Prisma } from "@prisma/client";
import {
  CreateBuildingBody,
  UpdateBuildingBody,
} from "../types/building";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";

// CREATE Building
export const createBuilding = asyncHandler(
  async (req: Request<{}, {}, CreateBuildingBody>, res: Response) => {
    const data = req.body;
    // เช็คข้อมูลบังคับ
    if (!data.full_name || !data.short_name) {
      throw badRequest("ข้อมูลไม่ครบถ้วน");
    }

    // เช็ค short_name ซ้ำ (ไม่รวมรายการที่ถูกลบ)
    const existingShortName = await prisma.building.findFirst({
      where: {
        short_name: data.short_name,
        deleted_at: null,
      },
    });
    if (existingShortName) {
      throw badRequest("Short Name นี้ถูกใช้ไปแล้ว");
    }

    const building = await prisma.building.create({
      data: {
        ...data,
      },
    });

    const { ...safeBuilding } = building;
    return res.status(201).json(safeBuilding);
  }
);

// GET ALL Building
export const getBuildings = asyncHandler(
  async (req: Request, res: Response) => {
    // 🔎 รองรับ search จาก query string
    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

    // สร้าง where เงื่อนไขค้นหา
    const baseWhere: Prisma.buildingWhereInput = {
      deleted_at: null,
    };

    let where: Prisma.buildingWhereInput = baseWhere;
    if (search) {
      const searchCondition: Prisma.buildingWhereInput = {
        OR: [
          { building_code: { contains: search, mode: "insensitive" } },
          { full_name: { contains: search, mode: "insensitive" } },
          { short_name: { contains: search, mode: "insensitive" } },
          { remark: { contains: search, mode: "insensitive" } },
        ],
      };
      where = { AND: [baseWhere, searchCondition] };
    }

    const building = await prisma.building.findMany({
      where,
      orderBy: { id: "asc" },
    });

    return res.json(building);
  }
);

// GET Buildings (WITH PAGINATION)
export const getBuildingsPaginated = asyncHandler(
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
    const baseWhere: Prisma.buildingWhereInput = {
      deleted_at: null,
    };

    let where: Prisma.buildingWhereInput = baseWhere;
    if (search) {
      const searchCondition: Prisma.buildingWhereInput = {
        OR: [
          { building_code: { contains: search, mode: "insensitive" } },
          { full_name: { contains: search, mode: "insensitive" } },
          { short_name: { contains: search, mode: "insensitive" } },
          { remark: { contains: search, mode: "insensitive" } },
        ],
      };
      where = { AND: [baseWhere, searchCondition] };
    }

    const [building, total] = await Promise.all([
      prisma.building.findMany({
        where,
        skip,
        take: limit,
        orderBy: { id: "asc" },
      }),
      prisma.building.count({ where }),
    ]);

    const safeBuilding = building.map((b) => b);

    return res.json({
      data: safeBuilding,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  }
);

// GET Building BY ID
export const getBuildingById = asyncHandler(
  async (req: Request, res: Response) => {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(idParam, 10);
    if (isNaN(id)) throw badRequest("id ต้องเป็นตัวเลข");

    const building = await prisma.building.findUnique({ where: { id } });
    if (!building) {
      throw notFound("ไม่พบอาคาร");
    }

    return res.json(building);
  }
);

// UPDATE Building
export const updateBuilding = asyncHandler(
  async (
    req: Request<{ id: string }, {}, UpdateBuildingBody>,
    res: Response
  ) => {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(idParam, 10);
    if (isNaN(id)) throw badRequest("id ต้องเป็นตัวเลข");

    // 🆕 soft deleted check
    const existingBuilding = await prisma.building.findUnique({
      where: { id },
    });
    if (!existingBuilding) {
      throw notFound("ไม่พบอาคาร");
    }
    if (existingBuilding.deleted_at) {
      throw badRequest("อาคารถูกลบไปแล้ว");
    }

    const data = req.body;

    // เช็ค short_name ซ้ำ (ถ้ามีการเปลี่ยน short_name)
    if (data.short_name && data.short_name !== existingBuilding.short_name) {
      const duplicateShortName = await prisma.building.findFirst({
        where: {
          short_name: data.short_name,
          deleted_at: null,
          id: { not: id },
        },
      });
      if (duplicateShortName) {
        throw badRequest("Short Name นี้ถูกใช้ไปแล้ว");
      }
    }

    const building = await prisma.building.update({
      where: { id },
      data: {
        ...data,
        updated_at: new Date(),
      },
    });

    return res.json(building);
  }
);

// DELETE Building
export const deleteBuilding = asyncHandler(
  async (req: Request, res: Response) => {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(idParam, 10);
    if (isNaN(id)) throw badRequest("id ต้องเป็นตัวเลข");

    // เช็คว่ามีอยู่จริงไหม
    const oldBuilding = await prisma.building.findUnique({ where: { id } });
    if (!oldBuilding) {
      throw notFound("ไม่พบอาคาร");
    }

    // เช็คว่าถูกลบไปแล้วหรือยัง
    if (oldBuilding.deleted_at) {
      throw badRequest("อาคารนี้ถูกลบไปแล้ว");
    }

    // เช็คว่ามี zone ที่ใช้ building นี้อยู่หรือไม่
    const relatedZones = await prisma.zone.count({
      where: {
        building_id: id,
        deleted_at: null,
      },
    });
    if (relatedZones > 0) {
      throw badRequest(`ไม่สามารถลบอาคารได้ เนื่องจากมี Zone ที่เชื่อมโยงอยู่ ${relatedZones} รายการ`);
    }

    // เช็คว่ามี zone ที่ใช้ zone_type นี้อยู่หรือไม่
    const relatedLocations = await prisma.location.count({
      where: {
        building_id: id,
        deleted_at: null,
      },
    });
    if (relatedLocations > 0) {
      throw badRequest(`ไม่สามารถลบอาคารได้ เนื่องจากมี location ที่เชื่อมโยงอยู่ ${relatedLocations} รายการ`);
    }

    // ทำ soft delete
    await prisma.building.update({
      where: { id },
      data: {
        deleted_at: new Date(),
        updated_at: new Date(),
      },
    });

    return res.status(200).send({ message: "ลบข้อมูลเรียบร้อยแล้ว" });
  }
);
