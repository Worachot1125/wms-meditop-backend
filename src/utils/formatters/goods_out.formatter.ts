import type { goods_out, lot, goods_out_box, box } from "@prisma/client";

export interface GoodsOutFormatter {
  id: string;
  sku: string;
  barcode: string;
  name: string;
  lock_no: string;
  lock_name: string;

  lot_no: string;
  lot: { no: string; name: string | null } | null;

  box_id: string | null;

  boxes: { id: string; box_id: string; box_name: string | null }[]; // หรือคืน box detail ก็ได้

  created_at: string;
  updated_at: string | null;
  deleted_at: string | null;
}

export function formatGoodsOut(
  s: goods_out & {
    lot?: lot | null;
    boxes?: (goods_out_box & { box?: box | null })[] | null;
    deleted_at?: Date | null;
  },
): GoodsOutFormatter {
  return {
    id: s.id,
    sku: s.sku,
    barcode: s.barcode,
    name: s.name,
    lock_no: s.lock_no,
    lock_name: s.lock_name,

    lot_no: s.lot_no,
    lot: s.lot ? { no: s.lot.no, name: s.lot.name ?? null } : null,

    box_id: s.box_id ? s.box_id.toString() : null,

    boxes: (s.boxes ?? [])
      .map((b) => b.box)
      .filter((x): x is box => !!x)
      .map((b) => ({ id: b.id.toString(), box_id: b.id.toString(), box_name: b.box_name ?? null })),

    created_at: s.created_at.toISOString(),
    updated_at: s.updated_at ? s.updated_at.toISOString() : null,
    deleted_at: s.deleted_at ? s.deleted_at.toISOString() : null,
  };
}
