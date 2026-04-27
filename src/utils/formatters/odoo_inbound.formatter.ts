import type { inbound, goods_in, barcode } from "@prisma/client";

export interface BarcodeFormatter {
  barcode: string;
  lot_start: number | null;
  lot_stop: number | null;
  exp_start: number | null;
  exp_stop: number | null;
  barcode_length: number | null;
}

export interface OdooInboundItemFormatter {
  id: string;
  sequence: number | null;
  product_id: number | null;
  code: string | null;
  name: string;
  unit: string;
  tracking: string | null;
  lot_id: number | null;
  lot_serial: string | null;
  qty: number | null;
  barcode_id: string | null;

  // ✅ NEW
  print_check: boolean;

  barcode: BarcodeFormatter | null;
}

export interface OdooInboundFormatter {
  id: number;
  picking_id: number | null;
  no: string | null;
  lot: string | null;
  location_id: number | null;
  location: string | null;
  location_dest_id: number | null;
  location_dest: string | null;
  department_id: string | null;
  department: string;
  reference: string | null;
  quantity: number | null;
  origin: string | null;
  date: string;
  invoice: string | null;
  status: string;
  in_type: string;
  created_at: string;
  updated_at: string | null;
  items: OdooInboundItemFormatter[];
}

export function formatOdooInbound(
  inbound: inbound & {
    goods_ins?: (goods_in & {
      deleted_at?: Date | null;
      barcode?: barcode | null;
    })[];
    deleted_at?: Date | null;
  },
): OdooInboundFormatter {
  return {
    id: inbound.id,
    picking_id: inbound.picking_id ?? null,
    no: inbound.no ?? null,
    lot: inbound.lot ?? null,
    location_id: inbound.location_id ?? null,
    location: inbound.location ?? null,
    location_dest_id: inbound.location_dest_id ?? null,
    location_dest: inbound.location_dest ?? null,
    department_id: inbound.department_id ?? null,
    department: inbound.department,
    quantity: inbound.quantity ?? null,
    reference: inbound.reference ?? null,
    origin: inbound.origin ?? null,
    invoice: inbound.invoice ?? null,
    date: inbound.date.toISOString(),
    in_type: inbound.in_type,
    status: inbound.status,
    created_at: inbound.created_at.toISOString(),
    updated_at: inbound.updated_at ? inbound.updated_at.toISOString() : null,

    items: inbound.goods_ins
      ? inbound.goods_ins
          .filter((item) => !item.deleted_at)
          .map((item) => ({
            id: item.id,
            sequence: item.sequence ?? null,
            product_id: item.product_id ?? null,
            code: item.code ?? null,
            name: item.name,
            unit: item.unit,
            tracking: item.tracking ?? null,
            lot_id: item.lot_id ?? null,
            lot_serial: item.lot_serial ?? null,
            qty: item.qty ?? null,
            barcode_id: item.barcode_id ? String(item.barcode_id) : null,

            // ✅ NEW
            print_check: Boolean(item.print_check),

            barcode:
              item.barcode && !item.barcode.deleted_at
                ? {
                    barcode: item.barcode.barcode,
                    lot_start: item.barcode.lot_start ?? null,
                    lot_stop: item.barcode.lot_stop ?? null,
                    exp_start: item.barcode.exp_start ?? null,
                    exp_stop: item.barcode.exp_stop ?? null,
                    barcode_length: item.barcode.barcode_length ?? null,
                  }
                : null,
          }))
      : [],
  };
}