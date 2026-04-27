import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";

/**
 * เพิ่ม/อัพเดท Box ให้ goods_out_item
 * POST /api/outbounds/:no/items/:itemId/boxes
 */
export const addBoxToItem = asyncHandler(
  async (
    req: Request<
      { no: string; itemId: string },
      {},
      { box_id: number; quantity?: number; user_pack?: string | null; user_ref?: string | null }
    >,
    res: Response
  ) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;
    const itemIdStr = Array.isArray(req.params.itemId)
      ? req.params.itemId[0]
      : req.params.itemId;
    const itemId = parseInt(itemIdStr, 10);

    const { box_id, quantity } = req.body;

    const userPackRaw = req.body.user_pack ?? req.body.user_ref ?? null;
    const userPack =
      userPackRaw == null ? null : String(userPackRaw).trim() || null;

    if (!no || isNaN(itemId)) {
      throw badRequest("กรุณาระบุ no และ itemId");
    }

    if (!box_id || !Number.isFinite(Number(box_id))) {
      throw badRequest("กรุณาระบุ box_id");
    }

    const nextQty =
      quantity === undefined || quantity === null ? null : Number(quantity);

    if (nextQty !== null && (!Number.isFinite(nextQty) || nextQty < 0)) {
      throw badRequest("quantity ต้องเป็นตัวเลข >= 0");
    }

    const outbound = await prisma.outbound.findUnique({
      where: { no },
      select: {
        id: true,
        no: true,
        deleted_at: true,
      },
    });

    if (!outbound || outbound.deleted_at) {
      throw notFound("ไม่พบ Outbound");
    }

    const item = await prisma.goods_out_item.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        outbound_id: true,
        qty: true,
        pack: true,
        status: true,
        deleted_at: true,
        source_item_id: true,
        lot_adjustment_id: true,
        is_split_generated: true,
      },
    });

    if (!item || item.deleted_at || item.outbound_id !== outbound.id) {
      throw notFound("ไม่พบ Item");
    }

    const box = await prisma.box.findUnique({
      where: { id: box_id },
      select: {
        id: true,
        box_code: true,
        box_name: true,
        deleted_at: true,
      },
    });

    if (!box || box.deleted_at) {
      throw notFound("ไม่พบ Box");
    }

    const result = await prisma.$transaction(async (tx) => {
      const existingBoxes = await tx.goods_out_item_box.findMany({
        where: {
          item_id: itemId,
          deleted_at: null,
        },
        select: {
          id: true,
          box_id: true,
          quantity: true,
        },
      });

      const totalOtherQty = existingBoxes
        .filter((b) => b.box_id !== box_id)
        .reduce((sum, b) => sum + Number(b.quantity ?? 0), 0);

      const itemQty = Number(item.qty ?? 0);
      const nextTotal = totalOtherQty + Number(nextQty ?? 0);

      if (itemQty > 0 && nextTotal > itemQty) {
        throw badRequest(
          `จำนวน box รวม (${nextTotal}) มากกว่า qty ของ item (${itemQty})`,
        );
      }

      const itemBox = await tx.goods_out_item_box.upsert({
        where: {
          item_id_box_id: {
            item_id: itemId,
            box_id: box_id,
          },
        },
        create: {
          item_id: itemId,
          box_id: box_id,
          quantity: nextQty,
        },
        update: {
          quantity: nextQty,
          updated_at: new Date(),
        },
        include: {
          box: true,
        },
      });

      const packedAgg = await tx.goods_out_item_box.aggregate({
        where: {
          item_id: itemId,
          deleted_at: null,
        },
        _sum: {
          quantity: true,
        },
      });

      const packedQty = Number(packedAgg._sum.quantity ?? 0);
      const isPacked = itemQty > 0 ? packedQty >= itemQty : packedQty > 0;

      const updatedItem = await tx.goods_out_item.update({
        where: { id: itemId },
        data: {
          pack: packedQty,
          user_pack: userPack,
          pack_time: new Date(),
          status: isPacked ? "PACKED" : item.status,
          updated_at: new Date(),
        },
        select: {
          id: true,
          qty: true,
          pack: true,
          status: true,
          lot_serial: true,
          source_item_id: true,
          lot_adjustment_id: true,
          is_split_generated: true,
        },
      });

      const remainingNotPacked = await tx.goods_out_item.count({
        where: {
          outbound_id: outbound.id,
          deleted_at: null,
          OR: [
            { qty: null },
            { qty: 0 },
            { pack: { lt: itemQty > 0 ? 1 : 999999999 } }, // แค่กัน null path
          ],
        },
      });

      return {
        itemBox,
        updatedItem,
        remainingNotPacked,
      };
    });

    return res.status(201).json({
      message: "เพิ่ม/อัพเดท Box สำเร็จ",
      data: {
        id: result.itemBox.id,
        item_id: result.itemBox.item_id,
        box_id: result.itemBox.box_id,
        quantity: result.itemBox.quantity,
        box: {
          id: result.itemBox.box.id,
          box_code: result.itemBox.box.box_code,
          box_name: result.itemBox.box.box_name,
        },
        item: result.updatedItem,
      },
    });
  }
);

/**
 * อัพเดท Box quantity ของ goods_out_item
 * PATCH /api/outbounds/:no/items/:itemId/boxes/:boxId
 */
export const updateBoxItem = asyncHandler(
  async (
    req: Request<{ no: string; itemId: string; boxId: string }, {}, { quantity?: number }>,
    res: Response
  ) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;
    const itemIdStr = Array.isArray(req.params.itemId) ? req.params.itemId[0] : req.params.itemId;
    const itemId = parseInt(itemIdStr, 10);
    const boxIdStr = Array.isArray(req.params.boxId) ? req.params.boxId[0] : req.params.boxId;
    const boxId = parseInt(boxIdStr, 10);
    const { quantity } = req.body;

    if (!no || isNaN(itemId) || isNaN(boxId)) {
      throw badRequest("กรุณาระบุ no, itemId และ boxId");
    }

    // ตรวจสอบ outbound
    const outbound = await prisma.outbound.findUnique({ where: { no } });
    if (!outbound || outbound.deleted_at) {
      throw notFound("ไม่พบ Outbound");
    }

    // ตรวจสอบว่ามี record อยู่หรือไม่
    const existing = await prisma.goods_out_item_box.findUnique({
      where: {
        item_id_box_id: {
          item_id: itemId,
          box_id: boxId,
        },
      },
      include: {
        box: true,
      },
    });

    if (!existing || existing.deleted_at) {
      throw notFound("ไม่พบ Box ในรายการนี้");
    }

    // Update
    const updated = await prisma.goods_out_item_box.update({
      where: {
        item_id_box_id: {
          item_id: itemId,
          box_id: boxId,
        },
      },
      data: {
        quantity: quantity !== undefined ? quantity : existing.quantity,
        updated_at: new Date(),
      },
      include: {
        box: true,
      },
    });

    return res.json({
      message: "อัพเดท Box สำเร็จ",
      data: {
        id: updated.id,
        item_id: updated.item_id,
        box_id: updated.box_id,
        quantity: updated.quantity,
        box: {
          id: updated.box.id,
          box_code: updated.box.box_code,
          box_name: updated.box.box_name,
        },
      },
    });
  }
);

/**
 * ลบ Box ออกจาก goods_out_item
 * DELETE /api/outbounds/:no/items/:itemId/boxes/:boxId
 */
export const removeBoxFromItem = asyncHandler(
  async (req: Request<{ no: string; itemId: string; boxId: string }>, res: Response) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;
    const itemIdStr = Array.isArray(req.params.itemId) ? req.params.itemId[0] : req.params.itemId;
    const itemId = parseInt(itemIdStr, 10);
    const boxIdStr = Array.isArray(req.params.boxId) ? req.params.boxId[0] : req.params.boxId;
    const boxId = parseInt(boxIdStr, 10);

    if (!no || isNaN(itemId) || isNaN(boxId)) {
      throw badRequest("กรุณาระบุ no, itemId และ boxId");
    }

    // ตรวจสอบ outbound
    const outbound = await prisma.outbound.findUnique({ where: { no } });
    if (!outbound || outbound.deleted_at) {
      throw notFound("ไม่พบ Outbound");
    }

    // Soft delete
    await prisma.goods_out_item_box.updateMany({
      where: {
        item_id: itemId,
        box_id: boxId,
      },
      data: {
        deleted_at: new Date(),
      },
    });

    return res.json({
      message: "ลบ Box สำเร็จ",
    });
  }
);

/**
 * ดู Boxes ทั้งหมดของ item
 * GET /api/outbounds/:no/items/:itemId/boxes
 */
export const getItemBoxes = asyncHandler(
  async (req: Request<{ no: string; itemId: string }>, res: Response) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;
    const itemIdStr = Array.isArray(req.params.itemId) ? req.params.itemId[0] : req.params.itemId;
    const itemId = parseInt(itemIdStr, 10);

    if (!no || isNaN(itemId)) {
      throw badRequest("กรุณาระบุ no และ itemId");
    }

    const boxes = await prisma.goods_out_item_box.findMany({
      where: {
        item_id: itemId,
        deleted_at: null,
      },
      include: {
        box: true,
      },
    });

    return res.json({
      total: boxes.length,
      data: boxes.map((ib) => ({
        id: ib.id,
        item_id: ib.item_id,
        box_id: ib.box_id,
        quantity: ib.quantity,
        box: {
          id: ib.box.id,
          box_code: ib.box.box_code,
          box_name: ib.box.box_name,
        },
      })),
    });
  }
);
