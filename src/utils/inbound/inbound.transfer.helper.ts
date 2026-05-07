import { prisma } from "../../lib/prisma";
import { badRequest } from "../appError";
import {
  inferInTypeFromNumber,
  NormalizedInboundItem,
} from "./inbound.normalize.helper";
import {
  hydrateInboundItemsBarcodeTextFromGoodsIn,
  hydrateInboundItemsBarcodeTextFromBarcodeMaster,
} from "./inbound.barcode.helper";
import { goodsInMatchKey } from "./inbound.key.helper";
import { buildWmsGoodsExpMap, resolveInboundExp } from "./inbound.wms.helper";

/**
 * =========================
 * ✅ NEW: handler Inbound (โค้ดเดิมของคุณ "ย้ายมาใส่ฟังก์ชัน" เพื่อไม่ปน TF)
 * =========================
 * หมายเหตุ: Logic ภายในคงเดิมตามที่คุณส่งมา (แค่ย้ายห่อ)
 */
export async function handleInboundTransfer(input: {
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

  const convertedReference =
    typeof reference === "boolean"
      ? reference
        ? "true"
        : null
      : reference || null;

  const convertedInvoice =
    invoice === null || invoice === undefined
      ? null
      : String(invoice).trim() || null;

  const convertedOrigin =
    typeof origin === "string" ? origin : origin ? String(origin) : null;

  const header = await prisma.$transaction(async (tx) => {
    let hydratedItems = await hydrateInboundItemsBarcodeTextFromGoodsIn(
      tx,
      mergedItems,
    );

    // ✅ NEW: fallback จาก barcode master
    hydratedItems = await hydrateInboundItemsBarcodeTextFromBarcodeMaster(
      tx,
      hydratedItems,
    );
    const wmsExpMap = await buildWmsGoodsExpMap(tx, hydratedItems);

    // 1) upsert inbound header
    const existing = await tx.inbound.findFirst({
      where: { no: number, deleted_at: null },
    });

    const inType = inferInTypeFromNumber(String(number));

    const inbound = existing
      ? await tx.inbound.update({
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
            invoice: convertedInvoice,
            in_type: inType,
            updated_at: new Date(),
          },
        })
      : await tx.inbound.create({
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
            invoice: convertedInvoice,
            date: new Date(),
            in_type: inType,
          },
        });

    // preload goods_in ของ inbound นี้ (เฉพาะที่ยังไม่ถูกลบ)
    const existingLines = await tx.goods_in.findMany({
      where: { inbound_id: inbound.id, deleted_at: null },
      select: {
        id: true,
        sequence: true,
        product_id: true,
        lot_serial: true,
        in_process: true,
        quantity_receive: true,
        qty: true,
      },
    });

    // map เฉพาะตัวที่ in_process=false (ตัวที่ยัง “ต่อยอด qty” ได้)
    const openMap = new Map<string, (typeof existingLines)[number]>();
    for (const r of existingLines) {
      if (r.product_id == null) continue;
      if (r.in_process) continue; // ✅ ถ้า process จบแล้ว ห้าม merge
      openMap.set(
        goodsInMatchKey({
          product_id: r.product_id,
          lot_serial: r.lot_serial,
        }),
        r,
      );
    }

    // ใช้ sequence ต่อจากของเดิมเมื่อจำเป็นต้อง create ใหม่
    const maxSeq = existingLines.reduce(
      (m, x) => Math.max(m, Number(x.sequence ?? 0)),
      0,
    );
    let nextSeq = maxSeq + 1;

    for (let i = 0; i < hydratedItems.length; i++) {
      const item = hydratedItems[i];

      if (item.product_id == null) {
        throw badRequest(`Odoo item missing product_id (inbound: ${number})`);
      }
      if (!item.name || !item.unit) {
        throw badRequest(
          `Odoo item missing name/unit (inbound: ${number}, product_id: ${item.product_id})`,
        );
      }

      const lotSerial = item.lot_serial ?? null;
      const key = goodsInMatchKey({
        product_id: item.product_id,
        lot_serial: lotSerial,
      });

      const match = openMap.get(key);

      // ✅ CASE 1: match + in_process=false => update เพิ่ม qty
      if (match) {
        const add = Number(item.qty ?? 0);
        if (!Number.isFinite(add) || add <= 0) continue;

        await tx.goods_in.update({
          where: { id: match.id },
          data: {
            // ✅ เพิ่มทั้ง qty และ quantity_receive (คง quantity_count เดิมไว้)
            qty: { increment: add },
            quantity_receive: { increment: add },
            ...(item.barcode_text
              ? {
                  barcode_text: item.barcode_text,
                }
              : {}),
            updated_at: new Date(),
          } as any,
        });

        // update cache เผื่อมีซ้ำหลุดมา (แม้ mergeInboundItems จะกันแล้ว)
        (match as any).qty = Number(match.qty ?? 0) + add;
        (match as any).quantity_receive =
          Number(match.quantity_receive ?? 0) + add;

        continue;
      }

      // ✅ CASE 2: ไม่ match (หรือ match แต่ตัวเก่า in_process=true จะไม่อยู่ใน openMap) => create ใหม่
      const finalSeq = item.sequence ?? nextSeq++;
      await tx.goods_in.create({
        data: {
          inbound_id: inbound.id,
          sequence: finalSeq,
          odoo_sequence: finalSeq,
          odoo_line_key: `${number}-${finalSeq}`,

          product_id: item.product_id,
          code: item.code ?? undefined,
          name: item.name!,
          unit: item.unit!,
          tracking: item.tracking ?? undefined,

          // ✅ ยังเก็บ lot_id ได้ (ไม่ทำให้ flow อื่นพัง)
          lot_id: item.lot_id ?? undefined,

          // ✅ ใช้ lot_serial เป็น lot_name ด้วย
          lot_serial: item.lot_serial ?? undefined,
          lot: item.lot_serial ?? undefined,

          qty: item.qty,
          quantity_receive: item.qty,
          quantity_count: 0,

          barcode_text: item.barcode_text ?? undefined,
          exp: resolveInboundExp(item, wmsExpMap),

          updated_at: new Date(),
        },
      });
    }

    return inbound;
  });

  const fullInbound = await prisma.inbound.findUnique({
    where: { id: header.id },
    include: {
      goods_ins: {
        where: { deleted_at: null },
        orderBy: { sequence: "asc" },
      },
    },
  });

  return fullInbound;
}

export async function handleTFTransfer(input: {
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
    // 1) upsert transfer_doc header
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

    /**
     * ✅ policy เหมือน inbound:
     * - match product_id + lot_serial
     * - ถ้า match และ in_process=false => +qty
     * - ถ้า in_process=true => create ใหม่
     */
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
      },
    });

    const openMap = new Map<string, (typeof existingLines)[number]>();
    for (const r of existingLines) {
      if (r.product_id == null) continue;
      if (r.in_process) continue;
      openMap.set(
        goodsInMatchKey({ product_id: r.product_id, lot_serial: r.lot_serial }),
        r,
      );
    }

    const maxSeq = existingLines.reduce(
      (m, x) => Math.max(m, Number(x.sequence ?? 0)),
      0,
    );
    let nextSeq = maxSeq + 1;
    const wmsExpMap = await buildWmsGoodsExpMap(tx, mergedItems);

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

      const lotSerial = item.lot_serial ?? null;
      const key = goodsInMatchKey({
        product_id: item.product_id,
        lot_serial: lotSerial,
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
          exp: resolveInboundExp(item, wmsExpMap),

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
