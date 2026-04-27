import type { goods_in, inbound } from "@prisma/client";
import { toExp6 } from "../../utils/barcode";

export interface GoodsInFormatter {
  id: string;

  department_code?: string | null;

  // ✅ NEW: ใส่ department ใน item ด้วย
  department: string | null;

  inbound: {
    id: number;
    no: string | null;
    lot: string | null;
    date: string;
    quantity: number | null;
    in_type: string;
    department: string;
  } | null;

  name: string;
  quantity_receive: number;
  quantity_count: number;
  unit: string;
  zone_type: string | null;
  lot: string | null;
  exp: string | null;
  no_expiry: boolean;

  barcode13: string | null;
  qr_payload: string | null;

  barcode_id?: number | null;

  created_at: string;
  updated_at: string | null;
  deleted_at: string | null;
}

export function formatGoodsIn(
  s: goods_in & { inbound?: inbound | null; deleted_at?: Date | null; barcode_id?: number | null }
): GoodsInFormatter {
  const exp6 = toExp6(s.exp ?? null);
  const no_expiry = exp6 === "999999";

  return {
    id: s.id,
    department: s.inbound?.department ?? null,
    department_code: s.inbound?.department_id ?? null,

    inbound: s.inbound
      ? {
          id: s.inbound.id,
          no: s.inbound.no ?? null,
          lot: s.inbound.lot ?? null,
          date: s.inbound.date.toISOString(),
          quantity: s.inbound.quantity ?? null,
          in_type: s.inbound.in_type,
          department: s.inbound.department,
        }
      : null,

    name: s.name,
    quantity_receive: s.quantity_receive ?? 0,
    quantity_count: s.quantity_count ?? 0,
    unit: s.unit,
    zone_type: s.zone_type ?? null,
    lot: s.lot ?? null,
    exp: s.exp ? s.exp.toISOString() : null,
    no_expiry,

    barcode13: s.barcode13 ?? null,
    qr_payload: s.qr_payload ?? null,
    barcode_id: s.barcode_id ?? null,

    created_at: s.created_at.toISOString(),
    updated_at: s.updated_at ? s.updated_at.toISOString() : null,
    deleted_at: s.deleted_at ? s.deleted_at.toISOString() : null,
  };
}
