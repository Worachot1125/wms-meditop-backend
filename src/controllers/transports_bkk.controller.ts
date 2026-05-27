import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import {
  CreateTransportBKKBody,
  UpdateTransportBKKBody,
} from "../types/transports_bkk";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";

// CREATE Transport BKK
export const createTransportBKK = asyncHandler(
  async (req: Request<{}, {}, CreateTransportBKKBody>, res: Response) => {
    const data = req.body;

    const fullName = String(data.full_name || "").trim();
    const barcodeText = String(data.barcode_text || "").trim();

    if (!fullName || !barcodeText) {
      throw badRequest("ข้อมูลไม่ครบถ้วน");
    }

    const duplicateBarcode = await prisma.transport_bkk.findFirst({
      where: {
        barcode_text: barcodeText,
        deleted_at: null,
      },
    });

    if (duplicateBarcode) {
      throw badRequest("Barcode นี้ถูกใช้ไปแล้ว");
    }

    const transport = await prisma.transport_bkk.create({
      data: {
        full_name: fullName,
        barcode_text: barcodeText,
      },
    });

    return res.status(201).json(transport);
  },
);

// GET ALL Transport BKK
export const getTransportsBKK = asyncHandler(
  async (req: Request, res: Response) => {
    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

    const baseWhere: Prisma.transport_bkkWhereInput = {
      deleted_at: null,
    };

    let where: Prisma.transport_bkkWhereInput = baseWhere;

    if (search) {
      const searchCondition: Prisma.transport_bkkWhereInput = {
        OR: [
          { full_name: { contains: search, mode: "insensitive" } },
          { barcode_text: { contains: search, mode: "insensitive" } },
        ],
      };

      where = { AND: [baseWhere, searchCondition] };
    }

    const transports = await prisma.transport_bkk.findMany({
      where,
      orderBy: { id: "asc" },
    });

    return res.json(transports);
  },
);

// GET Transport BKK WITH PAGINATION
export const getTransportsBKKPaginated = asyncHandler(
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

    const baseWhere: Prisma.transport_bkkWhereInput = {
      deleted_at: null,
    };

    let where: Prisma.transport_bkkWhereInput = baseWhere;

    if (search) {
      const searchCondition: Prisma.transport_bkkWhereInput = {
        OR: [
          { full_name: { contains: search, mode: "insensitive" } },
          { barcode_text: { contains: search, mode: "insensitive" } },
        ],
      };

      where = { AND: [baseWhere, searchCondition] };
    }

    const [transports, total] = await Promise.all([
      prisma.transport_bkk.findMany({
        where,
        skip,
        take: limit,
        orderBy: { id: "asc" },
      }),
      prisma.transport_bkk.count({ where }),
    ]);

    return res.json({
      data: transports,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  },
);

// GET Transport BKK BY ID
export const getTransportBKKById = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) throw badRequest("id ต้องเป็นตัวเลข");

    const transport = await prisma.transport_bkk.findUnique({
      where: { id },
    });

    if (!transport || transport.deleted_at) {
      throw notFound("ไม่พบข้อมูลขนส่ง กทม.");
    }

    return res.json(transport);
  },
);

// UPDATE Transport BKK
export const updateTransportBKK = asyncHandler(
  async (
    req: Request<{ id: string }, {}, UpdateTransportBKKBody>,
    res: Response,
  ) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) throw badRequest("id ต้องเป็นตัวเลข");

    const existingTransport = await prisma.transport_bkk.findUnique({
      where: { id },
    });

    if (!existingTransport) {
      throw notFound("ไม่พบข้อมูลขนส่ง กทม.");
    }

    if (existingTransport.deleted_at) {
      throw badRequest("ข้อมูลขนส่ง กทม. ถูกลบไปแล้ว");
    }

    const data = req.body;

    const fullName =
      data.full_name !== undefined ? String(data.full_name).trim() : undefined;

    const barcodeText =
      data.barcode_text !== undefined
        ? String(data.barcode_text).trim()
        : undefined;

    if (data.full_name !== undefined && !fullName) {
      throw badRequest("full_name ห้ามเป็นค่าว่าง");
    }

    if (data.barcode_text !== undefined && !barcodeText) {
      throw badRequest("barcode_text ห้ามเป็นค่าว่าง");
    }

    if (barcodeText && barcodeText !== existingTransport.barcode_text) {
      const duplicateBarcode = await prisma.transport_bkk.findFirst({
        where: {
          barcode_text: barcodeText,
          deleted_at: null,
          id: { not: id },
        },
      });

      if (duplicateBarcode) {
        throw badRequest("Barcode นี้ถูกใช้ไปแล้ว");
      }
    }

    const transport = await prisma.transport_bkk.update({
      where: { id },
      data: {
        ...(fullName !== undefined ? { full_name: fullName } : {}),
        ...(barcodeText !== undefined ? { barcode_text: barcodeText } : {}),
        updated_at: new Date(),
      },
    });

    return res.json(transport);
  },
);

// DELETE Transport BKK
export const deleteTransportBKK = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) throw badRequest("id ต้องเป็นตัวเลข");

    const oldTransport = await prisma.transport_bkk.findUnique({
      where: { id },
    });

    if (!oldTransport) {
      throw notFound("ไม่พบข้อมูลขนส่ง กทม.");
    }

    if (oldTransport.deleted_at) {
      throw badRequest("ข้อมูลขนส่ง กทม. นี้ถูกลบไปแล้ว");
    }

    const deletedTransport = await prisma.transport_bkk.update({
      where: { id },
      data: {
        deleted_at: new Date(),
        updated_at: new Date(),
      },
    });

    return res.json(deletedTransport);
  },
);