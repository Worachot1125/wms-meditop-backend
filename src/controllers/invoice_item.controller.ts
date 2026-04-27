import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../utils/asyncHandler";
import { notFound, badRequest } from "../utils/appError";
import { formatInvoiceItemModal } from "../utils/formatters/invoice_item_modal.formatter";
import { UpdateInvoiceItemLotQtyBody } from "../types/invoice_item";

export const getInvoiceItemById = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = Number(rawId);
    if (!Number.isFinite(id)) throw badRequest("invoice_item id ต้องเป็นตัวเลข");

    const row = await prisma.invoice_item.findUnique({
      where: { id },
      include: {
        invoice: { include: { doc_invoice: true } },
        goods_out: { include: { lot: true } },
      },
    });

    if (!row) throw notFound("ไม่พบ invoice_item");
    if (row.invoice.deleted_at) throw badRequest("invoice ถูกลบไปแล้ว");
    if (row.goods_out.deleted_at) throw badRequest("goods_out ถูกลบไปแล้ว");

    return res.json(formatInvoiceItemModal(row));
  },
);

export const updateInvoiceItemLotQty = asyncHandler(
  async (req: Request<{ id: string }, {}, UpdateInvoiceItemLotQtyBody>, res: Response) => {
    const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const invoiceItemId = Number(rawId);

    if (!Number.isFinite(invoiceItemId)) throw badRequest("invoice_item id ต้องเป็นตัวเลข");

    const data = req.body;

    if (!data.lot_no?.trim()) throw badRequest("lot_no ห้ามว่าง");
    if (
      data.quantity === undefined ||
      data.pick === undefined ||
      data.pack === undefined
    ) {
      throw badRequest("ต้องส่ง quantity, pick, pack");
    }

    if ([data.quantity, data.pick, data.pack].some((n) => typeof n !== "number" || n < 0)) {
      throw badRequest("quantity/pick/pack ต้องเป็นตัวเลข >= 0");
    }

    // หา invoice_item ก่อน
    const oldItem = await prisma.invoice_item.findUnique({
      where: { id: invoiceItemId },
      include: {
        invoice: true,
        goods_out: true,
      },
    });

    if (!oldItem) throw notFound("ไม่พบ invoice_item");
    if (oldItem.invoice.deleted_at) throw badRequest("invoice ถูกลบไปแล้ว");
    if (oldItem.goods_out.deleted_at) throw badRequest("goods_out ถูกลบไปแล้ว");

    // lot ใหม่ต้องมีจริง
    const lot = await prisma.lot.findUnique({ where: { no: data.lot_no.trim() } });
    if (!lot || lot.deleted_at) throw badRequest("ไม่พบ lot_no นี้ในระบบ");

    // อัปเดต 2 ตารางพร้อมกัน
    const updated = await prisma.$transaction(async (tx) => {
      // 1) update lot ใน goods_out
      await tx.goods_out.update({
        where: { id: oldItem.goods_out_id },
        data: { lot_no: data.lot_no.trim(), updated_at: new Date() },
      });

      // 2) update qty/pick/pack ใน invoice_item
      const updatedItem = await tx.invoice_item.update({
        where: { id: invoiceItemId },
        data: {
          quantity: data.quantity,
          pick: data.pick,
          pack: data.pack,
          updated_at: new Date(),
        },
        include: {
          invoice: { include: { doc_invoice: true } },
          goods_out: { include: { lot: true } },
        },
      });

      return updatedItem;
    });

    return res.json(formatInvoiceItemModal(updated));
  },
);