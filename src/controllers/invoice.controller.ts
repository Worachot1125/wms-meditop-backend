import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";
import { CreateInvoiceBody, UpdateInvoiceBody } from "../types/invoice";
import { formatInvoice } from "../utils/formatters/invoice.formatter";
import { formatInvoiceByGoodsOut } from "../utils/formatters/getInvoiceByGoodsOutId.formatter";

const invoiceInclude = {
  doc_invoice: true,
  items: {
    include: {
      goods_out: {
        include: { lot: true },
      },
    },
  },
};

// CREATE invoice
export const createInvoice = asyncHandler(
  async (req: Request<{}, {}, CreateInvoiceBody>, res: Response) => {
    const data = req.body;

    if (!data.id?.trim() || !data.no?.trim()) {
      throw badRequest("ข้อมูลไม่ครบถ้วน");
    }

    const items = Array.isArray(data.items) ? data.items : [];
    // (optional) ถ้าต้องบังคับให้มี items
    // if (!items.length) throw badRequest("ต้องมี items อย่างน้อย 1 รายการ");

    // validate items
    for (const it of items) {
      if (!it.goods_out_id?.trim())
        throw badRequest("items.goods_out_id ห้ามว่าง");
      if (
        it.quantity === undefined ||
        it.pick === undefined ||
        it.pack === undefined
      ) {
        throw badRequest("items ต้องมี quantity, pick, pack");
      }
      if (
        [it.quantity, it.pick, it.pack].some(
          (n) => typeof n !== "number" || n < 0,
        )
      ) {
        throw badRequest("quantity/pick/pack ต้องเป็นตัวเลข >= 0");
      }
    }

    // กัน goods_out ซ้ำใน payload (เพราะใน DB unique(invoice_id, goods_out_id))
    const dupCheck = new Set<string>();
    for (const it of items) {
      const gid = it.goods_out_id.trim();
      if (dupCheck.has(gid)) throw badRequest("items มี goods_out_id ซ้ำ");
      dupCheck.add(gid);
    }

    // ตรวจ goods_out มีจริง (optional)
    if (items.length) {
      const ids = items.map((x) => x.goods_out_id.trim());
      const count = await prisma.goods_out.count({
        where: { id: { in: ids }, deleted_at: null },
      });
      if (count !== ids.length)
        throw badRequest("goods_out_id บางตัวไม่ถูกต้อง");
    }

    const invoice = await prisma.invoice.create({
      data: {
        id: data.id.trim(),
        no: data.no.trim(),
        doc_invoice_id: data.doc_invoice_id ?? null,
        invoice_barcode: data.invoice_barcode ?? null,

        ...(items.length
          ? {
              items: {
                create: items.map((it) => ({
                  goods_out: { connect: { id: it.goods_out_id.trim() } },
                  quantity: it.quantity,
                  pick: it.pick,
                  pack: it.pack,
                })),
              },
            }
          : {}),
      },
      include: invoiceInclude,
    });

    return res.status(201).json(formatInvoice(invoice));
  },
);

// GET ALL invoice
export const getInvoices = asyncHandler(async (req: Request, res: Response) => {
  const rawSearch = req.query.search;
  const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

  const baseWhere: Prisma.invoiceWhereInput = { deleted_at: null };
  let where: Prisma.invoiceWhereInput = baseWhere;

  if (search) {
    const searchCondition: Prisma.invoiceWhereInput = {
      OR: [
        { id: { contains: search, mode: "insensitive" } },
        { no: { contains: search, mode: "insensitive" } },
        {
          doc_invoice: {
            OR: [{ doc_invoice: { contains: search, mode: "insensitive" } }],
          },
        },
        {
          items: {
            some: {
              OR: [
                {
                  goods_out: { id: { contains: search, mode: "insensitive" } },
                },
                {
                  goods_out: { sku: { contains: search, mode: "insensitive" } },
                },
                {
                  goods_out: {
                    name: { contains: search, mode: "insensitive" },
                  },
                },
              ],
            },
          },
        },
      ],
    };
    where = { AND: [baseWhere, searchCondition] };
  }

  const invoices = await prisma.invoice.findMany({
    where,
    orderBy: { created_at: "desc" },
    include: invoiceInclude,
  });

  return res.json(invoices.map(formatInvoice));
});

// GET invoice paginated
export const getInvoicesPaginated = asyncHandler(
  async (req: Request, res: Response) => {
    const page = Number(req.query.page) || 1;
    const limit =
      req.query.limit !== undefined ? Number(req.query.limit) || 10 : 10;

    if (isNaN(page) || page < 1)
      throw badRequest("page ต้องเป็นตัวเลขบวกที่มีค่ามากกว่า 0");
    const skip = (page - 1) * limit;

    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

    const baseWhere: Prisma.invoiceWhereInput = { deleted_at: null };
    let where: Prisma.invoiceWhereInput = baseWhere;

    if (search) {
      const searchCondition: Prisma.invoiceWhereInput = {
        OR: [
          { id: { contains: search, mode: "insensitive" } },
          { no: { contains: search, mode: "insensitive" } },
          {
            doc_invoice: {
              OR: [{ doc_invoice: { contains: search, mode: "insensitive" } }],
            },
          },
          {
            items: {
              some: {
                OR: [
                  {
                    goods_out: {
                      id: { contains: search, mode: "insensitive" },
                    },
                  },
                  {
                    goods_out: {
                      sku: { contains: search, mode: "insensitive" },
                    },
                  },
                  {
                    goods_out: {
                      name: { contains: search, mode: "insensitive" },
                    },
                  },
                ],
              },
            },
          },
        ],
      };
      where = { AND: [baseWhere, searchCondition] };
    }

    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: "desc" },
        include: invoiceInclude,
      }),
      prisma.invoice.count({ where }),
    ]);

    return res.json({
      data: invoices.map(formatInvoice),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  },
);

// GET invoice by id
export const getInvoiceById = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const invoice = await prisma.invoice.findUnique({
      where: { id },
      include: invoiceInclude,
    });

    if (!invoice) throw notFound("ไม่พบ invoice");
    if (invoice.deleted_at) throw badRequest("invoice ถูกลบไปแล้ว");
    return res.json(formatInvoice(invoice));
  },
);

// GET invoice by invoice_barcode
export const getInvoiceByInvoiceBarcode = asyncHandler(
  async (req: Request<{ invoice_barcode: string }>, res: Response) => {
    const invoice_barcode = Array.isArray(req.params.invoice_barcode)
      ? req.params.invoice_barcode[0]
      : req.params.invoice_barcode;

    const invoice = await prisma.invoice.findUnique({
      where: { invoice_barcode },
      include: invoiceInclude,
    });

    if (!invoice) throw notFound("ไม่พบ invoice");
    if (invoice.deleted_at) throw badRequest("invoice ถูกลบไปแล้ว");
    return res.json(formatInvoice(invoice));
  },
);

// GET invoice by goods_out id
export const getInvoiceByGoodsOutId = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const goodsOutId = Array.isArray(req.params.id)
      ? req.params.id[0]
      : req.params.id;

    if (!goodsOutId?.trim()) throw badRequest("goods_out_id ห้ามว่าง");

    const rows = await prisma.invoice_item.findMany({
      where: {
        goods_out_id: goodsOutId,
        invoice: { deleted_at: null },
        goods_out: { deleted_at: null },
      },
      orderBy: { created_at: "desc" },
      include: {
        invoice: { include: { doc_invoice: true } },
        goods_out: { include: { lot: true } },
      },
    });

    return res.json(rows.map(formatInvoiceByGoodsOut));
  },
);

// UPDATE invoice (replace items)
export const updateInvoice = asyncHandler(
  async (
    req: Request<{ id: string }, {}, UpdateInvoiceBody>,
    res: Response,
  ) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const existing = await prisma.invoice.findUnique({ where: { id } });
    if (!existing) throw notFound("ไม่พบ invoice");
    if (existing.deleted_at) throw badRequest("invoice ถูกลบไปแล้ว");

    const data = req.body;
    const items = Array.isArray(data.items) ? data.items : undefined;

    if (items) {
      for (const it of items) {
        if (!it.goods_out_id?.trim())
          throw badRequest("items.goods_out_id ห้ามว่าง");
        const q = it.quantity ?? 0;
        const p = it.pick ?? 0;
        const k = it.pack ?? 0;
        if ([q, p, k].some((n) => typeof n !== "number" || n < 0)) {
          throw badRequest("quantity/pick/pack ต้องเป็นตัวเลข >= 0");
        }
      }

      const dup = new Set<string>();
      for (const it of items) {
        const gid = it.goods_out_id.trim();
        if (dup.has(gid)) throw badRequest("items มี goods_out_id ซ้ำ");
        dup.add(gid);
      }

      // ตรวจ goods_out มีจริง (optional)
      if (items.length) {
        const ids = items.map((x) => x.goods_out_id.trim());
        const count = await prisma.goods_out.count({
          where: { id: { in: ids }, deleted_at: null },
        });
        if (count !== ids.length)
          throw badRequest("goods_out_id บางตัวไม่ถูกต้อง");
      }
    }

    const invoice = await prisma.invoice.update({
      where: { id },
      data: {
        no: data.no?.trim(),
        doc_invoice_id:
          data.doc_invoice_id === undefined ? undefined : data.doc_invoice_id,
        invoice_barcode:
          data.invoice_barcode === undefined ? undefined : data.invoice_barcode,
        updated_at: new Date(),

        ...(items !== undefined
          ? {
              items: {
                deleteMany: {}, // ลบของเดิมทั้งหมด
                create: items.map((it) => ({
                  goods_out: { connect: { id: it.goods_out_id.trim() } },
                  quantity: it.quantity ?? 0,
                  pick: it.pick ?? 0,
                  pack: it.pack ?? 0,
                })),
              },
            }
          : {}),
      },
      include: invoiceInclude,
    });

    return res.json(formatInvoice(invoice));
  },
);

// DELETE invoice (soft delete)
export const deleteInvoice = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const old = await prisma.invoice.findUnique({ where: { id } });
    if (!old) throw notFound("ไม่พบ invoice");
    if (old.deleted_at) throw badRequest("invoice ถูกลบไปแล้ว");

    await prisma.invoice.update({
      where: { id },
      data: { deleted_at: new Date(), updated_at: new Date() },
    });

    return res.json({ message: "ลบ invoice เรียบร้อยแล้ว" });
  },
);
