import type { swap, swap_item, department } from "@prisma/client";
import { prisma } from "../../lib/prisma";

function swapExpKey(product_id: number | null, lot_id: number | null) {
  return `p:${product_id ?? "null"}|lot:${lot_id ?? "null"}`;
}

export async function buildGoodsInExpMapForSwapItems(
  items: Array<{ product_id: number | null; lot_id: number | null }>,
) {
  const productIds = Array.from(
    new Set(
      items
        .map((x) => x.product_id)
        .filter(
          (x): x is number => typeof x === "number" && Number.isFinite(x),
        ),
    ),
  );

  const lotIds = Array.from(
    new Set(
      items
        .map((x) => x.lot_id)
        .filter(
          (x): x is number => typeof x === "number" && Number.isFinite(x),
        ),
    ),
  );

  const map = new Map<string, Date | null>();
  if (productIds.length === 0 || lotIds.length === 0) return map;

  const rows = await prisma.goods_in.findMany({
    where: {
      deleted_at: null,
      product_id: { in: productIds },
      lot_id: { in: lotIds },
      exp: { not: null },
    },
    select: {
      product_id: true,
      lot_id: true,
      exp: true,
      updated_at: true,
      created_at: true,
    },
    orderBy: [{ updated_at: "desc" }, { created_at: "desc" }],
  });

  for (const row of rows) {
    const key = swapExpKey(row.product_id ?? null, row.lot_id ?? null);
    if (!map.has(key)) {
      map.set(key, row.exp ?? null);
    }
  }

  return map;
}

export interface OdooSwapItemFormatter {
  id: number;
  swap_id: number;
  source_sequence: number | null;
  odoo_line_key: string | null;

  product_id: number | null;
  code: string | null;
  name: string | null;
  unit: string | null;
  tracking: string | null;

  lot_id: number | null;
  lot_serial: string | null;
  barcode_text: string | null;
  expiration_date: string | null;

  system_qty: number;
  executed_qty: number;

  created_at: string;
  updated_at: string | null;
}

export interface OdooSwapFormatter {
  id: number;
  picking_id: number | null;
  no: string | null;
  name: string | null;

  odoo_location_id: number | null;
  source_location_id: number | null;
  source_location: string | null;

  odoo_location_dest_id: number | null;
  dest_location_id: number | null;
  dest_location: string | null;

  location_id: number | null;
  location_name: string | null;
  location_dest_id: number | null;
  location_dest_name: string | null;
  barcode_text: string | null;
  expiration_date: string | null;
  exp: string | null;

  department_id: number | null;
  department: string | null;

  status: string | null;
  user_ref: string | null;
  remark: string | null;
  origin: string | null;
  reference: string | null;

  created_at: string;
  updated_at: string | null;

  items: OdooSwapItemFormatter[];
}

export function formatOdooSwap(
  doc: swap & {
    department?: department | null;
    swapItems?: (swap_item & { deleted_at?: Date | null })[];
  },
  goodsInExpMap?: Map<string, Date | null>,
): OdooSwapFormatter {
  const items = (doc.swapItems ?? [])
    .filter((item) => !item.deleted_at)
    .map((item) => {
      const fallbackExp =
        goodsInExpMap?.get(
          swapExpKey(item.product_id ?? null, item.lot_id ?? null),
        ) ?? null;

      const finalExp = item.expiration_date ?? fallbackExp ?? null;

      return {
        id: item.id,
        swap_id: item.swap_id,
        source_sequence: item.source_sequence ?? null,
        odoo_line_key: item.odoo_line_key ?? null,

        product_id: item.product_id ?? null,
        code: item.code ?? null,
        name: item.name ?? null,
        unit: item.unit ?? null,
        tracking: item.tracking ?? null,

        lot_id: item.lot_id ?? null,
        lot_serial: item.lot_serial ?? null,
        barcode_text: item.barcode_text ?? null,

        expiration_date: finalExp ? finalExp.toISOString() : null,

        system_qty: Number(item.system_qty ?? 0),
        executed_qty: Number(item.executed_qty ?? 0),

        created_at: item.created_at.toISOString(),
        updated_at: item.updated_at ? item.updated_at.toISOString() : null,
      };
    });

  // เอา exp จาก item ตัวแรก (ถ้าต้องการแสดงที่ header)
  const firstExp = items.length > 0 ? items[0].expiration_date : null;

  return {
    id: doc.id,
    picking_id: doc.picking_id ?? null,
    no: doc.no ?? null,
    name: doc.name ?? null,

    odoo_location_id: doc.odoo_location_id ?? null,
    source_location_id: doc.source_location_id ?? null,
    source_location: doc.source_location ?? null,

    odoo_location_dest_id: doc.odoo_location_dest_id ?? null,
    dest_location_id: doc.dest_location_id ?? null,
    dest_location: doc.dest_location ?? null,

    location_id: doc.location_id ?? null,
    location_name: doc.location_name ?? null,

    location_dest_id: doc.location_dest_id ?? null,
    location_dest_name: doc.location_dest_name ?? null,

    barcode_text: null, // ถ้าไม่มีใน swap header
    expiration_date: firstExp,
    exp: firstExp,

    department_id: doc.department_id ?? null,
    department: doc.department?.short_name ?? null,

    status: doc.status ?? null,
    user_ref: doc.user_ref ?? null,
    remark: doc.remark ?? null,
    origin: doc.origin ?? null,
    reference: doc.reference ?? null,

    created_at: doc.created_at.toISOString(),
    updated_at: doc.updated_at ? doc.updated_at.toISOString() : null,

    items,
  };
}
