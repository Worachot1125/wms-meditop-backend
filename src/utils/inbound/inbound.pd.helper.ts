import { prisma } from "../../lib/prisma";
import { badRequest } from "../appError";
import { NormalizedInboundItem } from "./inbound.normalize.helper";
import { handleInboundTransfer } from "./inbound.transfer.helper";
import { io } from "../../index";

type PdMatchedOutbound = {
  id: number;
  no: string;
  origin: string | null;
  invoice: string | null;
  in_process: boolean | null;
};

const normalizePdDocRef = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLowerCase();

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
  const pdInvoice = String(invoice ?? "").trim();

  const createNormalInbound = async (reason: string) => {
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
      origin,
      invoice,
      mergedItems,
    });

    return {
      source: "pd",
      pd_no: number,
      mode: "normal_inbound",
      reason,
      origin,
      invoice,
      data: inbound,
    };
  };

  const rawOutbounds = await prisma.outbound.findMany({
    where: {
      deleted_at: null,
    },
    select: {
      id: true,
      no: true,
      origin: true,
      invoice: true,
      in_process: true,
    } as any,
  });

  const allOutbounds: PdMatchedOutbound[] = (rawOutbounds as any[]).map(
    (o) => ({
      id: Number(o.id),
      no: String(o.no ?? ""),
      origin: o.origin ?? null,
      invoice: o.invoice ?? null,
      in_process: Boolean(o.in_process),
    }),
  );

  const outbound: PdMatchedOutbound | null =
    allOutbounds.find((o) => {
      const outOrigin = normalizePdDocRef(o.origin);
      const outInvoice = normalizePdDocRef(o.invoice);
      const originRef = normalizePdDocRef(pdOrigin);
      const invoiceRef = normalizePdDocRef(pdInvoice);

      return (
        (originRef && originRef === outOrigin) ||
        (originRef && originRef === outInvoice) ||
        (invoiceRef && invoiceRef === outOrigin) ||
        (invoiceRef && invoiceRef === outInvoice)
      );
    }) ?? null;

  if (!outbound) {
    return createNormalInbound("outbound_not_found");
  }

  if (Boolean(outbound.in_process)) {
    return createNormalInbound("outbound_already_in_process");
  }

  const outboundId = Number(outbound.id);
  const outboundNo = String(outbound.no);
  const outboundOrigin = outbound.origin ?? null;
  const outboundInvoice = outbound.invoice ?? null;

  const matchedBy =
    normalizePdDocRef(outbound.origin) === normalizePdDocRef(pdOrigin)
      ? "origin"
      : normalizePdDocRef(outbound.invoice) === normalizePdDocRef(pdInvoice)
        ? "invoice"
        : normalizePdDocRef(outbound.invoice) === normalizePdDocRef(pdOrigin)
          ? "pd_origin_to_outbound_invoice"
          : normalizePdDocRef(outbound.origin) === normalizePdDocRef(pdInvoice)
            ? "pd_invoice_to_outbound_origin"
            : "unknown";

  const inbound = await handleInboundTransfer({
    picking_id,
    number,
    location_id,
    location,
    location_dest_id,
    location_dest,
    department_id,
    department,
    reference: reference || `[PD] ${outboundNo}`,
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
        outbound_id: outboundId,
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
      const nextQty = currentQty - pdQty;

      if (nextQty <= 0) {
        await tx.goods_out_item.update({
          where: { id: Number(match.id) },
          data: {
            deleted_at: new Date(),
            updated_at: new Date(),
          } as any,
        });

        affected.push({
          pd_no: number,
          outbound_no: outboundNo,
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
        where: { id: Number(match.id) },
        data: {
          qty: nextQty,
          updated_at: new Date(),
        } as any,
      });

      affected.push({
        pd_no: number,
        outbound_no: outboundNo,
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
        outbound_id: outboundId,
        deleted_at: null,
      },
    });

    let outbound_action: "keep" | "soft_delete" = "keep";

    if (remainingActiveItems === 0) {
      await tx.outbound.update({
        where: { id: outboundId },
        data: {
          deleted_at: new Date(),
          updated_at: new Date(),
        } as any,
      });

      outbound_action = "soft_delete";
    } else {
      await tx.outbound.update({
        where: { id: outboundId },
        data: {
          updated_at: new Date(),
        } as any,
      });
    }

    return {
      source: "pd",
      pd_no: number,
      outbound_id: outboundId,
      outbound_no: outboundNo,
      outbound_origin: outboundOrigin,
      outbound_invoice: outboundInvoice,
      inbound_id: inboundId,
      inbound_no: inboundNo,
      mode: "auto_process",
      matched_by: matchedBy,
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
