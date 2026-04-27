import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { Prisma } from "@prisma/client";
import {
  CreateLotBody,
  UpdateLotBody,
} from "../types/lot";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";

// CREATE Lot
export const createLot = asyncHandler(
  async (req: Request<{}, {}, CreateLotBody>, res: Response) => {
    const data = req.body;
    // เช็คข้อมูลบังคับ
    if (!data.no) {
      throw badRequest("ข้อมูลไม่ครบถ้วน");
    }

    const lot = await prisma.lot.create({
      data: {
        ...data,
      },
    });

    const { ...safeLot } = lot;
    return res.status(201).json(safeLot);
  }
);

// GET ALL Lot
export const getLots = asyncHandler(
  async (req: Request, res: Response) => {
    // 🔎 รองรับ search จาก query string
    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

    // สร้าง where เงื่อนไขค้นหา
    const baseWhere: Prisma.lotWhereInput = {
      deleted_at: null,
    };

    let where: Prisma.lotWhereInput = baseWhere;
    if (search) {
      const searchCondition: Prisma.lotWhereInput = {
        OR: [
          {no: { contains: search, mode: "insensitive" } },
          { name: { contains: search, mode: "insensitive" } },
        ],
      };
      where = { AND: [baseWhere, searchCondition] };
    }

    const lot = await prisma.lot.findMany({
      where,
      orderBy: { no: "asc" },
    });

    return res.json(lot);
  }
);

// GET Lots (WITH PAGINATION)
export const getLotsPaginated = asyncHandler(
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
    const baseWhere: Prisma.lotWhereInput = {
      deleted_at: null,
    };

    let where: Prisma.lotWhereInput = baseWhere;
    if (search) {
      const searchCondition: Prisma.lotWhereInput = {
        OR: [
          { no: { contains: search, mode: "insensitive" } },
          { name: { contains: search, mode: "insensitive" } },
        ],
      };
      where = { AND: [baseWhere, searchCondition] };
    }

    const [lot, total] = await Promise.all([
      prisma.lot.findMany({
        where,
        skip,
        take: limit,
        orderBy: { no: "asc" },
      }),
      prisma.lot.count({ where }),
    ]);

    const safeLot = lot.map((b) => b);

    return res.json({
      data: safeLot,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  }
);

// GET Lot BY ID
export const getLotById = asyncHandler(
  async (req: Request, res: Response) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;

    const lot = await prisma.lot.findUnique({ where: { no } });
    if (!lot) {
      throw notFound("ไม่พบข้อมูลล็อต");
    }

    return res.json(lot);
  }
);

// UPDATE Lot
export const updateLot = asyncHandler(
  async (
    req: Request<{ no: string }, {}, UpdateLotBody>,
    res: Response
  ) => {
    // 🆕 soft deleted check
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;
    // 🆕 soft deleted check
    const existingLot = await prisma.lot.findUnique({
      where: { no },
    });
    if (!existingLot) {
      throw notFound("ไม่พบแปลง");
    }
    if (existingLot.deleted_at) {
      throw badRequest("แปลงถูกลบไปแล้ว");
    }

    const data = req.body;
    const lot = await prisma.lot.update({
      where: { no },
      data: {
        ...data,
        updated_at: new Date(),
      },
    });

    return res.json(lot);
  }
);

// DELETE Lot
export const deleteLot = asyncHandler(
  async (req: Request, res: Response) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;

    // เช็คว่ามีอยู่จริงไหม
    const oldLot = await prisma.lot.findUnique({ where: { no } });
    if (!oldLot) {
      throw notFound("ไม่พบแปลง");
    }

    // ทำ soft delete (เดิม)
    await prisma.lot.update({
      where: { no },
      data: {
        deleted_at: new Date(),
        updated_at: new Date(),
      },
    });

    return res.status(200).send({ message: "ลบข้อมูลเรียบร้อยแล้ว" });
  }
);
