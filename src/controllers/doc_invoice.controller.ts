import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";
import {
  CreateDocInvoiceBody,
  UpdateDocInvoiceBody,
} from "../types/doc_invoice";
import { formatDocInvoice } from "../utils/formatters/doc_invoice.formatter";
import { formatDocInvoiceDetail } from "../utils/formatters/doc_invoice_detail.formatter";

const docInclude = {
  invoices: {
    where: { deleted_at: null },
    orderBy: { created_at: "asc" as const },
    include: {
      items: {
        include: {
          goods_out: {
            include: { lot: true }, // ✅ เอา lot.name มาด้วย
          },
        },
      },
    },
  },
};

// CREATE doc_invoice
export const createDocInvoice = asyncHandler(
  async (req: Request<{}, {}, CreateDocInvoiceBody>, res: Response) => {
    const data = req.body;

    if (!data.id || !data.doc_invoice || !data.out_type) {
      throw badRequest("ข้อมูลไม่ครบถ้วน");
    }

    const invoiceIds = Array.isArray(data.invoice_ids) ? data.invoice_ids : [];

    // optional: ตรวจ invoice มีจริง
    if (invoiceIds.length) {
      const count = await prisma.invoice.count({
        where: { id: { in: invoiceIds }, deleted_at: null },
      });
      if (count !== invoiceIds.length)
        throw badRequest("invoice_ids บางตัวไม่ถูกต้อง");
    }

    const doc = await prisma.doc_invoice.create({
      data: {
        id: data.id.trim(),
        doc_barcode: data.doc_barcode ? data.doc_barcode.trim() : null,
        doc_invoice: data.doc_invoice.trim(),
        out_type: data.out_type.trim(),

        ...(invoiceIds.length
          ? {
              invoices: {
                connect: invoiceIds.map((id) => ({ id })),
              },
            }
          : {}),
      },
      include: docInclude,
    });

    return res.status(201).json(formatDocInvoice(doc));
  },
);

// GET ALL doc_invoice
export const getDocInvoices = asyncHandler(
  async (req: Request, res: Response) => {
    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

    const baseWhere: Prisma.doc_invoiceWhereInput = { deleted_at: null };
    let where: Prisma.doc_invoiceWhereInput = baseWhere;

    if (search) {
      const searchCondition: Prisma.doc_invoiceWhereInput = {
        OR: [
          { id: { contains: search, mode: "insensitive" } },
          { doc_invoice: { contains: search, mode: "insensitive" } },
          { out_type: { contains: search, mode: "insensitive" } },
        ],
      };
      where = { AND: [baseWhere, searchCondition] };
    }

    const docs = await prisma.doc_invoice.findMany({
      where,
      orderBy: { created_at: "desc" },
      include: docInclude,
    });

    return res.json(docs.map(formatDocInvoice));
  },
);

// GET doc_invoice (paginated)
export const getDocInvoicesPaginated = asyncHandler(
  async (req: Request, res: Response) => {
    const page = Number(req.query.page) || 1;
    const limit =
      req.query.limit !== undefined ? Number(req.query.limit) || 10 : 10;

    if (isNaN(page) || page < 1)
      throw badRequest("page ต้องเป็นตัวเลขบวกที่มีค่ามากกว่า 0");

    const skip = (page - 1) * limit;

    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

    const baseWhere: Prisma.doc_invoiceWhereInput = { deleted_at: null };
    let where: Prisma.doc_invoiceWhereInput = baseWhere;

    if (search) {
      const searchCondition: Prisma.doc_invoiceWhereInput = {
        OR: [
          { id: { contains: search, mode: "insensitive" } },
          { doc_invoice: { contains: search, mode: "insensitive" } },
          { out_type: { contains: search, mode: "insensitive" } },
        ],
      };
      where = { AND: [baseWhere, searchCondition] };
    }

    const [docs, total] = await Promise.all([
      prisma.doc_invoice.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: "desc" },
        include: docInclude,
      }),
      prisma.doc_invoice.count({ where }),
    ]);

    return res.json({
      data: docs.map(formatDocInvoice),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  },
);

// GET doc_invoice by id
export const getDocInvoiceById = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const doc = await prisma.doc_invoice.findUnique({
      where: { id },
      include: docInclude,
    });

    if (!doc) throw notFound("ไม่พบ doc_invoice");
    return res.json(formatDocInvoice(doc));
  },
);

// GET doc_invoice by doc_barcode
export const getDocInvoiceByDocBarcode = asyncHandler(
  async (req: Request<{ doc_barcode: string }>, res: Response) => {
    const doc_barcode = Array.isArray(req.params.doc_barcode)
      ? req.params.doc_barcode[0]
      : req.params.doc_barcode;

    if (!doc_barcode?.trim()) throw badRequest("doc_barcode ห้ามว่าง");

    const doc = await prisma.doc_invoice.findUnique({
      where: { doc_barcode: doc_barcode.trim() },
      include: docInclude,
    });

    if (!doc) throw notFound("ไม่พบ doc_invoice");
    if (doc.deleted_at) throw badRequest("doc_invoice ถูกลบไปแล้ว");

    return res.json(formatDocInvoiceDetail(doc));
  },
);

// UPDATE doc_invoice
export const updateDocInvoice = asyncHandler(
  async (
    req: Request<{ id: string }, {}, UpdateDocInvoiceBody>,
    res: Response,
  ) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const existing = await prisma.doc_invoice.findUnique({ where: { id } });
    if (!existing) throw notFound("ไม่พบ doc_invoice");
    if (existing.deleted_at) throw badRequest("doc_invoice ถูกลบไปแล้ว");

    const data = req.body;
    const invoiceIds = Array.isArray(data.invoice_ids) ? data.invoice_ids : [];

    // ถ้าส่ง invoice_ids มา => replace
    const doc = await prisma.doc_invoice.update({
      where: { id },
      data: {
        doc_invoice: data.doc_invoice?.trim(),
        doc_barcode: data.doc_barcode ? data.doc_barcode.trim() : null,
        out_type: data.out_type?.trim(),
        updated_at: new Date(),

        ...(data.invoice_ids !== undefined
          ? {
              invoices: {
                set: invoiceIds.map((x) => ({ id: x })),
              },
            }
          : {}),
      },
      include: docInclude,
    });

    return res.json(formatDocInvoice(doc));
  },
);

// DELETE doc_invoice (soft delete)
export const deleteDocInvoice = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const old = await prisma.doc_invoice.findUnique({ where: { id } });
    if (!old) throw notFound("ไม่พบ doc_invoice");
    if (old.deleted_at) throw badRequest("doc_invoice ถูกลบไปแล้ว");

    await prisma.doc_invoice.update({
      where: { id },
      data: { deleted_at: new Date(), updated_at: new Date() },
    });

    return res.json({ message: "ลบ doc_invoice เรียบร้อยแล้ว" });
  },
);
