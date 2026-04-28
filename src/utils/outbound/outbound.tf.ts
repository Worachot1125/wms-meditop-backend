import { prisma } from "../../lib/prisma";
import { badRequest } from "../appError";
import type { TFLine } from "./outbound.type";
import {
  normalizeLotSerial,
  toDateOnlyKey,
  toExpDate,
} from "./outbound.parse";

export function goodsInMatchKey(input: {
  product_id: number;
  lot_serial?: any;
  exp?: Date | string | null;
}) {
  return `p:${input.product_id}|lot:${normalizeLotSerial(
    input.lot_serial,
  )}|exp:${toDateOnlyKey(input.exp ?? null) ?? "null"}`;
}

export async function handleTFTransferOutbound(input: {
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
  mergedItems: TFLine[];
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
    mergedItems,
  } = input;

  const convertedReference =
    typeof reference === "boolean"
      ? reference
        ? "true"
        : null
      : reference || null;

  const convertedOrigin =
    typeof origin === "string" ? origin : origin ? String(origin) : null;

  const header = await prisma.$transaction(async (tx) => {
    const existing = await tx.transfer_doc.findFirst({
      where: { no: number, deleted_at: null },
    });

    const doc = existing
      ? await tx.transfer_doc.update({
          where: { id: existing.id },
          data: {
            picking_id,
            location_id,
            location,
            location_dest_id,
            location_dest,
            department_id: department_id?.toString(),
            department,
            reference: convertedReference,
            origin: convertedOrigin,
            in_type: "TF",
            updated_at: new Date(),
          },
        })
      : await tx.transfer_doc.create({
          data: {
            no: number,
            picking_id,
            location_id,
            location,
            location_dest_id,
            location_dest,
            department_id: department_id?.toString(),
            department,
            reference: convertedReference,
            origin: convertedOrigin,
            date: new Date(),
            in_type: "TF",
          },
        });

    const existingLines = await tx.transfer_doc_item.findMany({
      where: { transfer_doc_id: doc.id, deleted_at: null },
      select: {
        id: true,
        sequence: true,
        product_id: true,
        lot_serial: true,
        in_process: true,
        quantity_receive: true,
        qty: true,
        exp: true,
      },
    });

    const openMap = new Map<string, (typeof existingLines)[number]>();
    for (const r of existingLines) {
      if (r.product_id == null) continue;
      if (r.in_process) continue;

      openMap.set(
        goodsInMatchKey({
          product_id: r.product_id,
          lot_serial: r.lot_serial,
          exp: r.exp ?? null,
        }),
        r,
      );
    }

    const maxSeq = existingLines.reduce(
      (m, x) => Math.max(m, Number(x.sequence ?? 0)),
      0,
    );
    let nextSeq = maxSeq + 1;

    for (let i = 0; i < mergedItems.length; i++) {
      const item = mergedItems[i];

      if (item.product_id == null) {
        throw badRequest(`Odoo item missing product_id (TF: ${number})`);
      }
      if (!item.name || !item.unit) {
        throw badRequest(
          `Odoo item missing name/unit (TF: ${number}, product_id: ${item.product_id})`,
        );
      }

      const exp = item.exp ?? toExpDate(item.expire_date ?? null) ?? null;
      const lotSerial = item.lot_serial ?? null;

      const key = goodsInMatchKey({
        product_id: item.product_id,
        lot_serial: lotSerial,
        exp,
      });

      const match = openMap.get(key);

      if (match) {
        const add = Number(item.qty ?? 0);
        if (!Number.isFinite(add) || add <= 0) continue;

        await tx.transfer_doc_item.update({
          where: { id: match.id },
          data: {
            qty: { increment: add },
            quantity_receive: { increment: add },
            updated_at: new Date(),
          } as any,
        });

        (match as any).qty = Number(match.qty ?? 0) + add;
        (match as any).quantity_receive =
          Number(match.quantity_receive ?? 0) + add;
        continue;
      }

      const finalSeq = item.sequence ?? nextSeq++;
      await tx.transfer_doc_item.create({
        data: {
          transfer_doc_id: doc.id,
          sequence: finalSeq,
          odoo_sequence: finalSeq,
          odoo_line_key: `${number}-${finalSeq}`,

          product_id: item.product_id,
          code: item.code ?? undefined,
          name: item.name!,
          unit: item.unit!,
          tracking: item.tracking ?? undefined,

          lot_id: item.lot_id ?? undefined,
          lot_serial: item.lot_serial ?? undefined,
          lot: item.lot_serial ?? undefined,

          qty: item.qty,
          quantity_receive: item.qty,
          quantity_count: 0,

          barcode_text: item.barcode_text ?? undefined,
          exp: exp ?? undefined,

          updated_at: new Date(),
        },
      });
    }

    return doc;
  });

  const fullDoc = await prisma.transfer_doc.findUnique({
    where: { id: header.id },
    include: {
      transfer_doc_items: {
        where: { deleted_at: null },
        orderBy: { sequence: "asc" },
      },
    },
  });

  return fullDoc;
}