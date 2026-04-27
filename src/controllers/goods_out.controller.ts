import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";
import { CreateGoodsOutBody, UpdateGoodsOutBody } from "../types/goods_out";
import { formatGoodsOut } from "../utils/formatters/goods_out.formatter";

function normalizeBoxIds(input?: unknown): number[] {
  if (!Array.isArray(input)) return [];
  const ids = input
    .map((x) => parseInt(String(x).trim(), 10))
    .filter((n) => !isNaN(n));
  return Array.from(new Set(ids));
}

const goodsOutInclude = {
  lot: true,
  boxes: {
    include: { box: true }, // goods_out_box -> box
  },
};

// CREATE Goods Out
export const createGoodsOut = asyncHandler(
  async (req: Request<{}, {}, CreateGoodsOutBody>, res: Response) => {
    const data = req.body;

    if (
      !data.id ||
      !data.sku ||
      !data.name ||
      !data.lock_no ||
      !data.lock_name ||
      !data.lot_no ||
      !data.barcode
    ) {
      throw badRequest("ข้อมูลไม่ครบถ้วน");
    }

    const boxIds = normalizeBoxIds((data as any).box_ids);

    // (optional) ถ้าคุณต้องการเช็คว่า box มีจริงก่อน
    if (boxIds.length) {
      const count = await prisma.box.count({
        where: { id: { in: boxIds } },
      });
      if (count !== boxIds.length)
        throw badRequest("มี box_id บางตัวไม่ถูกต้อง");
    }

    const lot = await prisma.lot.findUnique({ where: { no: data.lot_no } });
    if (!lot) throw badRequest("ไม่พบ lot_no นี้ในระบบ");

    const goodsOut = await prisma.goods_out.create({
      data: {
        id: data.id,
        sku: data.sku,
        name: data.name,
        lock_no: data.lock_no,
        lock_name: data.lock_name,
        lot_no: data.lot_no,
        barcode: data.barcode,
        // ✅ connect ผ่านตารางกลาง
        ...(boxIds.length
          ? {
              boxes: {
                create: boxIds.map((box_id) => ({
                  box: { connect: { id: box_id } },
                })),
              },
            }
          : {}),
      },
      include: goodsOutInclude,
    });

    return res.status(201).json(formatGoodsOut(goodsOut));
  },
);

// GET ALL Goods Out (search + include boxes)
export const getGoodsOut = asyncHandler(async (req: Request, res: Response) => {
  const rawSearch = req.query.search;
  const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

  const baseWhere: Prisma.goods_outWhereInput = { deleted_at: null };
  let where: Prisma.goods_outWhereInput = baseWhere;

  if (search) {
    const searchCondition: Prisma.goods_outWhereInput = {
      OR: [
        { id: { contains: search, mode: "insensitive" } },
        { sku: { contains: search, mode: "insensitive" } },
        { name: { contains: search, mode: "insensitive" } },
        { lock_no: { contains: search, mode: "insensitive" } },
        { lock_name: { contains: search, mode: "insensitive" } },
        { lot_no: { contains: search, mode: "insensitive" } },
        { barcode: { contains: search, mode: "insensitive" } },
      ],
    };
    where = { AND: [baseWhere, searchCondition] };
  }

  const goodsOut = await prisma.goods_out.findMany({
    where,
    orderBy: { id: "asc" },
    include: goodsOutInclude,
  });

  return res.json(goodsOut.map(formatGoodsOut));
});

// GET Goods Out (WITH PAGINATION)
export const getGoodsOutPaginated = asyncHandler(
  async (req: Request, res: Response) => {
    const page = Number(req.query.page) || 1;
    const limit =
      req.query.limit !== undefined ? Number(req.query.limit) || 10 : 10;

    if (isNaN(page) || page < 1) {
      throw badRequest("page ต้องเป็นตัวเลขบวกที่มีค่ามากกว่า 0");
    }

    const skip = (page - 1) * limit;

    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

    const baseWhere: Prisma.goods_outWhereInput = { deleted_at: null };
    let where: Prisma.goods_outWhereInput = baseWhere;

    if (search) {
      const searchCondition: Prisma.goods_outWhereInput = {
        OR: [
          { id: { contains: search, mode: "insensitive" } },
          { sku: { contains: search, mode: "insensitive" } },
          { name: { contains: search, mode: "insensitive" } },
          { lock_no: { contains: search, mode: "insensitive" } },
          { lock_name: { contains: search, mode: "insensitive" } },
          { lot_no: { contains: search, mode: "insensitive" } },
          { barcode: { contains: search, mode: "insensitive" } },
        ],
      };
      where = { AND: [baseWhere, searchCondition] };
    }

    const [goodsOut, total] = await Promise.all([
      prisma.goods_out.findMany({
        where,
        skip,
        take: limit,
        orderBy: { id: "asc" },
        include: goodsOutInclude,
      }),
      prisma.goods_out.count({ where }),
    ]);

    return res.json({
      data: goodsOut.map(formatGoodsOut),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  },
);

// GET Goods Out BY ID
export const getGoodsOutById = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const goodsOut = await prisma.goods_out.findUnique({
      where: { id },
      include: goodsOutInclude,
    });

    if (!goodsOut) throw notFound("ไม่พบ goods_out");
    return res.json(formatGoodsOut(goodsOut));
  },
);

// UPDATE Goods Out (replace box_ids set)
export const updateGoodsOut = asyncHandler(
  async (
    req: Request<{ id: string }, {}, UpdateGoodsOutBody>,
    res: Response,
  ) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const existing = await prisma.goods_out.findUnique({ where: { id } });
    if (!existing) throw notFound("ไม่พบ goods_out");
    if (existing.deleted_at) throw badRequest("goods_out ถูกลบไปแล้ว");

    const data = req.body;

    // ✅ เช็ค lot เฉพาะตอนส่ง lot_no มา
    if (data.lot_no !== undefined) {
      if (!data.lot_no?.trim()) throw badRequest("lot_no ห้ามว่าง");
      const lot = await prisma.lot.findUnique({ where: { no: data.lot_no } });
      if (!lot || lot.deleted_at) throw badRequest("ไม่พบ lot_no นี้ในระบบ");
    }

    const boxIds = normalizeBoxIds((data as any).box_ids);

    if (data.box_ids !== undefined && boxIds.length) {
      const count = await prisma.box.count({
        where: { id: { in: boxIds } },
      });
      if (count !== boxIds.length)
        throw badRequest("มี box_id บางตัวไม่ถูกต้อง");
    }

    // ถ้าส่ง box_ids มา -> "แทนที่ชุดเดิม"
    // ถ้าไม่ส่ง -> ไม่แตะความสัมพันธ์
    const goodsOut = await prisma.goods_out.update({
      where: { id },
      data: {
        sku: data.sku,
        name: data.name,
        lock_no: data.lock_no,
        lock_name: data.lock_name,
        lot_no: data.lot_no,
        barcode: data.barcode,
        updated_at: new Date(),

        ...(data.box_ids !== undefined
          ? {
              boxes: {
                deleteMany: {}, // replace ทั้งชุด
                ...(boxIds.length
                  ? {
                      create: boxIds.map((box_id) => ({
                        box: { connect: { id: box_id } },
                      })),
                    }
                  : {}),
              },
            }
          : {}),
      },
      include: goodsOutInclude,
    });

    return res.json(formatGoodsOut(goodsOut));
  },
);

// DELETE Goods Out (SOFT DELETE)
export const deleteGoodsOut = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const old = await prisma.goods_out.findUnique({ where: { id } });
    if (!old) throw notFound("ไม่พบ goods_out");
    if (old.deleted_at) throw badRequest("goods_out ถูกลบไปแล้ว");

    await prisma.goods_out.update({
      where: { id },
      data: { deleted_at: new Date(), updated_at: new Date() },
    });

    return res.json({ message: "ลบ goods_out เรียบร้อยแล้ว" });
  },
);
