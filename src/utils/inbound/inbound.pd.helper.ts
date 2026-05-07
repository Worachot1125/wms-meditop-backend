import { prisma } from "../../lib/prisma";
import { badRequest } from "../appError";
import { NormalizedInboundItem } from "./inbound.normalize.helper";
import { handleInboundTransfer } from "./inbound.transfer.helper";
import { io } from "../../index";

export async function handlePDAutoProcess(input: {
  picking_id: any;
  number: string;
  location_id: any;
  location: any;
  location_dest_id: any;
  location_dest: any;
  department_id: any;
  department: any;
  reference: any;
  origin: any;
  invoice: any;
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

  const pdOrigin = String(origin ?? "").trim();

  if (!pdOrigin) {
    throw badRequest(
      `PD ${number} ไม่พบ origin สำหรับใช้เทียบกับ outbound.origin`,
    );
  }

  const outbound = await prisma.outbound.findFirst({
    where: {
      deleted_at: null,
      origin: {
        equals: pdOrigin,
        mode: "insensitive",
      },
    },
    select: {
      id: true,
      no: true,
      origin: true,
    },
  });

  if (!outbound) {
    throw badRequest(`PD ${number} ไม่พบ outbound จาก origin: ${pdOrigin}`);
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
    reference: reference || `[PD] ${outbound.no}`,
    origin,
    invoice,
    mergedItems,
  });

  if (!inbound || inbound.id == null) {
    throw badRequest(`PD ${number} สร้าง inbound ไม่สำเร็จ`);
  }

  const inboundId = Number(inbound.id);
  const inboundNo = String((inbound as any).no ?? number);

  const result = await prisma.$transaction(async (tx) => {
    await tx.inbound.update({
      where: { id: inboundId },
      data: {
        status: "completed",
        updated_at: new Date(),
      } as any,
    });

    await tx.goods_in.updateMany({
      where: {
        inbound_id: inboundId,
        deleted_at: null,
      },
      data: {
        quantity_count: 0,
        updated_at: new Date(),
      } as any,
    });

    const dbItems = await tx.goods_out_item.findMany({
      where: {
        outbound_id: outbound.id,
        deleted_at: null,
      },
      select: {
        id: true,
        product_id: true,
        lot_id: true,
        lot_serial: true,
        qty: true,
        pick: true,
        pack: true,
      },
    });

    const itemMap = new Map<string, (typeof dbItems)[number]>();

    for (const row of dbItems) {
      const key = `${row.product_id ?? "null"}__${row.lot_id ?? "null"}`;
      if (!itemMap.has(key)) itemMap.set(key, row);
    }

    const affected: any[] = [];
    const ignored: any[] = [];

    for (const item of mergedItems) {
      const product_id = item.product_id ?? null;
      const lot_id = item.lot_id ?? null;
      const pdQty = Math.max(0, Math.floor(Number(item.qty ?? 0)));

      if (product_id == null || pdQty <= 0) {
        ignored.push({
          product_id,
          lot_id,
          lot_serial: item.lot_serial ?? null,
          qty: pdQty,
          reason: product_id == null ? "missing_product_id" : "invalid_qty",
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
          qty: pdQty,
          reason: "goods_out_item_not_found",
        });
        continue;
      }

      const currentQty = Math.max(0, Math.floor(Number(match.qty ?? 0)));
      const currentPick = Math.max(0, Math.floor(Number(match.pick ?? 0)));

      if (currentPick > 0) {
        await tx.goods_out_item.update({
          where: { id: match.id },
          data: {
            rtc_check: true,
            updated_at: new Date(),
          } as any,
        });

        affected.push({
          pd_no: number,
          outbound_no: outbound.no,
          goods_out_item_id: match.id,
          product_id,
          lot_id,
          lot_serial: match.lot_serial ?? item.lot_serial ?? null,
          old_qty: currentQty,
          pd_qty: pdQty,
          new_qty: currentQty,
          action: "rtc_check_only",
        });

        continue;
      }

      const nextQty = currentQty - pdQty;

      if (nextQty <= 0) {
        await tx.goods_out_item.update({
          where: { id: match.id },
          data: {
            deleted_at: new Date(),
            updated_at: new Date(),
          },
        });

        affected.push({
          pd_no: number,
          outbound_no: outbound.no,
          goods_out_item_id: match.id,
          product_id,
          lot_id,
          lot_serial: match.lot_serial ?? item.lot_serial ?? null,
          old_qty: currentQty,
          pd_qty: pdQty,
          new_qty: 0,
          action: "soft_delete",
        });

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
        pd_no: number,
        outbound_no: outbound.no,
        goods_out_item_id: match.id,
        product_id,
        lot_id,
        lot_serial: match.lot_serial ?? item.lot_serial ?? null,
        old_qty: currentQty,
        pd_qty: pdQty,
        new_qty: nextQty,
        action: "decrement",
      });
    }

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
    } else {
      await tx.outbound.update({
        where: { id: outbound.id },
        data: {
          updated_at: new Date(),
        },
      });
    }

    return {
      source: "pd",
      pd_no: number,
      outbound_id: outbound.id,
      outbound_no: outbound.no,
      outbound_origin: outbound.origin,
      inbound_id: inboundId,
      inbound_no: inboundNo,
      mode: "auto_process",
      status: "completed",
      matched_by_origin: pdOrigin,
      affected,
      ignored,
      remaining_active_items: remainingActiveItems,
      outbound_action,
      data: inbound,
    };
  });

  try {
    io.to(`outbound:${result.outbound_no}`).emit(
      "outbound:pd_adjusted",
      result,
    );
    io.to(`outbound-id:${result.outbound_id}`).emit(
      "outbound:pd_adjusted",
      result,
    );
    io.emit("outbound:pd_adjusted", result);
    io.emit("inbound:updated", result);
  } catch {}

  return result;
}
