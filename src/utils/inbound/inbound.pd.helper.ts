import { prisma } from "../../lib/prisma";
import { badRequest } from "../appError";
import { handleInboundTransfer } from "./inbound.transfer.helper";
import { io } from "../../index";

export async function reducePackingBoxItemsForPdTx(
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

export async function handlePDAutoProcess({
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
}: {
  picking_id?: any;
  number: string;
  location_id?: any;
  location?: any;
  location_dest_id?: any;
  location_dest?: any;
  department_id?: any;
  department?: any;
  reference?: any;
  origin?: any;
  invoice?: any;
  mergedItems: any[];
}) {
  const pdOrigin = String(origin ?? "").trim();
  const pdInvoice = String(invoice ?? "").trim();

  const refs = Array.from(new Set([pdOrigin, pdInvoice].filter(Boolean)));

  if (refs.length === 0) {
    throw badRequest(`PD ${number} ไม่พบ origin/invoice สำหรับเทียบ outbound`);
  }

  const outbound = await prisma.outbound.findFirst({
    where: {
      deleted_at: null,
      OR: refs.flatMap((ref) => [
        {
          origin: {
            equals: ref,
            mode: "insensitive" as const,
          },
        },
        {
          invoice: {
            equals: ref,
            mode: "insensitive" as const,
          },
        },
      ]),
    },
    select: {
      id: true,
      no: true,
      origin: true,
      invoice: true,
      in_process: true,
    } as any,
  });

  if (!outbound) {
    throw badRequest(
      `PD ${number} ไม่พบ outbound จาก origin/invoice: ${pdOrigin || "-"} / ${
        pdInvoice || "-"
      }`,
    );
  }

  const matchedBy = refs.some(
    (ref) =>
      String(outbound.origin ?? "")
        .trim()
        .toLowerCase() === ref.toLowerCase(),
  )
    ? "origin"
    : refs.some(
          (ref) =>
            String(outbound.invoice ?? "")
              .trim()
              .toLowerCase() === ref.toLowerCase(),
        )
      ? "invoice"
      : "unknown";

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
      source: "pd",
      mode: "packing_pd_detected",
      pd_no: number,
      outbound_id: outbound.id,
      outbound_no: outbound.no,
      origin: pdOrigin,
      invoice: pdInvoice,
      pack_product_id: packing.pack_product_id,
      pack_product_name: null,
      items: mergedItems,
    };

    try {
      io.to(`pack_product:${packing.pack_product_id}`).emit(
        "packing:pd_detected",
        payload,
      );
      io.to(`outbound:${outbound.no}`).emit("packing:pd_detected", payload);
      io.emit("packing:pd_detected", payload);
    } catch {}

    // ห้าม return ตรงนี้
  }

  // ✅ ใช้ flow เดิมของ inbound helper
  // ✅ แก้ error tx.inbound.create() Argument date is missing เพราะไม่ create เองแล้ว
  const inbound = await handleInboundTransfer({
    picking_id,
    number,
    location_id,
    location,
    location_dest_id,
    location_dest,
    department_id,
    department,
    reference,
    origin: pdOrigin,
    invoice: pdInvoice,
    mergedItems,
  });

  if (!inbound?.id) {
    throw badRequest(`PD ${number} สร้าง Inbound ไม่สำเร็จ`);
  }

  const noPickItems = await prisma.goods_out_item.findMany({
    where: {
      outbound_id: Number(outbound.id),
      deleted_at: null,
    },
    select: {
      pick: true,
      pack: true,
    } as any,
  });

  const totalPickedOrPacked = noPickItems.reduce((sum: number, row: any) => {
    return (
      sum +
      Math.max(0, Number(row.pick ?? 0)) +
      Math.max(0, Number(row.pack ?? 0))
    );
  }, 0);

  if (totalPickedOrPacked <= 0) {
    await prisma.inbound.update({
      where: { id: Number(inbound.id) },
      data: {
        status: "completed",
        updated_at: new Date(),
      } as any,
    });
  }

  const result = await prisma.$transaction(async (tx) => {
    const outboundItems = await tx.goods_out_item.findMany({
      where: {
        outbound_id: Number(outbound.id),
        deleted_at: null,
      },
      orderBy: [{ sequence: "asc" }, { id: "asc" }],
    });

    const affected: any[] = [];
    const ignored: any[] = [];
    const packingBoxAffected: any[] = [];

    for (const item of mergedItems) {
      const productId =
        item.product_id != null ? Number(item.product_id) : null;
      const lotId = item.lot_id != null ? Number(item.lot_id) : null;
      const lotSerial = String(item.lot_serial ?? item.lot_name ?? "").trim();

      const pdQty = Math.max(
        0,
        Number(item.quantity ?? item.qty ?? item.product_uom_qty ?? 0),
      );

      if (!productId || pdQty <= 0) {
        ignored.push({
          reason: "invalid_product_or_qty",
          item,
        });
        continue;
      }

      const match = outboundItems.find((go: any) => {
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
          reason: "outbound_item_not_found",
          product_id: productId,
          lot_id: lotId,
          lot_serial: lotSerial || null,
          pd_qty: pdQty,
        });
        continue;
      }

      const currentQty = Math.max(0, Number(match.qty ?? 0));
      const currentPd = Math.max(0, Number(match.pd ?? 0));
      const currentRtc = Math.max(0, Number(match.rtc ?? 0));
      const currentBor = Math.max(0, Number(match.bor ?? 0));
      const currentReturn = Math.max(0, Number(match.return ?? 0));
      const currentPack = Math.max(0, Number(match.pack ?? 0));

      const currentRemain = Math.max(
        0,
        currentQty - currentPd - currentRtc - currentBor - currentReturn,
      );

      const pdApplyQty = Math.min(currentRemain, pdQty);
      const nextPd = currentPd + pdApplyQty;

      // ✅ สำคัญ: ถ้า Packing แล้ว ห้ามลด pack / ห้ามลบของในกล่อง
      await tx.goods_out_item.update({
        where: { id: match.id },
        data: {
          pd: nextPd,
          updated_at: new Date(),
        } as any,
      });

      affected.push({
        pd_no: number,
        outbound_no: outbound.no,
        goods_out_item_id: match.id,
        product_id: productId,
        lot_id: lotId,
        lot_serial: match.lot_serial ?? lotSerial ?? null,
        old_qty: currentQty,
        current_pd: currentPd,
        current_pick: Number(match.pick ?? 0),
        current_pack: Number(match.pack ?? 0),
        pd_qty: pdApplyQty,
        new_qty: currentQty,
        new_pd: nextPd,
        remaining_qty: Math.max(
          0,
          currentQty - nextPd - currentRtc - currentBor - currentReturn,
        ),
        action: "pd_increment",
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
    let pack_product_action: "keep" | "remove_from_pack" = "keep";

    if (remainingActiveItems === 0) {
      await tx.outbound.update({
        where: { id: Number(outbound.id) },
        data: {
          deleted_at: new Date(),
          updated_at: new Date(),
        } as any,
      });

      outbound_action = "soft_delete";
      pack_product_action = "keep";
    } else {
      await tx.outbound.update({
        where: { id: Number(outbound.id) },
        data: {
          updated_at: new Date(),
        } as any,
      });

      outbound_action = "keep";
      pack_product_action = "keep";
    }

    return {
      source: "pd",
      pd_no: number,
      outbound_id: outbound.id,
      outbound_no: outbound.no,
      outbound_origin: outbound.origin,
      outbound_invoice: outbound.invoice,
      inbound_id: inbound?.id ?? null,
      inbound_no: inbound?.no ?? number,
      mode: "auto_process",
      matched_by: matchedBy,
      affected,
      ignored,
      packing_box_affected: packingBoxAffected,
      remaining_active_items: remainingActiveItems,
      outbound_action,
      pack_product_action,
      data: inbound,
    };
  });

  const hasPickOverAfterPd = result.affected.some((x: any) => {
    const currentPick = Number(x.current_pick ?? 0);
    const newQty = Number(x.new_qty ?? 0);

    return currentPick > 0 && currentPick >= newQty;
  });

  const hasPickedButNotOverAfterPd =
    totalPickedOrPacked > 0 && !hasPickOverAfterPd;

  try {
    io.to(`outbound:${outbound.no}`).emit("outbound:pd_updated", result);

    // ✅ case 1: no pick yet
    if (totalPickedOrPacked <= 0) {
      io.to(`outbound:${outbound.no}`).emit("outbound:pd_pending", {
        ...result,
        mode: "pd_pending_no_pick",
        items: mergedItems,
      });
    }

    // ✅ case 2: PD เข้ามาระหว่าง pick แล้ว
    // มี pick/pack แล้ว ให้ inbound PD completed ไปเลย
    if (totalPickedOrPacked > 0) {
      await prisma.inbound.update({
        where: { id: Number(inbound.id) },
        data: {
          status: "completed",
          updated_at: new Date(),
        } as any,
      });
    }

    // ✅ case 3: picked but still not over
    if (hasPickedButNotOverAfterPd) {
      io.to(`outbound:${outbound.no}`).emit("outbound:pd_picked", {
        ...result,
        mode: "pd_picked_auto_process",
        items: mergedItems,
      });
    }

    // ✅ case 4: pick >= remaining qty after PD reduce
    if (hasPickOverAfterPd) {
      io.to(`outbound:${outbound.no}`).emit("outbound:pd_pick_over", {
        ...result,
        mode: "pd_pick_over_after_reduce_qty",
        items: mergedItems,
      });
    }

    // ✅ case 5: inside pack product
    if (packing?.pack_product_id) {
      const packPayload = {
        ...result,
        mode:
          totalPickedOrPacked <= 0
            ? "pd_pending_no_pick_in_pack_product"
            : "pd_picked_in_pack_product",
        items: mergedItems,
      };

      io.to(`pack_product:${packing.pack_product_id}`).emit(
        "pack_product:updated",
        {
          pack_product_id: packing.pack_product_id,
          reason:
            totalPickedOrPacked <= 0
              ? "pd_auto_completed_no_pick"
              : "pd_auto_process_picked",
          data: packPayload,
        },
      );

      io.to(`pack_product:${packing.pack_product_id}`).emit(
        "packing:pd_detected",
        packPayload,
      );
    }
  } catch {}

  return result;
}
