import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";
import {
  formatOdooSwap,
  buildGoodsInExpMapForSwapItems,
} from "../utils/formatters/swap.formatter";
import {
  AuthRequest,
  buildLocalDepartmentAccessWhere,
} from "../middleware/auth";

export const getSwaps = asyncHandler(async (req: Request, res: Response) => {
  const swaps = await prisma.swap.findMany({
    where: {
      deleted_at: null,
      picking_id: { not: null },
    },
    include: {
      swapItems: {
        where: { deleted_at: null },
        orderBy: { id: "asc" },
      },
    },
    orderBy: { created_at: "desc" },
  });

  const deptIds = Array.from(
    new Set(
      swaps.map((s) => s.department_id).filter((x): x is number => x != null),
    ),
  );

  const departments =
    deptIds.length > 0
      ? await prisma.department.findMany({
          where: {
            odoo_id: { in: deptIds },
          },
          select: {
            odoo_id: true,
            short_name: true,
          },
        })
      : [];

  const deptMap = new Map(departments.map((d) => [d.odoo_id, d.short_name]));

  const swapItems = swaps.flatMap((doc) => doc.swapItems ?? []);

  const goodsInExpMap = await buildGoodsInExpMapForSwapItems(
    swapItems.map((item) => ({
      product_id: item.product_id ?? null,
      lot_id: item.lot_id ?? null,
    })),
  );

  const data = swaps.map((doc) =>
    formatOdooSwap(
      {
        ...doc,
        department: doc.department_id
          ? { short_name: deptMap.get(doc.department_id) ?? null }
          : null,
      } as any,
      goodsInExpMap,
    ),
  );

  return res.json({
    total: data.length,
    data,
  });
});

export const getSwapByNo = asyncHandler(
  async (req: Request<{ no: string }>, res: Response) => {
    const rawNo = Array.isArray(req.params.no)
      ? req.params.no[0]
      : req.params.no;

    if (!rawNo) throw badRequest("กรุณาระบุเลข no");

    const no = decodeURIComponent(rawNo);

    const doc = await prisma.swap.findFirst({
      where: {
        no,
        deleted_at: null,
      },
      include: {
        swapItems: {
          where: { deleted_at: null },
          orderBy: { id: "asc" },
        },
      },
    });

    if (!doc) throw notFound(`ไม่พบ Swap no: ${no}`);

    let department: { short_name: string | null } | null = null;

    if (doc.department_id) {
      const dep = await prisma.department.findFirst({
        where: { odoo_id: doc.department_id },
        select: { short_name: true },
      });

      department = dep ? { short_name: dep.short_name } : null;
    }

    const goodsInExpMap = await buildGoodsInExpMapForSwapItems(
      (doc.swapItems ?? []).map((item) => ({
        product_id: item.product_id ?? null,
        lot_id: item.lot_id ?? null,
      })),
    );

    return res.json(
      formatOdooSwap(
        {
          ...doc,
          department,
        } as any,
        goodsInExpMap,
      ),
    );
  },
);

export const getSwapsPaginated = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const page = Number(req.query.page) || 1;
    const limit =
      req.query.limit !== undefined ? Number(req.query.limit) || 10 : 10;

    if (Number.isNaN(page) || page < 1) {
      throw badRequest("page ต้องเป็นตัวเลขบวกที่มากกว่า 0");
    }

    if (Number.isNaN(limit) || limit < 1) {
      throw badRequest("limit ต้องเป็นตัวเลขบวกที่มากกว่า 0");
    }

    const search =
      typeof req.query.search === "string" ? req.query.search.trim() : "";

    const skip = (page - 1) * limit;

    const departmentWhere = buildLocalDepartmentAccessWhere(req);

    const where: Prisma.swapWhereInput = {
      deleted_at: null,
      ...departmentWhere,
      ...(search
        ? {
            OR: [
              { no: { contains: search, mode: "insensitive" } },
              { name: { contains: search, mode: "insensitive" } },
              { location_name: { contains: search, mode: "insensitive" } },
              { location_dest_name: { contains: search, mode: "insensitive" } },
              { source_location: { contains: search, mode: "insensitive" } },
              { dest_location: { contains: search, mode: "insensitive" } },
              { status: { contains: search, mode: "insensitive" } },
              { origin: { contains: search, mode: "insensitive" } },
              { reference: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.swap.findMany({
        where,
        include: {
          swapItems: {
            where: { deleted_at: null },
            orderBy: { id: "asc" },
          },
        },
        orderBy: { created_at: "desc" },
        skip,
        take: limit,
      }),
      prisma.swap.count({ where }),
    ]);

    // swap.department_id = Odoo Department ID
    const deptOdooIds = Array.from(
      new Set(
        rows
          .map((s) => s.department_id)
          .filter((x): x is number => typeof x === "number"),
      ),
    );

    const departments =
      deptOdooIds.length > 0
        ? await prisma.department.findMany({
            where: {
              odoo_id: { in: deptOdooIds },
              deleted_at: null,
            },
            select: {
              odoo_id: true,
              short_name: true,
            },
          })
        : [];

    const deptMap = new Map<number, string | null>(
      departments.map((d) => [Number(d.odoo_id), d.short_name ?? null]),
    );

    const swapItems = rows.flatMap((doc) => doc.swapItems ?? []);

    const goodsInExpMap = await buildGoodsInExpMapForSwapItems(
      swapItems.map((item) => ({
        product_id: item.product_id ?? null,
        lot_id: item.lot_id ?? null,
      })),
    );

    return res.json({
      data: rows.map((doc) =>
        formatOdooSwap(
          {
            ...doc,
            department: {
              short_name:
                doc.department_id != null
                  ? (deptMap.get(Number(doc.department_id)) ?? null)
                  : null,
            },
          } as any,
          goodsInExpMap,
        ),
      ),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  },
);
