import type { adjustment, adjustment_item } from "@prisma/client";

export interface OdooAdjustmentItemFormatter {
  id: number;
  sequence: number | null;
  product_id: number | null;
  code: string | null;
  name: string;
  unit: string;
  location_id: number | null;
  location: string | null;
  location_dest_id: number | null;
  location_dest: string | null;
  tracking: string | null;
  lot_id: number | null;
  lot_serial: string | null;
  qty: number | null;
  exp: string | null;
  barcode_payload: string | null;
  qty_pick: number;
  created_at: string;
  updated_at: string | null;
}

export interface OdooAdjustmentFormatter {
  id: number;
  no: string | null;
  inventory_id: number | null;
  picking_id: number | null;
  picking_no: string | null;
  department_id: string | null;
  department: string;
  reference: string | null;
  origin: string | null;
  description: string | null; // ✅ เพิ่ม
  level: string | null;
  type: string | null;
  status: string;
  is_system_generated: boolean;
  date: string;
  created_at: string;
  updated_at: string | null;
  items: OdooAdjustmentItemFormatter[];
}

export function formatOdooAdjustment(
  doc: adjustment & {
    items?: (adjustment_item & {
      deleted_at?: Date | null;
    })[];
    deleted_at?: Date | null;
  },
): OdooAdjustmentFormatter {
  return {
    id: doc.id,
    no: doc.no ?? null,
    inventory_id: doc.inventory_id ?? null,
    picking_id: doc.picking_id ?? null,
    picking_no: doc.picking_no ?? null,
    department_id: doc.department_id ?? null,
    department: doc.department,
    reference: doc.reference ?? null,
    origin: doc.origin ?? null,
    description: doc.description ?? null, // ✅ เพิ่ม
    level: doc.level ?? null,
    type: doc.type ?? null,
    status: doc.status,
    is_system_generated: doc.is_system_generated,
    date: doc.date.toISOString(),
    created_at: doc.created_at.toISOString(),
    updated_at: doc.updated_at ? doc.updated_at.toISOString() : null,

    items: doc.items
      ? doc.items
          .filter((item) => !item.deleted_at)
          .sort((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0))
          .map((item) => ({
            id: item.id,
            sequence: item.sequence ?? null,
            product_id: item.product_id ?? null,
            code: item.code ?? null,
            name: item.name,
            unit: item.unit,
            location_id: item.location_id ?? null,
            location: item.location ?? null,
            location_dest_id: item.location_dest_id ?? null,
            location_dest: item.location_dest ?? null,
            tracking: item.tracking ?? null,
            lot_id: item.lot_id ?? null,
            lot_serial: item.lot_serial ?? null,
            qty: item.qty ?? null,
            exp: item.exp ? item.exp.toISOString() : null,
            barcode_payload: item.barcode_payload ?? null,
            qty_pick: item.qty_pick ?? 0,
            created_at: item.created_at.toISOString(),
            updated_at: item.updated_at ? item.updated_at.toISOString() : null,
          }))
      : [],
  };
}