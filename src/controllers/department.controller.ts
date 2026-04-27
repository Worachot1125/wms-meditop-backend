import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { Prisma } from "@prisma/client";
import {
  CreateDepartmentBody,
  UpdateDepartmentBody,
} from "../types/department";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";
import { departmentSyncService } from "../services/department.sync.service";

// Manual Sync Departments from Odoo
export const manualSyncDepartments = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = (req as any).user?.id || "manual";

    try {
      // Sync with Odoo
      const result = await departmentSyncService.syncDepartments(String(userId));

      return res.status(200).json({
        success: result.success,
        message: result.success ? "Sync departments เรียบร้อย" : "Sync departments ล้มเหลว",
        result: {
          fetched: result.recordsFetched,
          created: result.recordsCreated,
          updated: result.recordsUpdated,
          disabled: result.recordsDisabled,
          errors: result.errors.length > 0 ? result.errors : undefined,
        },
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: "Sync departments ล้มเหลว",
        error: error.message,
      });
    }
  }
);

// CREATE Department
export const createDepartment = asyncHandler(
  async (req: Request<{}, {}, CreateDepartmentBody>, res: Response) => {
    const data = req.body;
    // เช็คข้อมูลบังคับ
    if (!data.full_name || !data.short_name) {
      throw badRequest("ข้อมูลไม่ครบถ้วน");
    }

    // ใส่ทั้ง 4 fields พร้อมกัน (department_name=full_name, department_code=short_name)
    const department = await prisma.department.create({
      data: {
        department_name: data.full_name,
        department_code: data.short_name,
        full_name: data.full_name,
        short_name: data.short_name,
        remark: data.remark,
        // odoo_id จะเป็น null สำหรับ manual create
        is_active: true,
      },
    });

    const { ...safeDepartment } = department;
    return res.status(201).json(safeDepartment);
  }
);

// GET ALL Department
export const getDepartments = asyncHandler(
  async (req: Request, res: Response) => {
    // 🔎 รองรับ search จาก query string
    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

    // สร้าง where เงื่อนไขค้นหา
    const baseWhere: Prisma.departmentWhereInput = {
      deleted_at: null,
    };

    let where: Prisma.departmentWhereInput = baseWhere;
    if (search) {
      const searchCondition: Prisma.departmentWhereInput = {
        OR: [
          { department_code: { contains: search, mode: "insensitive" } },
          { department_name: { contains: search, mode: "insensitive" } },
          { remark: { contains: search, mode: "insensitive" } },
        ],
      };
      where = { AND: [baseWhere, searchCondition] };
    }

    const department = await prisma.department.findMany({
      where,
      orderBy: { odoo_id: "asc" },
    });

    return res.json(department);
  }
);

// GET Departments (WITH PAGINATION)
export const getDepartmentsPaginated = asyncHandler(
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
    const baseWhere: Prisma.departmentWhereInput = {
      deleted_at: null,
    };

    let where: Prisma.departmentWhereInput = baseWhere;
    if (search) {
      const searchCondition: Prisma.departmentWhereInput = {
        OR: [
          { department_code: { contains: search, mode: "insensitive" } },
          { department_name: { contains: search, mode: "insensitive" } },
          { remark: { contains: search, mode: "insensitive" } },
        ],
      };
      where = { AND: [baseWhere, searchCondition] };
    }

    const [department, total] = await Promise.all([
      prisma.department.findMany({
        where,
        skip,
        take: limit,
        orderBy: { odoo_id: "asc" },
      }),
      prisma.department.count({ where }),
    ]);

    const safeDepartment = department.map((d) => d);

    return res.json({
      data: safeDepartment,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  }
);

// GET Department BY ID
export const getDepartmentById = asyncHandler(
  async (req: Request, res: Response) => {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(idParam);
    
    if (isNaN(id)) {
      throw badRequest("ID ต้องเป็นตัวเลข");
    }

    const department = await prisma.department.findUnique({ where: { id } });
    if (!department) {
      throw notFound("ไม่พบแผนก");
    }

    return res.json(department);
  }
);

// UPDATE Department
export const updateDepartment = asyncHandler(
  async (
    req: Request<{ id: string }, {}, UpdateDepartmentBody>,
    res: Response
  ) => {
    // 🆕 soft deleted check
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(idParam);
    
    if (isNaN(id)) {
      throw badRequest("ID ต้องเป็นตัวเลข");
    }

    // 🆕 soft deleted check
    const existingDepartment = await prisma.department.findUnique({
      where: { id },
    });
    if (!existingDepartment) {
      throw notFound("ไม่พบแผนก");
    }
    if (existingDepartment.deleted_at) {
      throw badRequest("แผนกถูกลบไปแล้ว");
    }

    const data = req.body;
    // อัพเดททั้ง 4 fields พร้อมกัน
    const department = await prisma.department.update({
      where: { id },
      data: {
        department_code: data.department_code,
        department_name: data.full_name,
        full_name: data.full_name,
        short_name: data.short_name,
        remark: data.remark,
        updated_at: new Date(),
      },
    });

    return res.json(department);
  }
);

// DELETE Department
export const deleteDepartment = asyncHandler(
  async (req: Request, res: Response) => {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(idParam);
    
    if (isNaN(id)) {
      throw badRequest("ID ต้องเป็นตัวเลข");
    }

    // เช็คว่ามีอยู่จริงไหม
    const oldDepartment = await prisma.department.findUnique({ where: { id } });
    if (!oldDepartment) {
      throw notFound("ไม่พบแผนก");
    }

    // ทำ soft delete (เดิม)
    await prisma.department.update({
      where: { id },
      data: {
        deleted_at: new Date(),
        updated_at: new Date(),
      },
    });

    return res.status(200).send({ message: "ลบข้อมูลเรียบร้อยแล้ว" });
  }
);
