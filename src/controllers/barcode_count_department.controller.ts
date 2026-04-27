import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { Prisma } from "@prisma/client";
import {
  CreateBarcodeCountDepartmentBody,
  UpdateBarcodeCountDepartmentBody,
} from "../types/barcode_count_department";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";

/**
 * CREATE Barcode Count Department
 */
export const createBarcodeCountDepartment = asyncHandler(
  async (req: Request<{}, {}, CreateBarcodeCountDepartmentBody>, res: Response) => {
    const data = req.body;

    // optional: normalize empty string -> null
    const department_code =
      data.department_code !== undefined
        ? (String(data.department_code ?? "").trim() || null)
        : undefined;

    const barcode_count =
      data.barcode_count !== undefined
        ? (String(data.barcode_count ?? "").trim() || null)
        : undefined;

    const created = await prisma.barcode_count_department.create({
      data: {
        department_code: department_code ?? null,
        barcode_count: barcode_count ?? null,
      },
    });

    return res.status(201).json({
      message: "สร้าง barcode_count_department สำเร็จ",
      data: created,
    });
  },
);

/**
 * GET ALL Barcode Count Departments (รองรับ search)
 * GET /api/barcode-count-departments?search=xxx
 */
export const getBarcodeCountDepartments = asyncHandler(
  async (req: Request, res: Response) => {
    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

    const where: Prisma.barcode_count_departmentWhereInput = search
      ? {
          OR: [
            { department_code: { contains: search, mode: "insensitive" } },
            { barcode_count: { contains: search, mode: "insensitive" } },
          ],
        }
      : {};

    const rows = await prisma.barcode_count_department.findMany({
      where,
      orderBy: { id: "desc" },
    });

    return res.json({
      total: rows.length,
      data: rows,
    });
  },
);

/**
 * GET Paginated
 * GET /api/barcode-count-departments/paginated?page=1&limit=10&search=xxx
 */
export const getBarcodeCountDepartmentsPaginated = asyncHandler(
  async (req: Request, res: Response) => {
    const page = Number(req.query.page) || 1;
    const limit = req.query.limit !== undefined ? Number(req.query.limit) || 10 : 10;

    if (isNaN(page) || page < 1) throw badRequest("page ต้องเป็นตัวเลขบวกที่มีค่ามากกว่า 0");
    if (isNaN(limit) || limit < 1) throw badRequest("limit ต้องเป็นตัวเลขบวกที่มีค่ามากกว่า 0");

    const skip = (page - 1) * limit;

    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

    const where: Prisma.barcode_count_departmentWhereInput = search
      ? {
          OR: [
            { department_code: { contains: search, mode: "insensitive" } },
            { barcode_count: { contains: search, mode: "insensitive" } },
          ],
        }
      : {};

    const [rows, total] = await Promise.all([
      prisma.barcode_count_department.findMany({
        where,
        skip,
        take: limit,
        orderBy: { id: "desc" },
      }),
      prisma.barcode_count_department.count({ where }),
    ]);

    return res.json({
      data: rows,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  },
);

/**
 * GET BY ID
 */
export const getBarcodeCountDepartmentById = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(idParam, 10);
    if (isNaN(id)) throw badRequest("ID ต้องเป็นตัวเลข");

    const row = await prisma.barcode_count_department.findUnique({ where: { id } });
    if (!row) throw notFound("ไม่พบข้อมูล");

    return res.json(row);
  },
);

/**
 * UPDATE
 */
export const updateBarcodeCountDepartment = asyncHandler(
  async (req: Request<{ id: string }, {}, UpdateBarcodeCountDepartmentBody>, res: Response) => {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(idParam, 10);
    if (isNaN(id)) throw badRequest("id ต้องเป็นตัวเลข");

    const existing = await prisma.barcode_count_department.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw notFound("ไม่พบข้อมูล");

    const data = req.body;

    const department_code =
      data.department_code !== undefined
        ? (String(data.department_code ?? "").trim() || null)
        : undefined;

    const barcode_count =
      data.barcode_count !== undefined
        ? (String(data.barcode_count ?? "").trim() || null)
        : undefined;

    const updated = await prisma.barcode_count_department.update({
      where: { id },
      data: {
        department_code: department_code ?? undefined,
        barcode_count: barcode_count ?? undefined,
      },
    });

    return res.json({
      message: "อัพเดท barcode_count_department สำเร็จ",
      data: updated,
    });
  },
);
