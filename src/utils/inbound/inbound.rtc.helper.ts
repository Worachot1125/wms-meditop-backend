import { prisma } from "../../lib/prisma";
import { Prisma } from "@prisma/client";
import { badRequest } from "../appError";
import { NormalizedInboundItem, toExpDate } from "./inbound.normalize.helper";
import { handleInboundTransfer } from "./inbound.transfer.helper";
import { rtcAdjustmentMatchKey } from "./inbound.key.helper";
import { io } from "../../index";

export async function handleRTCReturnTransfer(input: {
  number: string;
  origin: any;
  mergedItems: NormalizedInboundItem[];
}) {
  const { number, origin, mergedItems } = input;

  const outboundNo = extractOutboundNoFromOrigin(origin);
  if (!outboundNo) {
    throw badRequest(
      `RTC ${number} ไม่สามารถหา outbound no จาก origin ได้: ${String(origin ?? "")}`,
    );
  }

  const outbound = await prisma.outbound.findFirst({
    where: {
      no: outboundNo,
      deleted_at: null,
    },
    select: {
      id: true,
      no: true,
      in_process: true,
      picking_id: true,
      location_id: true,
      location: true,
      location_dest_id: true,
      location_dest: true,
      department_id: true,
      department: true,
      reference: true,
      origin: true,
      invoice: true,
    },
  });

  if (!outbound) {
    throw badRequest(`RTC ${number} ไม่พบ outbound จาก origin: ${outboundNo}`);
  }

  /**
   * ==========================================
   * CASE 1: outbound.in_process === true
   * -> เอา RTC เข้า inbound/goods_in เพื่อทำ pick/receive ปกติ
   * ==========================================
   */
  if (Boolean(outbound.in_process)) {
    const inbound = await handleInboundTransfer({
      picking_id: outbound.picking_id ?? null,
      number,
      location_id: outbound.location_id ?? null,
      location: outbound.location ?? null,
      location_dest_id: outbound.location_dest_id ?? null,
      location_dest: outbound.location_dest ?? null,
      department_id: outbound.department_id ?? null,
      department: outbound.department ?? "",
      reference: `[RTC] ${outbound.no}`,
      origin,
      invoice: outbound.invoice ?? null,
      mergedItems,
    });

    const result = {
      source: "rtc",
      rtc_no: number,
      outbound_id: outbound.id,
      outbound_no: outbound.no,
      mode: "inbound_upsert",
      data: inbound,
    };

    try {
      io.to(`outbound:${result.outbound_no}`).emit(
        "outbound:rtc_adjusted",
        result,
      );
      io.to(`outbound-id:${result.outbound_id}`).emit(
        "outbound:rtc_adjusted",
        result,
      );
      io.emit("outbound:rtc_adjusted", result);
    } catch {}

    return result;
  }

  /**
   * ==========================================
   * CASE 2: outbound.in_process === false
   * -> เช็ค pick ก่อน
   *    - goods_out_item.pick
   *    - outbound_lot_adjustment_line.pick
   * -> ถ้ามี pick ที่ไหน > 0 => rtc_check_only
   * -> ถ้า pick ทั้งหมด = 0 => process เดิม
   * ==========================================
   */
  const result = await prisma.$transaction(async (tx) => {
    const dbItems = await tx.goods_out_item.findMany({
      where: {
        outbound_id: outbound.id,
        deleted_at: null,
      },
      select: {
        id: true,
        outbound_id: true,
        product_id: true,
        lot_id: true,
        lot_serial: true,
        qty: true,
        pick: true,
        pack: true,
        code: true,
        name: true,
        updated_at: true,
        rtc_check: true as any,
      },
    });

    const itemMap = new Map<string, (typeof dbItems)[number]>();
    for (const row of dbItems) {
      const key = `${row.product_id ?? "null"}__${row.lot_id ?? "null"}`;
      if (!itemMap.has(key)) {
        itemMap.set(key, row);
      }
    }

    const adjustmentLines =
      await getOutboundLotAdjustmentLinesByGoodsOutItemIds(
        tx,
        dbItems.map((x) => x.id),
      );

    const adjustmentByItemId = new Map<number, typeof adjustmentLines>();
    for (const row of adjustmentLines as any[]) {
      const itemId = Number(row.goods_out_item_id ?? 0);
      const arr = adjustmentByItemId.get(itemId) ?? [];
      arr.push(row);
      adjustmentByItemId.set(itemId, arr);
    }

    const affected: Array<{
      rtc_no: string;
      outbound_no: string;
      goods_out_item_id: number;
      adjustment_line_id?: number | null;
      product_id: number | null;
      lot_id: number | null;
      lot_serial: string | null;
      exp?: string | null;
      old_qty: number;
      rtc_qty: number;
      new_qty: number;
      action:
        | "decrement"
        | "soft_delete"
        | "skip_picked"
        | "rtc_check_only"
        | "adjustment_soft_delete";
    }> = [];

    const ignored: Array<{
      product_id: number | null;
      lot_id: number | null;
      lot_serial: string | null;
      qty: number;
      reason: string;
    }> = [];

    for (const item of mergedItems) {
      const product_id = item.product_id ?? null;
      const lot_id = item.lot_id ?? null;
      const rtcQty = Math.max(0, Math.floor(Number(item.qty ?? 0)));
      const rtcExp = toExpDate(item.expire_date ?? null) ?? null;

      if (product_id == null) {
        ignored.push({
          product_id: null,
          lot_id,
          lot_serial: item.lot_serial ?? null,
          qty: rtcQty,
          reason: "missing_product_id",
        });
        continue;
      }

      if (rtcQty <= 0) {
        ignored.push({
          product_id,
          lot_id,
          lot_serial: item.lot_serial ?? null,
          qty: rtcQty,
          reason: "invalid_qty",
        });
        continue;
      }

      const key = `${product_id}__${lot_id ?? "null"}`;
      const match = itemMap.get(key);

      if (!match) {
        ignored.push({
          product_id,
          lot_id,
          lot_serial: item.lot_serial ?? null,
          qty: rtcQty,
          reason: "goods_out_item_not_found",
        });
        continue;
      }

      const currentPick = Math.max(0, Math.floor(Number(match.pick ?? 0)));
      const currentQty = Math.max(0, Math.floor(Number(match.qty ?? 0)));

      // หา adjustment line ที่ตรงละเอียด
      const candidateAdjustmentLines = adjustmentByItemId.get(match.id) ?? [];

      // IMPORTANT:
      // outbound_lot_adjustment_line ไม่มี exp ใน schema
      // จึงต้อง match โดยไม่ใช้ exp เพื่อไม่ให้กระทบ flow เดิม
      const rtcAdjKey = rtcAdjustmentMatchKey({
        product_id,
        lot_id,
        lot_serial: item.lot_serial ?? null,
        exp: null,
      });

      const matchedAdjustmentLine =
        candidateAdjustmentLines.find((adj: any) => {
          const adjKey = rtcAdjustmentMatchKey({
            product_id: match.product_id ?? null,
            lot_id: adj.lot_id ?? null,
            lot_serial: adj.lot_serial ?? null,
            exp: null,
          });
          return adjKey === rtcAdjKey;
        }) ?? null;

      const adjustmentPick = Math.max(
        0,
        Math.floor(Number(matchedAdjustmentLine?.pick ?? 0)),
      );

      /**
       * ✅ NEW RULE
       * ถ้ามี pick ฝั่ง item หรือ adjustment line > 0
       * -> set rtc_check = true อย่างเดียว
       */
      if (currentPick > 0 || adjustmentPick > 0) {
        await tx.goods_out_item.update({
          where: { id: match.id },
          data: {
            rtc_check: true,
            updated_at: new Date(),
          } as any,
        });

        affected.push({
          rtc_no: number,
          outbound_no: outbound.no,
          goods_out_item_id: match.id,
          adjustment_line_id: matchedAdjustmentLine?.id ?? null,
          product_id: match.product_id ?? null,
          lot_id: match.lot_id ?? null,
          lot_serial: item.lot_serial ?? match.lot_serial ?? null,
          exp: rtcExp ? rtcExp.toISOString() : null,
          old_qty: currentQty,
          rtc_qty: rtcQty,
          new_qty: currentQty,
          action: "rtc_check_only",
        });

        continue;
      }

      /**
       * ✅ OLD RULE
       * pick == 0 ทั้ง item และ adjustment
       */
      const nextQty = currentQty - rtcQty;

      if (nextQty <= 0) {
        await tx.goods_out_item.update({
          where: { id: match.id },
          data: {
            deleted_at: new Date(),
            updated_at: new Date(),
          },
        });

        affected.push({
          rtc_no: number,
          outbound_no: outbound.no,
          goods_out_item_id: match.id,
          adjustment_line_id: null,
          product_id: match.product_id ?? null,
          lot_id: match.lot_id ?? null,
          lot_serial: match.lot_serial ?? null,
          exp: null,
          old_qty: currentQty,
          rtc_qty: rtcQty,
          new_qty: currentQty,
          action: "soft_delete",
        });

        // ถ้ามี matched adjustment line ของ item นี้และตรงชุดเดียวกัน -> soft delete ด้วย
        if (matchedAdjustmentLine?.id) {
          await tx.outbound_lot_adjustment_line.update({
            where: { id: matchedAdjustmentLine.id },
            data: {
              deleted_at: new Date(),
              updated_at: new Date(),
            } as any,
          });

          affected.push({
            rtc_no: number,
            outbound_no: outbound.no,
            goods_out_item_id: match.id,
            adjustment_line_id: matchedAdjustmentLine.id,
            product_id: match.product_id ?? null,
            lot_id: matchedAdjustmentLine.lot_id ?? null,
            lot_serial: matchedAdjustmentLine.lot_serial ?? null,
            exp: rtcExp ? rtcExp.toISOString() : null,
            old_qty: 0,
            rtc_qty: rtcQty,
            new_qty: 0,
            action: "adjustment_soft_delete",
          });
        }

        continue;
      }

      await tx.goods_out_item.update({
        where: { id: match.id },
        data: {
          qty: nextQty,
          updated_at: new Date(),
        },
      });

      affected.push({
        rtc_no: number,
        outbound_no: outbound.no,
        goods_out_item_id: match.id,
        adjustment_line_id: null,
        product_id: match.product_id ?? null,
        lot_id: match.lot_id ?? null,
        lot_serial: match.lot_serial ?? null,
        exp: null,
        old_qty: currentQty,
        rtc_qty: rtcQty,
        new_qty: nextQty,
        action: "decrement",
      });

      // ถ้ามี matched adjustment line และ pick=0 อยู่แล้ว -> soft delete ได้เช่นกัน
      if (matchedAdjustmentLine?.id) {
        await tx.outbound_lot_adjustment_line.update({
          where: { id: matchedAdjustmentLine.id },
          data: {
            deleted_at: new Date(),
            updated_at: new Date(),
          } as any,
        });

        affected.push({
          rtc_no: number,
          outbound_no: outbound.no,
          goods_out_item_id: match.id,
          adjustment_line_id: matchedAdjustmentLine.id,
          product_id: match.product_id ?? null,
          lot_id: matchedAdjustmentLine.lot_id ?? null,
          lot_serial: matchedAdjustmentLine.lot_serial ?? null,
          exp: rtcExp ? rtcExp.toISOString() : null,
          old_qty: 0,
          rtc_qty: rtcQty,
          new_qty: 0,
          action: "adjustment_soft_delete",
        });
      }
    }

    await tx.outbound.update({
      where: { id: outbound.id },
      data: {
        updated_at: new Date(),
      },
    });

    const remainingActiveItems = await tx.goods_out_item.count({
      where: {
        outbound_id: outbound.id,
        deleted_at: null,
      },
    });

    let outbound_action: "keep" | "soft_delete" = "keep";

    if (remainingActiveItems === 0) {
      await tx.outbound.update({
        where: { id: outbound.id },
        data: {
          deleted_at: new Date(),
          updated_at: new Date(),
        },
      });

      outbound_action = "soft_delete";
    }

    return {
      source: "rtc",
      rtc_no: number,
      outbound_id: outbound.id,
      outbound_no: outbound.no,
      mode: "outbound_adjust",
      affected,
      ignored,
      remaining_active_items: remainingActiveItems,
      outbound_action,
    };
  });

  try {
    io.to(`outbound:${result.outbound_no}`).emit(
      "outbound:rtc_adjusted",
      result,
    );
    io.to(`outbound-id:${result.outbound_id}`).emit(
      "outbound:rtc_adjusted",
      result,
    );
    io.emit("outbound:rtc_adjusted", result);
  } catch {}

  return result;
}

export async function getOutboundLotAdjustmentLinesByGoodsOutItemIds(
  tx: Prisma.TransactionClient,
  goodsOutItemIds: number[],
) {
  if (!goodsOutItemIds.length) return [];

  return tx.outbound_lot_adjustment_line.findMany({
    where: {
      goods_out_item_id: { in: goodsOutItemIds },
      deleted_at: null,
    },
    select: {
      id: true,
      adjustment_id: true,
      goods_out_item_id: true,
      lot_id: true,
      lot_serial: true,
      qty: true,
      pick: true,
      is_original_lot: true,
      deleted_at: true,
      adjustment: {
        select: {
          id: true,
          outbound_id: true,
          goods_out_item_id: true,
          original_lot_id: true,
          original_lot_serial: true,
          original_qty: true,
          status: true,
        },
      },
    },
    orderBy: [{ id: "asc" }],
  });
}

export function extractOutboundNoFromOrigin(origin: any): string | null {
  const s = String(origin ?? "").trim();

  if (!s) return null;

  // รองรับรูปแบบ: "การส่งคืนของ DOxxxx-xxxx"
  const m = s.match(/\b(DO[A-Z0-9-]+)\b/i);
  if (!m) return null;

  return String(m[1] ?? "")
    .trim()
    .toUpperCase();
}
