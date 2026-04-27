import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { CreateBoxBody, UpdateBoxBody } from "../types/box";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";

// CREATE Box
export const createBox = asyncHandler(
  async (req: Request<{}, {}, CreateBoxBody>, res: Response) => {
    const data = req.body;

    const box = await prisma.box.create({
      data: {
        ...data,
      },
    });

    const { ...safeBox } = box;
    return res.status(201).json(safeBox);
  },
);

// GET ALL Box
export const getBoxes = asyncHandler(async (req: Request, res: Response) => {
  // 🔎 รองรับ search จาก query string
  const rawSearch = req.query.search;
  const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

  // สร้าง where เงื่อนไขค้นหา
  const baseWhere: Prisma.boxWhereInput = {
    deleted_at: null,
  };

  let where: Prisma.boxWhereInput = baseWhere;
  if (search) {
    const searchConditions: Prisma.boxWhereInput[] = [
      { box_name: { contains: search, mode: "insensitive" } },
      { box_code: { contains: search, mode: "insensitive" } },
    ];
    
    // ถ้า search เป็นตัวเลข ให้เพิ่มการค้นหา id
    const searchNum = parseInt(search, 10);
    if (!isNaN(searchNum)) {
      searchConditions.push({ id: searchNum });
    }
    
    const searchCondition: Prisma.boxWhereInput = { OR: searchConditions };
    where = { AND: [baseWhere, searchCondition] };
  }

  const box = await prisma.box.findMany({
    where,
    orderBy: { id: "asc" },
  });

  return res.json(box);
});

// GET Boxes (WITH PAGINATION)
export const getBoxesPaginated = asyncHandler(
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
    const baseWhere: Prisma.boxWhereInput = {
      deleted_at: null,
    };

    let where: Prisma.boxWhereInput = baseWhere;
    if (search) {
      const searchConditions: Prisma.boxWhereInput[] = [
        { box_name: { contains: search, mode: "insensitive" } },
        { box_code: { contains: search, mode: "insensitive" } },
      ];
      
      // ถ้า search เป็นตัวเลข ให้เพิ่มการค้นหา id
      const searchNum = parseInt(search, 10);
      if (!isNaN(searchNum)) {
        searchConditions.push({ id: searchNum });
      }
      
      const searchCondition: Prisma.boxWhereInput = { OR: searchConditions };
      where = { AND: [baseWhere, searchCondition] };
    }

    const [box, total] = await Promise.all([
      prisma.box.findMany({
        where,
        skip,
        take: limit,
        orderBy: { id: "asc" },
      }),
      prisma.box.count({ where }),
    ]);

    const safeBox = box.map((b) => b);

    return res.json({
      data: safeBox,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  },
);

// GET Box BY ID
export const getBoxById = asyncHandler(async (req: Request, res: Response) => {
  const idStr = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(idStr, 10);
  
  if (isNaN(id)) {
    throw badRequest("id ต้องเป็นตัวเลข");
  }

  const box = await prisma.box.findUnique({ where: { id } });
  if (!box) {
    throw notFound("ไม่พบข้อมูลกล่อง");
  }

  return res.json(box);
});

// GET Box BY BOX_CODE
export const getBoxByCode = asyncHandler(async (req: Request, res: Response) => {
  const code = Array.isArray(req.params.code) ? req.params.code[0] : req.params.code;

  const box = await prisma.box.findUnique({ 
    where: { box_code: code },
  });
  
  if (!box || box.deleted_at) {
    throw notFound("ไม่พบข้อมูลกล่อง");
  }

  return res.json(box);
});

// UPDATE Box
export const updateBox = asyncHandler(
  async (req: Request<{ id: string }, {}, UpdateBoxBody>, res: Response) => {
    const idStr = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(idStr, 10);
    
    if (isNaN(id)) {
      throw badRequest("id ต้องเป็นตัวเลข");
    }
    
    const existingBox = await prisma.box.findUnique({
      where: { id },
    });
    if (!existingBox) {
      throw notFound("ไม่พบกล่อง");
    }
    if (existingBox.deleted_at) {
      throw badRequest("กล่องถูกลบไปแล้ว");
    }

    const data = req.body;
    const box = await prisma.box.update({
      where: { id },
      data: {
        ...data,
        updated_at: new Date(),
      },
    });

    return res.json(box);
  },
);

// DELETE Box
export const deleteBox = asyncHandler(async (req: Request, res: Response) => {
  const idStr = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(idStr, 10);
  
  if (isNaN(id)) {
    throw badRequest("id ต้องเป็นตัวเลข");
  }

  // เช็คว่ามีอยู่จริงไหม
  const oldBox = await prisma.box.findUnique({ where: { id } });
  if (!oldBox) {
    throw notFound("ไม่พบกล่อง");
  }

  // Hard delete
  await prisma.box.delete({
    where: { id },
  });

  return res.status(200).send({ message: "ลบข้อมูลเรียบร้อยแล้ว" });
});
