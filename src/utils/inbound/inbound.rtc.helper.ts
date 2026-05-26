import { prisma } from "../../lib/prisma";
import { Prisma } from "@prisma/client";
import { NormalizedInboundItem, toExpDate } from "./inbound.normalize.helper";
import { handleInboundTransfer } from "./inbound.transfer.helper";
import { rtcAdjustmentMatchKey } from "./inbound.key.helper";
import { io } from "../../index";

const normalizeReturnOriginRef = (value: unknown) => {
  return String(value ?? "")
    .trim()
    .replace(/^การส่งคืนของ\s*/i, "")
    .replace(/^return of\s*/i, "")
    .replace(/^return\s*/i, "")
    .trim();
};

const buildOutboundRefCandidates = (input: {
  origin?: unknown;
  reference?: unknown;
  invoice?: unknown;
  no?: unknown;
  number?: unknown;
}) => {
  const values = [
    input.origin,
    normalizeReturnOriginRef(input.origin),
    input.reference,
    normalizeReturnOriginRef(input.reference),
    input.invoice,
    input.no,
    input.number,
  ];

  return Array.from(
    new Set(values.map((v) => String(v ?? "").trim()).filter(Boolean)),
  );
};

export async function handleRTCReturnTransfer(input: {
  picking_id?: any;
  number?: string;
  no?: any;
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
    no,
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

  const documentNo = String(number ?? no ?? "").trim();

  const outboundRefs = buildOutboundRefCandidates({
    origin,
    reference,
    no,
    number: documentNo,
    invoice,
  });

  const preReturnMode = detectRtcBorMode({
    number: documentNo,
    no,
    origin,
    out_type: null,
  });

  if (outboundRefs.length === 0) {
    const inbound = await handleInboundTransfer({
      picking_id,
      number: documentNo,
      location_id,
      location,
      location_dest_id,
      location_dest,
      department_id,
      department,
      reference:
        reference != null
          ? String(reference)
          : `[${preReturnMode}-NO-REF] ${documentNo}`,
      origin,
      invoice,
      mergedItems,
    });

    return {
      source: preReturnMode.toLowerCase(),
      rtc_no: documentNo,
      return_mode: preReturnMode,
      rtc_bor_mode: preReturnMode,
      outbound_id: null,
      outbound_no: null,
      mode: "fallback_inbound",
      reason: "missing_outbound_ref",
      data: inbound,
    };
  }

  const outbound = await prisma.outbound.findFirst({
    where: {
      deleted_at: null,
      OR: outboundRefs.flatMap((ref) => [
        { no: { equals: ref, mode: "insensitive" as const } },
        { origin: { equals: ref, mode: "insensitive" as const } },
        { invoice: { equals: ref, mode: "insensitive" as const } },
        { reference: { equals: ref, mode: "insensitive" as const } },
      ]),
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
      number: documentNo,
      origin,
      mergedItems,
      picking_id: null,
      location_id: null,
      location: null,
      location_dest_id: null,
      location_dest: null,
      department_id: null,
      department: "",
      reference: `[${preReturnMode}-NO-MATCH] ${outboundRefs.join(",")}`,
      invoice: null,
    } as any);

    return {
      source: preReturnMode.toLowerCase(),
      rtc_no: documentNo,
      return_mode: preReturnMode,
      rtc_bor_mode: preReturnMode,
      outbound_id: null,
      outbound_no: outboundRefs[0] ?? null,
      mode: "fallback_inbound",
      reason: "outbound_not_found",
      outbound_refs: outboundRefs,
      data: inbound,
    };
  }

  const returnMode = detectRtcBorMode({
    number: documentNo,
    no,
    origin,
    out_type: outbound.out_type,
  });

  const result: any = await prisma.$transaction(async (tx) => {
    const packingLink = await tx.pack_product_outbound.findFirst({
      where: {
        outbound_id: Number(outbound.id),
      },
      select: {
        id: true,
        pack_product_id: true,
      },
    });

    const dbItems = await tx.goods_out_item.findMany({
      where: {
        outbound_id: Number(outbound.id),
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

    const hasPickedOrPacked =
      dbItems.some(
        (x: any) => Number(x.pick ?? 0) > 0 || Number(x.pack ?? 0) > 0,
      ) || (adjustmentLines as any[]).some((x: any) => Number(x.pick ?? 0) > 0);

    if (!hasPickedOrPacked) {
      const inbound = await handleInboundTransfer({
        picking_id,
        number: documentNo,
        location_id,
        location,
        location_dest_id,
        location_dest,
        department_id,
        department,
        reference:
          reference != null
            ? String(reference)
            : `[${returnMode}-NO-PICK] ${documentNo}`,
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
        source: returnMode.toLowerCase(),
        rtc_no: documentNo,
        return_mode: returnMode,
        rtc_bor_mode: returnMode,
        outbound_id: outbound.id,
        outbound_no: outbound.no,
        pack_product_id: packingLink?.pack_product_id ?? null,
        mode: "inbound_completed_no_pick_and_soft_delete_outbound",
        reason: "all_pick_pack_is_zero",
        data: completedInbound,
        affected: [],
        ignored: [],
        packing_box_affected: [],
        outbound_action: "soft_delete",
        batch_action: "remove_relation",
        pack_product_action: "remove_relation",
        outbound_refs: outboundRefs,
      };
    }

    const inbound = await handleInboundTransfer({
      picking_id,
      number: documentNo,
      location_id,
      location,
      location_dest_id,
      location_dest,
      department_id,
      department,
      reference:
        reference != null
          ? String(reference)
          : `[${returnMode}-DURING-PACK] ${documentNo}`,
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

      const returnQty = Math.max(
        0,
        Math.floor(
          Number(
            (item as any).quantity ??
              item.qty ??
              (item as any).product_uom_qty ??
              0,
          ),
        ),
      );

      const returnExp = toExpDate(item.expire_date ?? null) ?? null;

      if (!productId || returnQty <= 0) {
        ignored.push({
          reason: "invalid_product_or_qty",
          item,
        });
        continue;
      }

      const match = dbItems.find((go: any) => {
        if (Number(go.product_id) !== Number(productId)) return false;

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
          qty: returnQty,
          return_mode: returnMode,
        });
        continue;
      }

      const currentQty = Math.max(0, Math.floor(Number(match.qty ?? 0)));
      const currentPack = Math.max(0, Math.floor(Number(match.pack ?? 0)));
      const currentPick = Math.max(0, Math.floor(Number(match.pick ?? 0)));
      const currentRtc = Math.max(0, Math.floor(Number(match.rtc ?? 0)));
      const currentBor = Math.max(0, Math.floor(Number(match.bor ?? 0)));

      const candidateAdjustmentLines = adjustmentByItemId.get(match.id) ?? [];

      const returnAdjKey = rtcAdjustmentMatchKey({
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

          return adjKey === returnAdjKey;
        }) ?? null;

      const adjustmentPick = Math.max(
        0,
        Math.floor(Number(matchedAdjustmentLine?.pick ?? 0)),
      );

      const isDuringPickOrPack =
        currentPick > 0 || adjustmentPick > 0 || currentPack > 0;

      if (returnQty > currentQty) {
        ignored.push({
          reason:
            returnMode === "BOR" ? "bor_qty_exceeded" : "rtc_qty_exceeded",
          product_id: productId,
          goods_out_item_id: match.id,
          current_qty: currentQty,
          current_rtc: currentRtc,
          current_bor: currentBor,
          return_qty: returnQty,
          max_return: currentQty,
          return_mode: returnMode,
        });
        continue;
      }

      if (isDuringPickOrPack) {
        const availableToRemove = Math.max(0, currentQty - currentPack);
        const softRemoveQty = Math.min(returnQty, availableToRemove);
        const packedReturnQty = Math.max(0, returnQty - softRemoveQty);

        let nextQty = Math.max(0, currentQty - returnQty);
        let nextPack = currentPack;
        let nextPick = currentPick;

        const packMoveResult = {
          moved_qty: 0,
          remaining_qty: packedReturnQty,
          targets: [],
        };

        const movedPackQty = 0;

        nextPack = currentPack;
        nextPick = currentPick;

        const qtyStillNeedReturn = packedReturnQty;

        nextPack = Math.max(0, currentPack - movedPackQty);
        nextPick = Math.max(nextPack, currentPick - movedPackQty);

        const nextRtc =
          returnMode === "RTC" ? currentRtc + qtyStillNeedReturn : currentRtc;

        const nextBor =
          returnMode === "BOR" ? currentBor + qtyStillNeedReturn : currentBor;

        const shouldDeleteItem =
          nextQty <= 0 && nextPack <= 0 && qtyStillNeedReturn <= 0;

        if (shouldDeleteItem) {
          await tx.goods_out_item.update({
            where: {
              id: Number(match.id),
            },
            data: {
              qty: 0,
              pick: 0,
              pack: 0,
              rtc: returnMode === "RTC" ? nextRtc : currentRtc,
              bor: returnMode === "BOR" ? nextBor : currentBor,
              rtc_check: false,
              return_check: false,
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
        } else {
          await tx.goods_out_item.update({
            where: {
              id: Number(match.id),
            },
            data:
              returnMode === "BOR"
                ? {
                    qty: nextQty,
                    pick: nextPick,
                    pack: nextPack,
                    bor: nextBor,
                    return_check: qtyStillNeedReturn > 0,
                    updated_at: new Date(),
                  }
                : {
                    qty: nextQty,
                    pick: nextPick,
                    pack: nextPack,
                    rtc: nextRtc,
                    rtc_check: qtyStillNeedReturn > 0,
                    updated_at: new Date(),
                  },
          } as any);
        }

        packingBoxAffected.push({
          goods_out_item_id: Number(match.id),
          action: "move_packed_qty_to_other_doc",
          requested_qty: packedReturnQty,
          moved_qty: movedPackQty,
          remaining_qty: packMoveResult.remaining_qty,
          targets: packMoveResult.targets,
        });

        affected.push({
          rtc_no: documentNo,
          return_mode: returnMode,
          rtc_bor_mode: returnMode,
          outbound_no: outbound.no,
          goods_out_item_id: match.id,
          adjustment_line_id: matchedAdjustmentLine?.id ?? null,
          product_id: productId,
          lot_id: lotId,
          lot_serial: match.lot_serial ?? lotSerial ?? null,
          exp: returnExp ? returnExp.toISOString() : null,
          old_qty: currentQty,
          old_pack: currentPack,
          old_pick: currentPick,
          old_rtc: currentRtc,
          old_bor: currentBor,
          adjustment_pick: adjustmentPick,
          requested_return_qty: returnQty,
          soft_removed_qty: softRemoveQty,
          packed_return_qty: packedReturnQty,
          moved_to_other_doc_qty: movedPackQty,
          moved_pack_to_other_doc_qty: movedPackQty,
          moved_pending_pick_to_other_doc_qty: 0,
          return_qty: qtyStillNeedReturn,
          rtc_qty: returnMode === "RTC" ? qtyStillNeedReturn : 0,
          bor_qty: returnMode === "BOR" ? qtyStillNeedReturn : 0,
          moved_pack_targets: packMoveResult.targets,
          moved_pending_pick_targets: [],
          new_qty: shouldDeleteItem ? 0 : nextQty,
          new_pack: shouldDeleteItem ? 0 : nextPack,
          new_pick: shouldDeleteItem ? 0 : nextPick,
          new_rtc: shouldDeleteItem ? nextRtc : nextRtc,
          new_bor: shouldDeleteItem ? nextBor : nextBor,
          during_pick: true,
          during_pack: currentPack > 0,
          action:
            qtyStillNeedReturn > 0
              ? returnMode === "BOR"
                ? "bor_waiting_return_pick"
                : "rtc_waiting_return_pick"
              : movedPackQty > 0
                ? returnMode === "BOR"
                  ? "bor_moved_pack_to_other_doc"
                  : "rtc_moved_pack_to_other_doc"
                : returnMode === "BOR"
                  ? "bor_removed_unpacked_qty"
                  : "rtc_removed_unpacked_qty",
        });

        continue;
      }

      const qtyReduce = Math.min(currentQty, returnQty);
      const nextQty = Math.max(0, currentQty - qtyReduce);

      if (nextQty <= 0) {
        await tx.goods_out_item.update({
          where: {
            id: Number(match.id),
          },
          data: {
            qty: 0,
            pack: 0,
            pick: 0,
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
          rtc_no: documentNo,
          return_mode: returnMode,
          rtc_bor_mode: returnMode,
          outbound_no: outbound.no,
          goods_out_item_id: match.id,
          adjustment_line_id: matchedAdjustmentLine?.id ?? null,
          product_id: productId,
          lot_id: lotId,
          lot_serial: match.lot_serial ?? lotSerial ?? null,
          exp: returnExp ? returnExp.toISOString() : null,
          old_qty: currentQty,
          old_pack: currentPack,
          old_pick: currentPick,
          old_rtc: currentRtc,
          old_bor: currentBor,
          adjustment_pick: adjustmentPick,
          return_qty: returnQty,
          rtc_qty: returnMode === "RTC" ? returnQty : 0,
          bor_qty: returnMode === "BOR" ? returnQty : 0,
          new_qty: 0,
          new_pack: 0,
          new_pick: 0,
          new_rtc: currentRtc,
          new_bor: currentBor,
          during_pick: false,
          during_pack: false,
          action:
            returnMode === "BOR"
              ? "bor_soft_delete_item"
              : "rtc_soft_delete_item",
        });

        continue;
      }

      await tx.goods_out_item.update({
        where: {
          id: Number(match.id),
        },
        data: {
          qty: nextQty,
          updated_at: new Date(),
        } as any,
      });

      affected.push({
        rtc_no: documentNo,
        return_mode: returnMode,
        rtc_bor_mode: returnMode,
        outbound_no: outbound.no,
        goods_out_item_id: match.id,
        adjustment_line_id: matchedAdjustmentLine?.id ?? null,
        product_id: productId,
        lot_id: lotId,
        lot_serial: match.lot_serial ?? lotSerial ?? null,
        exp: returnExp ? returnExp.toISOString() : null,
        old_qty: currentQty,
        old_pack: currentPack,
        old_pick: currentPick,
        old_rtc: currentRtc,
        old_bor: currentBor,
        adjustment_pick: adjustmentPick,
        return_qty: returnQty,
        rtc_qty: returnMode === "RTC" ? returnQty : 0,
        bor_qty: returnMode === "BOR" ? returnQty : 0,
        new_qty: nextQty,
        new_pack: currentPack,
        new_pick: currentPick,
        new_rtc: currentRtc,
        new_bor: currentBor,
        during_pick: false,
        during_pack: false,
        action: returnMode === "BOR" ? "bor_reduce_qty" : "rtc_reduce_qty",
      });
    }

    const remainingActiveItems = await tx.goods_out_item.count({
      where: {
        outbound_id: Number(outbound.id),
        deleted_at: null,
        qty: { gt: 0 },
      },
    });

    const remainingReturnItems = await tx.goods_out_item.count({
      where: {
        outbound_id: Number(outbound.id),
        deleted_at: null,
        OR:
          returnMode === "BOR"
            ? [{ bor: { gt: 0 } }, { return_check: true }]
            : [{ rtc: { gt: 0 } }, { rtc_check: true }],
      } as any,
    });

    let outbound_action: "keep" | "soft_delete" = "keep";
    let batch_action: "keep" | "remove_relation" = "keep";
    let pack_product_action: "keep" | "remove_relation" = "keep";

    if (
      outbound.in_process !== true &&
      remainingActiveItems === 0 &&
      remainingReturnItems === 0
    ) {
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
      source: returnMode.toLowerCase(),
      rtc_no: documentNo,
      return_mode: returnMode,
      rtc_bor_mode: returnMode,
      outbound_id: outbound.id,
      outbound_no: outbound.no,
      pack_product_id: packingLink?.pack_product_id ?? null,
      mode:
        remainingReturnItems > 0
          ? "inbound_return_during_pack_wait_return"
          : outbound_action === "soft_delete"
            ? "inbound_return_moved_or_removed_and_soft_delete_outbound"
            : "outbound_adjust",
      reason:
        remainingReturnItems > 0
          ? returnMode === "BOR"
            ? "bor_exists_wait_return_confirm"
            : "rtc_exists_wait_return_confirm"
          : outbound_action === "soft_delete"
            ? "all_items_moved_or_removed"
            : "rtc_bor_adjusted",
      data: inbound,
      affected,
      ignored,
      packing_box_affected: packingBoxAffected,
      remaining_active_items: remainingActiveItems,
      remaining_return_items: remainingReturnItems,
      outbound_action,
      batch_action,
      pack_product_action,
      outbound_refs: outboundRefs,
    };
  });

  if (outbound.in_process === true) {
    const packProductId =
      result.pack_product_id ??
      (
        await prisma.pack_product_outbound.findFirst({
          where: {
            outbound_id: Number(outbound.id),
          },
          select: {
            pack_product_id: true,
          },
        })
      )?.pack_product_id ??
      null;

    let updateResult = { count: 0 };

    if (result.outbound_action !== "soft_delete") {
      updateResult = await prisma.goods_out_item.updateMany({
        where: {
          outbound_id: Number(outbound.id),
          deleted_at: null,
          ...(returnMode === "BOR" ? { bor: { gt: 0 } } : { rtc: { gt: 0 } }),
        } as any,
        data:
          returnMode === "BOR"
            ? {
                return_check: true,
                updated_at: new Date(),
              }
            : {
                rtc_check: true,
                updated_at: new Date(),
              },
      } as any);
    }

    result.mode =
      result.remaining_return_items > 0 ? "packing_wait_action" : result.mode;

    result.return_mode = returnMode;
    result.rtc_bor_mode = returnMode;
    result.reason =
      result.remaining_return_items > 0
        ? "outbound_in_process_wait_pack_return"
        : result.reason;
    result.pack_product_id = packProductId;
    result.updated_goods_out_item_count = updateResult.count;

    try {
      if (packProductId) {
        io.to(`pack_product:${packProductId}`).emit("pack_product:updated", {
          pack_product_id: packProductId,
          reason: "rtc_bor_during_packing",
          data: result,
        });

        io.to(`pack_product:${packProductId}`).emit(
          "packing:rtc_bor_waiting_action",
          {
            ...result,
            mode: returnMode,
            return_mode: returnMode,
            rtc_bor_mode: returnMode,
            rtc_no: documentNo,
            outbound_id: outbound.id,
            outbound_no: outbound.no,
            out_type: outbound.out_type,
            origin,
            invoice,
            pack_product_id: packProductId,
            updated_goods_out_item_count: updateResult.count,
            items: mergedItems,
          },
        );
      }

      io.emit("packing:rtc_bor_waiting_action", {
        ...result,
        mode: returnMode,
        return_mode: returnMode,
        rtc_bor_mode: returnMode,
        rtc_no: documentNo,
        outbound_id: outbound.id,
        outbound_no: outbound.no,
        out_type: outbound.out_type,
        origin,
        invoice,
        pack_product_id: packProductId,
        updated_goods_out_item_count: updateResult.count,
        items: mergedItems,
      });
    } catch {}
  }

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

async function movePackedQtyToOtherPackDocTx(params: {
  tx: any;
  sourceGoodsOutItem: any;
  moveQty: number;
}): Promise<{
  moved_qty: number;
  remaining_qty: number;
  targets: Array<{
    goods_out_item_id: number;
    outbound_no: string | null;
    moved_qty: number;
  }>;
}> {
  const { tx, sourceGoodsOutItem } = params;
  let remaining = Math.max(0, Math.floor(Number(params.moveQty ?? 0)));

  const result = {
    moved_qty: 0,
    remaining_qty: remaining,
    targets: [] as Array<{
      goods_out_item_id: number;
      outbound_no: string | null;
      moved_qty: number;
    }>,
  };

  if (remaining <= 0) return result;
  if (!sourceGoodsOutItem?.product_id) return result;

  const sourcePack = Math.max(
    0,
    Math.floor(Number(sourceGoodsOutItem.pack ?? 0)),
  );
  const sourcePick = Math.max(
    0,
    Math.floor(Number(sourceGoodsOutItem.pick ?? 0)),
  );

  const sourcePackLink = await tx.pack_product_outbound.findFirst({
    where: {
      outbound_id: Number(sourceGoodsOutItem.outbound_id),
    },
    select: {
      pack_product_id: true,
    },
  });

  if (!sourcePackLink?.pack_product_id) return result;

  const targetLinks = await tx.pack_product_outbound.findMany({
    where: {
      pack_product_id: Number(sourcePackLink.pack_product_id),
      outbound_id: {
        not: Number(sourceGoodsOutItem.outbound_id),
      },
    },
    select: {
      outbound_id: true,
      outbound: {
        select: {
          id: true,
          no: true,
          deleted_at: true,
        },
      },
    },
    orderBy: {
      id: "asc",
    },
  });

  const targetOutboundIds = targetLinks
    .filter((x: any) => !x.outbound?.deleted_at)
    .map((x: any) => Number(x.outbound_id))
    .filter((x: number) => x > 0);

  if (targetOutboundIds.length === 0) return result;

  const targetItems = await tx.goods_out_item.findMany({
    where: {
      id: {
        not: Number(sourceGoodsOutItem.id),
      },
      outbound_id: {
        in: targetOutboundIds,
      },
      deleted_at: null,
      product_id: Number(sourceGoodsOutItem.product_id),
      ...(sourceGoodsOutItem.lot_id != null
        ? { lot_id: sourceGoodsOutItem.lot_id }
        : { lot_serial: sourceGoodsOutItem.lot_serial ?? null }),
    } as any,
    include: {
      outbound: {
        select: {
          no: true,
        },
      },
    },
    orderBy: [{ outbound_id: "asc" }, { id: "asc" }],
  });

  if (!targetItems.length) return result;

  const sourceBoxItems = await tx.pack_product_box_item.findMany({
    where: {
      goods_out_item_id: Number(sourceGoodsOutItem.id),
      deleted_at: null,
    } as any,
    orderBy: [{ id: "asc" }],
  });

  if (!sourceBoxItems.length) return result;

  for (const target of targetItems as any[]) {
    if (remaining <= 0) break;

    const targetQty = Math.max(0, Math.floor(Number(target.qty ?? 0)));
    const targetPack = Math.max(0, Math.floor(Number(target.pack ?? 0)));
    const targetCapacity = Math.max(0, targetQty - targetPack);

    if (targetCapacity <= 0) continue;

    let targetNeed = Math.min(remaining, targetCapacity);
    let movedToThisTarget = 0;

    for (const boxItem of sourceBoxItems as any[]) {
      if (targetNeed <= 0) break;

      const currentBoxQty = Math.max(
        0,
        Math.floor(Number(boxItem.quantity ?? 0)),
      );

      if (currentBoxQty <= 0) continue;

      const take = Math.min(currentBoxQty, targetNeed);

      if (take <= 0) continue;

      if (take === currentBoxQty) {
        await tx.pack_product_box_item.update({
          where: {
            id: Number(boxItem.id),
          },
          data: {
            goods_out_item_id: Number(target.id),
            updated_at: new Date(),
          } as any,
        });

        boxItem.quantity = 0;
      } else {
        await tx.pack_product_box_item.update({
          where: {
            id: Number(boxItem.id),
          },
          data: {
            quantity: currentBoxQty - take,
            updated_at: new Date(),
          } as any,
        });

        await tx.pack_product_box_item.create({
          data: {
            pack_product_box_id: Number(boxItem.pack_product_box_id),
            goods_out_item_id: Number(target.id),
            quantity: take,
          } as any,
        });

        boxItem.quantity = currentBoxQty - take;
      }

      targetNeed -= take;
      remaining -= take;
      movedToThisTarget += take;
      result.moved_qty += take;
    }

    if (movedToThisTarget > 0) {
      await tx.goods_out_item.update({
        where: {
          id: Number(target.id),
        },
        data: {
          pack: {
            increment: movedToThisTarget,
          },
          pick: {
            increment: movedToThisTarget,
          },
          updated_at: new Date(),
        } as any,
      });

      result.targets.push({
        goods_out_item_id: Number(target.id),
        outbound_no: target.outbound?.no ?? null,
        moved_qty: movedToThisTarget,
      });
    }
  }

  if (result.moved_qty > 0) {
    await tx.goods_out_item.update({
      where: {
        id: Number(sourceGoodsOutItem.id),
      },
      data: {
        pack: Math.max(0, sourcePack - result.moved_qty),
        pick: Math.max(0, sourcePick - result.moved_qty),
        updated_at: new Date(),
      } as any,
    });
  }

  result.remaining_qty = remaining;
  return result;
}

function detectRtcBorMode(input: {
  number?: any;
  no?: any;
  origin?: any;
  out_type?: any;
}): "RTC" | "BOR" {
  const numberText = String(input.number ?? "")
    .trim()
    .toUpperCase();
  const noText = String(input.no ?? "")
    .trim()
    .toUpperCase();
  const originText = String(input.origin ?? "")
    .trim()
    .toUpperCase();
  const outTypeText = String(input.out_type ?? "")
    .trim()
    .toUpperCase();

  if (
    numberText.includes("BOR") ||
    noText.includes("BOR") ||
    noText.includes("/BO") ||
    originText.startsWith("BO") ||
    outTypeText === "BO"
  ) {
    return "BOR";
  }

  return "RTC";
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

async function movePendingPickToOtherBatchItemsTx(params: {
  tx: any;
  sourceItem: {
    id: number;
    outbound_id: number;
    product_id: number | null;
    lot_id?: number | null;
    lot_serial?: string | null;
  };
  moveQty: number;
}): Promise<{
  moved_qty: number;
  remaining_qty: number;
  targets: Array<{
    goods_out_item_id: number;
    outbound_no: string | null;
    moved_qty: number;
  }>;
}> {
  const { tx, sourceItem } = params;
  let remaining = Math.max(0, Math.floor(Number(params.moveQty ?? 0)));

  const result = {
    moved_qty: 0,
    remaining_qty: remaining,
    targets: [] as Array<{
      goods_out_item_id: number;
      outbound_no: string | null;
      moved_qty: number;
    }>,
  };

  if (remaining <= 0) return result;
  if (!sourceItem.product_id) return result;

  const sourceBatch = await tx.batch_outbound.findFirst({
    where: {
      outbound_id: sourceItem.outbound_id,
    },
    select: {
      name: true,
    },
  });

  const batchName = String(sourceBatch?.name ?? "").trim();
  if (!batchName) return result;

  const batchOutbounds = await tx.batch_outbound.findMany({
    where: {
      name: batchName,
      outbound_id: {
        not: sourceItem.outbound_id,
      },
    },
    select: {
      outbound_id: true,
      outbound: {
        select: {
          id: true,
          no: true,
          deleted_at: true,
        },
      },
    },
    orderBy: {
      id: "asc",
    },
  });

  const targetOutboundIds = batchOutbounds
    .filter((x: any) => !x.outbound?.deleted_at)
    .map((x: any) => Number(x.outbound_id))
    .filter((x: number) => x > 0);

  if (targetOutboundIds.length === 0) return result;

  const targets = await tx.goods_out_item.findMany({
    where: {
      id: {
        not: sourceItem.id,
      },
      outbound_id: {
        in: targetOutboundIds,
      },
      deleted_at: null,
      product_id: sourceItem.product_id,
      ...(sourceItem.lot_id != null
        ? { lot_id: sourceItem.lot_id }
        : { lot_serial: sourceItem.lot_serial ?? null }),
    },
    include: {
      outbound: {
        select: {
          no: true,
        },
      },
    },
    orderBy: [{ outbound_id: "asc" }, { id: "asc" }],
  });

  for (const target of targets) {
    if (remaining <= 0) break;

    const targetQty = Math.max(0, Math.floor(Number(target.qty ?? 0)));
    const targetPick = Math.max(0, Math.floor(Number(target.pick ?? 0)));
    const capacity = Math.max(0, targetQty - targetPick);

    if (capacity <= 0) continue;

    const take = Math.min(remaining, capacity);

    await tx.goods_out_item.update({
      where: {
        id: Number(target.id),
      },
      data: {
        pick: {
          increment: take,
        },
        updated_at: new Date(),
      },
    });

    await moveLocationPicksToTargetTx({
      tx,
      sourceGoodsOutItemId: sourceItem.id,
      targetGoodsOutItemId: Number(target.id),
      moveQty: take,
    });

    remaining -= take;
    result.moved_qty += take;

    result.targets.push({
      goods_out_item_id: Number(target.id),
      outbound_no: target.outbound?.no ?? null,
      moved_qty: take,
    });
  }

  result.remaining_qty = remaining;
  return result;
}

async function moveLocationPicksToTargetTx(params: {
  tx: any;
  sourceGoodsOutItemId: number;
  targetGoodsOutItemId: number;
  moveQty: number;
}) {
  const { tx, sourceGoodsOutItemId, targetGoodsOutItemId } = params;
  let remaining = Math.max(0, Math.floor(Number(params.moveQty ?? 0)));

  if (remaining <= 0) return;

  const sourceLocPicks = await tx.goods_out_item_location_pick.findMany({
    where: {
      goods_out_item_id: sourceGoodsOutItemId,
      qty_pick: {
        gt: 0,
      },
    },
    orderBy: [{ id: "asc" }],
  });

  for (const src of sourceLocPicks) {
    if (remaining <= 0) break;

    const srcPick = Math.max(0, Math.floor(Number(src.qty_pick ?? 0)));
    const take = Math.min(remaining, srcPick);
    if (take <= 0) continue;

    await tx.goods_out_item_location_pick.upsert({
      where: {
        goods_out_item_id_location_id: {
          goods_out_item_id: targetGoodsOutItemId,
          location_id: Number(src.location_id),
        },
      },
      create: {
        goods_out_item_id: targetGoodsOutItemId,
        location_id: Number(src.location_id),
        qty_pick: take,
      },
      update: {
        qty_pick: {
          increment: take,
        },
        updated_at: new Date(),
      },
    });

    await tx.goods_out_item_location_pick.update({
      where: {
        id: Number(src.id),
      },
      data: {
        qty_pick: Math.max(0, srcPick - take),
        updated_at: new Date(),
      },
    });

    remaining -= take;
  }
}
