import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";

interface CreateBarcodeForGoodsInRequest {
  goods_in_id: string;
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
      // บางเคส meta ไม่ชัด แต่เป็น P2002 ก็ถือว่าใช่
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
  goods_in_id: string;
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
    const normalizedBarcode = String(input.barcodeValue ?? "").trim();
    if (!normalizedBarcode) throw badRequest("กรุณาระบุ barcode");

    const goodsIn = await tx.goods_in.findUnique({
      where: { id: input.goods_in_id },
      select: {
        id: true,
        deleted_at: true,
        barcode_id: true,
        barcode_text: true,
        code: true,
        name: true,
        tracking: true,
        product_id: true,
      },
    });

    if (!goodsIn) throw notFound(`ไม่พบ goods_in id: ${input.goods_in_id}`);
    if (goodsIn.deleted_at) throw badRequest("goods_in นี้ถูกลบไปแล้ว");

    // ถ้า goods_in นี้มี barcode อยู่แล้ว
    if (goodsIn.barcode_id) {
      const currentBarcodeText = String(goodsIn.barcode_text ?? "").trim();

      // ถ้าเป็น barcode เดียวกันอยู่แล้ว ถือว่าสำเร็จเลย
      if (currentBarcodeText && currentBarcodeText === normalizedBarcode) {
        const currentBarcode = await tx.barcode.findUnique({
          where: { id: goodsIn.barcode_id },
        });

        if (currentBarcode) return currentBarcode;
      }

      // ถ้ามี barcode คนละตัวอยู่แล้ว ไม่ให้ทับ
      throw badRequest("goods_in นี้มี barcode แล้ว");
    }

    // หา master barcode เดิมก่อน
    let barcodeMaster = await tx.barcode.findFirst({
      where: {
        barcode: normalizedBarcode,
        deleted_at: null,
      },
    });

    // ถ้ายังไม่มี ค่อยสร้างใหม่
    if (!barcodeMaster) {
      barcodeMaster = await tx.barcode.create({
        data: {
          barcode: normalizedBarcode,
          lot_start: input.lot_start ?? undefined,
          lot_stop: input.lot_stop ?? undefined,
          exp_start: input.exp_start ?? undefined,
          exp_stop: input.exp_stop ?? undefined,
          barcode_length: input.barcode_length ?? normalizedBarcode.length,

          product_code: input.product_code || goodsIn.code || undefined,
          product_name: input.product_name || goodsIn.name || undefined,
          tracking: input.tracking || goodsIn.tracking || undefined,
          product_id: goodsIn.product_id ?? undefined,

          ratio: input.ratio ?? undefined,
          internal_use: input.internal_use ?? false,
          active: true,
        },
      });
    }

    await tx.goods_in.update({
      where: { id: input.goods_in_id },
      data: {
        barcode_id: barcodeMaster.id,
        barcode_text: barcodeMaster.barcode,
        updated_at: new Date(),
      },
    });

    return barcodeMaster;
  });
}

export const createBarcodeForGoodsIn = asyncHandler(
  async (req: Request<{}, {}, CreateBarcodeForGoodsInRequest>, res: Response) => {
    const {
      goods_in_id,
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

    if (!goods_in_id) throw badRequest("กรุณาระบุ goods_in_id");
    if (!barcodeValue) throw badRequest("กรุณาระบุ barcode");

    // ✅ retry ได้ 1 ครั้งพอ
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const newBarcode = await runCreateBarcodeTx({
          goods_in_id,
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
        // ถ้าชน id รอบแรก -> sync sequence นอก tx แล้วลองใหม่
        if (attempt === 0 && isUniqueConstraintOnId(err)) {
          await syncBarcodesIdSequence();
          continue;
        }
        throw err;
      }
    }

    // theoretically unreachable
    throw badRequest("ไม่สามารถสร้าง barcode ได้");
  },
);

/**
 * Update barcode for goods_in
 */
export const updateBarcodeForGoodsIn = asyncHandler(
  async (req: Request<{ goods_in_id: string }>, res: Response) => {
    const goods_in_id = req.params.goods_in_id;

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

    const goodsIn = await prisma.goods_in.findUnique({
      where: { id: goods_in_id },
      include: { barcode: true },
    });

    if (!goodsIn) throw notFound(`ไม่พบ goods_in id: ${goods_in_id}`);
    if (goodsIn.deleted_at) throw badRequest("goods_in นี้ถูกลบไปแล้ว");
    if (!goodsIn.barcode_id || !goodsIn.barcode) {
      throw badRequest("goods_in นี้ยังไม่มี barcode");
    }

    const updatedBarcode = await prisma.barcode.update({
      where: { id: goodsIn.barcode_id },
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

    // ✅ NEW: sync barcode_text ใน goods_in ให้ตรงกับ barcode ที่อัปเดต
    if (barcodeValue !== undefined && barcodeValue !== null) {
      const nextText = String(barcodeValue).trim();
      await prisma.goods_in.update({
        where: { id: goods_in_id },
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
 * Delete barcode from goods_in (soft delete)
 */
export const deleteBarcodeForGoodsIn = asyncHandler(
  async (req: Request<{ goods_in_id: string }>, res: Response) => {
    const goods_in_id = req.params.goods_in_id;

    // Check if goods_in exists and has barcode
    const goodsIn = await prisma.goods_in.findUnique({
      where: { id: goods_in_id },
    });

    if (!goodsIn) throw notFound(`ไม่พบ goods_in id: ${goods_in_id}`);
    if (goodsIn.deleted_at) throw badRequest("goods_in นี้ถูกลบไปแล้ว");
    if (!goodsIn.barcode_id) throw badRequest("goods_in นี้ไม่มี barcode");

    // Soft delete barcode
    await prisma.barcode.update({
      where: { id: goodsIn.barcode_id },
      data: {
        deleted_at: new Date(),
        updated_at: new Date(),
      },
    });

    // Remove barcode_id from goods_in
    await prisma.goods_in.update({
      where: { id: goods_in_id },
      data: {
        barcode_id: null,
        updated_at: new Date(),
      },
    });

    return res.json({
      message: "ลบ barcode สำเร็จ",
    });
  }
);
