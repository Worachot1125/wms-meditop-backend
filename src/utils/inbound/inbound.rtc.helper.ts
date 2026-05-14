import { prisma } from "../../lib/prisma";
import { Prisma } from "@prisma/client";
import { NormalizedInboundItem, toExpDate } from "./inbound.normalize.helper";
import { handleInboundTransfer } from "./inbound.transfer.helper";
import { rtcAdjustmentMatchKey } from "./inbound.key.helper";
import { io } from "../../index";

export async function handleRTCReturnTransfer(input: {
  picking_id?: any;
  number: string;
  location_id?: any;
  location?: any;
  location_dest_id?: any;
  location_dest?: any;
  department_id?: any;
  department?: any;
  reference?: any;
  origin: any;
  invoice?: any;
  mergedItems: NormalizedInboundItem[];
}) {
  const {
    picking_id,
    number,
    location_id,
    location,
    location_dest_id,
    location_dest,
    department_id,
    department,
    reference,
    origin,
    invoice,
    mergedItems,
  } = input;

  const outboundNo = extractOutboundNoFromOrigin(origin);

  if (!outboundNo) {
    const inbound = await handleInboundTransfer({
      picking_id,
      number,
      location_id,
      location,
      location_dest_id,
      location_dest,
      department_id,
      department,
      reference:
        reference != null ? String(reference) : `[RTC-NO-REF] ${number}`,
      origin,
      invoice,
      mergedItems,
    });

    return {
      source: "rtc",
      rtc_no: number,
      outbound_id: null,
      outbound_no: null,
      mode: "fallback_inbound",
      reason: "missing_outbound_ref",
      data: inbound,
    };
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
      out_type: true,
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
    const inbound = await handleInboundTransfer({
      number,
      origin,
      mergedItems,
      picking_id: null,
      location_id: null,
      location: null,
      location_dest_id: null,
      location_dest: null,
      department_id: null,
      department: "",
      reference: `[RTC-NO-MATCH] ${outboundNo}`,
      invoice: null,
    } as any);

    return {
      source: "rtc",
      rtc_no: number,
      outbound_id: null,
      outbound_no: outboundNo,
      mode: "fallback_inbound",
      data: inbound,
    };
  }

  const packing = await prisma.pack_product_outbound.findFirst({
    where: {
      outbound_id: Number(outbound.id),
    },
    select: {
      id: true,
      outbound_id: true,
      pack_product_id: true,
    },
  });

  if (packing) {
    const payload = {
      source: "rtc",
      mode: "packing_rtc_detected",
      rtc_no: number,
      outbound_id: outbound.id,
      outbound_no: outbound.no,
      out_type: (outbound as any).out_type, 
      origin,
      invoice,
      pack_product_id: packing.pack_product_id,
      pack_product_name: null,
      items: mergedItems,
    };

    try {
      io.to(`pack_product:${packing.pack_product_id}`).emit(
        "packing:rtc_detected",
        payload,
      );
      io.to(`outbound:${outbound.no}`).emit("packing:rtc_detected", payload);
      io.emit("packing:rtc_detected", payload);
    } catch {}
  }

  const result = await prisma.$transaction(async (tx) => {
    const dbItems = await tx.goods_out_item.findMany({
      where: {
        outbound_id: outbound.id,
        deleted_at: null,
      },
      orderBy: [{ sequence: "asc" }, { id: "asc" }],
    });

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

    const hasPicked =
      dbItems.some((x: any) => Number(x.pick ?? 0) > 0) ||
      (adjustmentLines as any[]).some((x: any) => Number(x.pick ?? 0) > 0);

    /**
     * ✅ Important rule:
     * - true  = RTC came while outbound already has pick.
     *           Keep outbound/goods_out_item/batch as-is.
     *           Do not reduce qty/pack here.
     *           Actual delete/reduce will be done later in return confirm.
     * - false = no pick yet.
     *           Create inbound/goods_in and mark inbound completed.
     */
    const shouldKeepOutboundForReturn = hasPicked;

    if (!hasPicked) {
      const inbound = await handleInboundTransfer({
        picking_id,
        number,
        location_id,
        location,
        location_dest_id,
        location_dest,
        department_id,
        department,
        reference:
          reference != null ? String(reference) : `[RTC-NO-PICK] ${number}`,
        origin,
        invoice,
        mergedItems,
      });

      const completedInbound = await completeInboundIfCreated(inbound);

      await tx.goods_out_item.updateMany({
        where: {
          outbound_id: Number(outbound.id),
          deleted_at: null,
        } as any,
        data: {
          deleted_at: new Date(),
          updated_at: new Date(),
        } as any,
      });

      await tx.batch_outbound.deleteMany({
        where: {
          outbound_id: Number(outbound.id),
        },
      });

      await tx.pack_product_outbound.deleteMany({
        where: {
          outbound_id: Number(outbound.id),
        },
      });

      await tx.outbound.update({
        where: {
          id: Number(outbound.id),
        },
        data: {
          deleted_at: new Date(),
          updated_at: new Date(),
        } as any,
      });

      return {
        source: "rtc",
        rtc_no: number,
        outbound_id: outbound.id,
        outbound_no: outbound.no,
        mode: "inbound_completed_no_pick_and_soft_delete_outbound",
        reason: "all_pick_is_zero",
        data: completedInbound,
        outbound_action: "soft_delete",
        batch_action: "remove_relation",
        pack_product_action: "remove_relation",
      };
    }

    const inbound = await handleInboundTransfer({
      picking_id,
      number,
      location_id,
      location,
      location_dest_id,
      location_dest,
      department_id,
      department,
      reference:
        reference != null ? String(reference) : `[RTC-DURING-PICK] ${number}`,
      origin,
      invoice,
      mergedItems,
    });

    const affected: any[] = [];
    const ignored: any[] = [];
    const packingBoxAffected: any[] = [];

    for (const item of mergedItems) {
      const productId =
        item.product_id != null ? Number(item.product_id) : null;

      const lotId = item.lot_id != null ? Number(item.lot_id) : null;

      const lotSerial = String(item.lot_serial ?? "").trim();

      const rtcQty = Math.max(
        0,
        Number(
          (item as any).quantity ??
            item.qty ??
            (item as any).product_uom_qty ??
            0,
        ),
      );

      const rtcExp = toExpDate(item.expire_date ?? null) ?? null;

      if (!productId || rtcQty <= 0) {
        ignored.push({
          reason: "invalid_product_or_qty",
          item,
        });
        continue;
      }

      const match = dbItems.find((go: any) => {
        if (Number(go.product_id) !== Number(productId)) {
          return false;
        }

        if (lotId != null && go.lot_id != null) {
          return Number(go.lot_id) === Number(lotId);
        }

        if (lotSerial) {
          return (
            String(go.lot_serial ?? "")
              .trim()
              .toLowerCase() === lotSerial.toLowerCase()
          );
        }

        return true;
      });

      if (!match) {
        ignored.push({
          reason: "goods_out_item_not_found",
          product_id: productId,
          lot_id: lotId,
          lot_serial: lotSerial || null,
          qty: rtcQty,
        });

        continue;
      }

      const currentQty = Math.max(0, Number(match.qty ?? 0));

      const currentPack = Math.max(0, Number(match.pack ?? 0));

      const currentPick = Math.max(0, Number(match.pick ?? 0));

      const currentRtc = Math.max(0, Number(match.rtc ?? 0));

      const candidateAdjustmentLines = adjustmentByItemId.get(match.id) ?? [];

      const rtcAdjKey = rtcAdjustmentMatchKey({
        product_id: productId,
        lot_id: lotId,
        lot_serial: lotSerial || null,
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
        Number(matchedAdjustmentLine?.pick ?? 0),
      );

      /**
       * ==========================================
       * RTC during PICK / PACK
       * -> behave same as PD
       * -> keep outbound alive
       * -> DO NOT reduce qty yet
       * ==========================================
       */
      const isDuringPickOrPack =
        currentPick > 0 || adjustmentPick > 0 || currentPack > 0;

      if (isDuringPickOrPack) {
        const maxRtc = Math.max(0, currentQty - currentRtc);

        if (rtcQty > maxRtc) {
          ignored.push({
            reason: "rtc_qty_exceeded",
            product_id: productId,
            goods_out_item_id: match.id,
            current_qty: currentQty,
            current_rtc: currentRtc,
            rtc_qty: rtcQty,
            max_rtc: maxRtc,
          });

          continue;
        }

        await tx.goods_out_item.update({
          where: {
            id: Number(match.id),
          },
          data: {
            rtc: {
              increment: rtcQty,
            },
            rtc_check: false,
            updated_at: new Date(),
          } as any,
        });

        affected.push({
          rtc_no: number,
          outbound_no: outbound.no,
          goods_out_item_id: match.id,
          adjustment_line_id: matchedAdjustmentLine?.id ?? null,
          product_id: productId,
          lot_id: lotId,
          lot_serial: match.lot_serial ?? lotSerial ?? null,
          exp: rtcExp ? rtcExp.toISOString() : null,

          old_qty: currentQty,
          old_pack: currentPack,
          old_pick: currentPick,
          old_rtc: currentRtc,

          adjustment_pick: adjustmentPick,

          rtc_qty: rtcQty,

          new_qty: currentQty,
          new_pack: currentPack,
          new_pick: currentPick,
          new_rtc: currentRtc + rtcQty,

          during_pick: true,

          action: "rtc_waiting_return_pick",
        });

        continue;
      }

      /**
       * ==========================================
       * RTC normal flow
       * -> reduce qty immediately
       * ==========================================
       */

      const qtyReduce = Math.min(currentQty, rtcQty);

      const packReduce = Math.min(currentPack, rtcQty);

      const nextQty = Math.max(0, currentQty - qtyReduce);

      const nextPack = Math.max(0, currentPack - packReduce);

      const boxResult =
        packReduce > 0
          ? await reducePackingBoxItemsForRtcTx(tx, {
              goods_out_item_id: Number(match.id),
              reduce_qty: packReduce,
            })
          : [];

      packingBoxAffected.push(...boxResult);

      if (nextQty <= 0) {
        await tx.goods_out_item.update({
          where: {
            id: Number(match.id),
          },
          data: {
            qty: 0,
            pack: nextPack,
            deleted_at: new Date(),
            updated_at: new Date(),
          } as any,
        });

        if (matchedAdjustmentLine?.id && adjustmentPick <= 0) {
          await tx.outbound_lot_adjustment_line.update({
            where: {
              id: matchedAdjustmentLine.id,
            },
            data: {
              deleted_at: new Date(),
              updated_at: new Date(),
            } as any,
          });
        }

        affected.push({
          rtc_no: number,
          outbound_no: outbound.no,
          goods_out_item_id: match.id,
          adjustment_line_id: matchedAdjustmentLine?.id ?? null,
          product_id: productId,
          lot_id: lotId,
          lot_serial: match.lot_serial ?? lotSerial ?? null,
          exp: rtcExp ? rtcExp.toISOString() : null,

          old_qty: currentQty,
          old_pack: currentPack,
          old_pick: currentPick,
          old_rtc: currentRtc,

          adjustment_pick: adjustmentPick,

          rtc_qty: rtcQty,

          new_qty: 0,
          new_pack: nextPack,
          new_rtc: currentRtc,

          during_pick: false,

          action: "rtc_soft_delete_item",
        });

        continue;
      }

      await tx.goods_out_item.update({
        where: {
          id: Number(match.id),
        },
        data: {
          qty: nextQty,
          pack: nextPack,
          updated_at: new Date(),
        } as any,
      });

      affected.push({
        rtc_no: number,
        outbound_no: outbound.no,
        goods_out_item_id: match.id,
        adjustment_line_id: matchedAdjustmentLine?.id ?? null,
        product_id: productId,
        lot_id: lotId,
        lot_serial: match.lot_serial ?? lotSerial ?? null,
        exp: rtcExp ? rtcExp.toISOString() : null,

        old_qty: currentQty,
        old_pack: currentPack,
        old_pick: currentPick,
        old_rtc: currentRtc,

        adjustment_pick: adjustmentPick,

        rtc_qty: rtcQty,

        new_qty: nextQty,
        new_pack: nextPack,
        new_rtc: currentRtc,

        during_pick: false,

        action: "rtc_reduce_qty",
      });
    }

    const remainingActiveItems = await tx.goods_out_item.count({
      where: {
        outbound_id: Number(outbound.id),
        deleted_at: null,
        qty: { gt: 0 },
      },
    });

    let outbound_action: "keep" | "soft_delete" = "keep";
    let batch_action: "keep" | "remove_relation" = "keep";
    let pack_product_action: "keep" | "remove_relation" = "keep";

    if (!shouldKeepOutboundForReturn && remainingActiveItems === 0) {
      await tx.batch_outbound.deleteMany({
        where: {
          outbound_id: Number(outbound.id),
        },
      });

      await tx.pack_product_outbound.deleteMany({
        where: {
          outbound_id: Number(outbound.id),
        },
      });

      await tx.outbound.update({
        where: { id: Number(outbound.id) },
        data: {
          deleted_at: new Date(),
          updated_at: new Date(),
        } as any,
      });

      outbound_action = "soft_delete";
      batch_action = "remove_relation";
      pack_product_action = "remove_relation";
    } else {
      await tx.outbound.update({
        where: { id: Number(outbound.id) },
        data: {
          updated_at: new Date(),
        } as any,
      });
    }

    return {
      source: "rtc",
      rtc_no: number,
      outbound_id: outbound.id,
      outbound_no: outbound.no,
      mode: shouldKeepOutboundForReturn
        ? "inbound_return_during_pick_keep_outbound"
        : "outbound_adjust",
      reason: shouldKeepOutboundForReturn
        ? "pick_exists_wait_return_confirm"
        : undefined,
      data: inbound,
      affected,
      ignored,
      packing_box_affected: packingBoxAffected,
      remaining_active_items: remainingActiveItems,
      outbound_action,
      batch_action,
      pack_product_action,
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

  // ✅ WH/DO/xxxx
  const whMatch = s.match(/WH\/(?:DO|BO)\/[^\s]+/i);
  if (whMatch?.[0]) {
    return whMatch[0].trim().toUpperCase();
  }

  // ✅ DO-xxxx / DOxxxx
  const doMatch = s.match(/\b((?:DO|BO)[A-Z0-9-]+)\b/i);
  if (doMatch?.[1]) {
    return doMatch[1].trim().toUpperCase();
  }

  return null;
}

async function reducePackingBoxItemsForRtcTx(
  tx: any,
  args: {
    goods_out_item_id: number;
    reduce_qty: number;
  },
) {
  let remaining = Math.max(0, Math.floor(Number(args.reduce_qty ?? 0)));
  if (remaining <= 0) return [];

  const boxItems = await tx.pack_product_box_item.findMany({
    where: {
      goods_out_item_id: args.goods_out_item_id,
      deleted_at: null,
    } as any,
    orderBy: [{ id: "asc" }],
  });

  const affected: any[] = [];

  for (const boxItem of boxItems) {
    if (remaining <= 0) break;

    const currentQty = Math.max(0, Math.floor(Number(boxItem.quantity ?? 0)));
    if (currentQty <= 0) continue;

    const reduceQty = Math.min(currentQty, remaining);
    const nextQty = currentQty - reduceQty;

    if (nextQty <= 0) {
      await tx.pack_product_box_item.delete({
        where: { id: Number(boxItem.id) },
      });
    } else {
      await tx.pack_product_box_item.update({
        where: { id: Number(boxItem.id) },
        data: {
          quantity: nextQty,
          updated_at: new Date(),
        } as any,
      });
    }

    affected.push({
      pack_product_box_item_id: boxItem.id,
      old_quantity: currentQty,
      reduced_qty: reduceQty,
      new_quantity: nextQty,
      action: nextQty <= 0 ? "delete" : "decrement",
    });

    remaining -= reduceQty;
  }

  return affected;
}

async function completeInboundIfCreated(inbound: any) {
  const inboundId = Number(inbound?.id ?? inbound?.data?.id ?? 0);
  if (!inboundId) return inbound;

  const completed = await prisma.inbound.update({
    where: { id: inboundId },
    data: {
      status: "completed",
      updated_at: new Date(),
    } as any,
  });

  return {
    ...inbound,
    status: completed.status,
  };
}
