import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";

interface CreateBarcodeForTransferDocItemRequest {
  transfer_doc_item_id: string;
  barcode: string;
  lot_start?: number;
  lot_stop?: number;
  exp_start?: number;
  exp_stop?: number;
  barcode_length?: number;
  product_code?: string;
  product_name?: string;
  tracking?: string;
  ratio?: number;
  internal_use?: boolean;
}

/**
 * =========================
 * Helpers (Duplicate id auto-fix)
 * =========================
 */

function isUniqueConstraintOnId(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      const target = (err.meta as any)?.target;
      if (Array.isArray(target)) return target.includes("id");
      if (typeof target === "string") return target.includes("id");
      return true;
    }
  }
  return false;
}

async function syncBarcodesIdSequence() {
  // ✅ table จริงชื่อ barcodes (ตาม @@map("barcodes"))
  await prisma.$executeRawUnsafe(`
    SELECT setval(
      pg_get_serial_sequence('barcodes', 'id'),
      COALESCE((SELECT MAX(id) FROM barcodes), 1),
      true
    );
  `);
}

async function runCreateBarcodeTx(input: {
  transfer_doc_item_id: string;
  barcodeValue: string;
  lot_start?: number | null;
  lot_stop?: number | null;
  exp_start?: number | null;
  exp_stop?: number | null;
  barcode_length?: number | null;
  product_code?: string | null;
  product_name?: string | null;
  tracking?: string | null;
  ratio?: number | null;
  internal_use?: boolean | null;
}) {
  return prisma.$transaction(async (tx) => {
    const item = await tx.transfer_doc_item.findUnique({
      where: { id: input.transfer_doc_item_id },
      select: {
        id: true,
        deleted_at: true,
        barcode_id: true,
        code: true,
        name: true,
        tracking: true,
        product_id: true,
      },
    });

    if (!item)
      throw notFound(`ไม่พบ transfer_doc_item id: ${input.transfer_doc_item_id}`);
    if (item.deleted_at) throw badRequest("transfer_doc_item นี้ถูกลบไปแล้ว");
    if (item.barcode_id) throw badRequest("transfer_doc_item นี้มี barcode แล้ว");

    const newBarcode = await tx.barcode.create({
      data: {
        barcode: input.barcodeValue,
        lot_start: input.lot_start ?? undefined,
        lot_stop: input.lot_stop ?? undefined,
        exp_start: input.exp_start ?? undefined,
        exp_stop: input.exp_stop ?? undefined,
        barcode_length: input.barcode_length ?? undefined,

        product_code: input.product_code || item.code || undefined,
        product_name: input.product_name || item.name || undefined,
        tracking: input.tracking || item.tracking || undefined,
        product_id: item.product_id ?? undefined,

        ratio: input.ratio ?? undefined,
        internal_use: input.internal_use ?? false,
        active: true,
      },
    });

    await tx.transfer_doc_item.update({
      where: { id: input.transfer_doc_item_id },
      data: {
        barcode_id: newBarcode.id,
        barcode_text: input.barcodeValue,
        updated_at: new Date(),
      },
    });

    return newBarcode;
  });
}

export const createBarcodeForTransferDocItem = asyncHandler(
  async (
    req: Request<{}, {}, CreateBarcodeForTransferDocItemRequest>,
    res: Response,
  ) => {
    const {
      transfer_doc_item_id,
      barcode: barcodeValue,
      lot_start,
      lot_stop,
      exp_start,
      exp_stop,
      barcode_length,
      product_code,
      product_name,
      tracking,
      ratio,
      internal_use,
    } = req.body;

    if (!transfer_doc_item_id) throw badRequest("กรุณาระบุ transfer_doc_item_id");
    if (!barcodeValue) throw badRequest("กรุณาระบุ barcode");

    // ✅ retry ได้ 1 ครั้งพอ
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const newBarcode = await runCreateBarcodeTx({
          transfer_doc_item_id,
          barcodeValue,
          lot_start,
          lot_stop,
          exp_start,
          exp_stop,
          barcode_length,
          product_code,
          product_name,
          tracking,
          ratio,
          internal_use,
        });

        return res.status(201).json({
          message: "สร้าง barcode สำเร็จ",
          data: newBarcode,
        });
      } catch (err) {
        if (attempt === 0 && isUniqueConstraintOnId(err)) {
          await syncBarcodesIdSequence();
          continue;
        }
        throw err;
      }
    }

    throw badRequest("ไม่สามารถสร้าง barcode ได้");
  },
);

/**
 * Update barcode for transfer_doc_item
 */
export const updateBarcodeForTransferDocItem = asyncHandler(
  async (req: Request<{ transfer_doc_item_id: string }>, res: Response) => {
    const transfer_doc_item_id = req.params.transfer_doc_item_id;

    const {
      barcode: barcodeValue,
      lot_start,
      lot_stop,
      exp_start,
      exp_stop,
      barcode_length,
      product_code,
      product_name,
      tracking,
      ratio,
      internal_use,
      active,
    } = req.body;

    const item = await prisma.transfer_doc_item.findUnique({
      where: { id: transfer_doc_item_id },
      include: { barcode: true },
    });

    if (!item) throw notFound(`ไม่พบ transfer_doc_item id: ${transfer_doc_item_id}`);
    if (item.deleted_at) throw badRequest("transfer_doc_item นี้ถูกลบไปแล้ว");
    if (!item.barcode_id || !item.barcode) {
      throw badRequest("transfer_doc_item นี้ยังไม่มี barcode");
    }

    const updatedBarcode = await prisma.barcode.update({
      where: { id: item.barcode_id },
      data: {
        barcode: barcodeValue ?? undefined,
        lot_start: lot_start ?? undefined,
        lot_stop: lot_stop ?? undefined,
        exp_start: exp_start ?? undefined,
        exp_stop: exp_stop ?? undefined,
        barcode_length: barcode_length ?? undefined,
        product_code: product_code ?? undefined,
        product_name: product_name ?? undefined,
        tracking: tracking ?? undefined,
        ratio: ratio ?? undefined,
        internal_use: internal_use ?? undefined,
        active: active ?? undefined,
        updated_at: new Date(),
      },
    });

    // ✅ sync barcode_text ใน transfer_doc_item ให้ตรงกับ barcode ที่อัปเดต
    if (barcodeValue !== undefined && barcodeValue !== null) {
      const nextText = String(barcodeValue).trim();
      await prisma.transfer_doc_item.update({
        where: { id: transfer_doc_item_id },
        data: {
          barcode_text: nextText.length > 0 ? nextText : null,
          updated_at: new Date(),
        },
      });
    }

    return res.json({
      message: "อัพเดท barcode สำเร็จ",
      data: updatedBarcode,
    });
  },
);

/**
 * Delete barcode from transfer_doc_item (soft delete)
 */
export const deleteBarcodeForTransferDocItem = asyncHandler(
  async (req: Request<{ transfer_doc_item_id: string }>, res: Response) => {
    const transfer_doc_item_id = req.params.transfer_doc_item_id;

    const item = await prisma.transfer_doc_item.findUnique({
      where: { id: transfer_doc_item_id },
    });

    if (!item) throw notFound(`ไม่พบ transfer_doc_item id: ${transfer_doc_item_id}`);
    if (item.deleted_at) throw badRequest("transfer_doc_item นี้ถูกลบไปแล้ว");
    if (!item.barcode_id) throw badRequest("transfer_doc_item นี้ไม่มี barcode");

    // Soft delete barcode
    await prisma.barcode.update({
      where: { id: item.barcode_id },
      data: {
        deleted_at: new Date(),
        updated_at: new Date(),
      },
    });

    // Remove barcode_id from transfer_doc_item
    await prisma.transfer_doc_item.update({
      where: { id: transfer_doc_item_id },
      data: {
        barcode_id: null,
        updated_at: new Date(),
      },
    });

    return res.json({
      message: "ลบ barcode สำเร็จ",
    });
  },
);