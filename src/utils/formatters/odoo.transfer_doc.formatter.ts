import type { transfer_doc, transfer_doc_item, barcode } from "@prisma/client";

export interface BarcodeFormatter {
  barcode: string;
  lot_start: number | null;
  lot_stop: number | null;
  exp_start: number | null;
  exp_stop: number | null;
  barcode_length: number | null;
}

export interface TransferPickLocationFormatter {
  location_id: number;
  location_name: string;
  confirmed_qty: number;
}

export interface TransferPutLocationFormatter {
  location_id: number;
  location_name: string;
  confirmed_put: number;
}

export interface OdooTransferDocItemFormatter {
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
  barcode: BarcodeFormatter | null;

  pick_locations?: TransferPickLocationFormatter[];
  put_locations?: TransferPutLocationFormatter[];
}

export interface OdooTransferDocFormatter {
  id: number;
  picking_id: number | null;
  no: string | null;
  lot: string | null;
  location_id: number | null;
  location: string | null;
  location_dest_id: number | null;
  location_dest: string | null;
  department_id: string | null;
  department: string | null;
  reference: string | null;
  quantity: number | null;
  origin: string | null;
  date: string;
  in_type: string;
  created_at: string;
  updated_at: string | null;
  items: OdooTransferDocItemFormatter[];
}

export function formatOdooTransferDoc(
  doc: transfer_doc & {
    transfer_doc_items?: (transfer_doc_item & {
      deleted_at?: Date | null;
      barcode?: barcode | null;
    })[];
    deleted_at?: Date | null;
  },
): OdooTransferDocFormatter {
  return {
    id: doc.id,
    picking_id: doc.picking_id ?? null,
    no: doc.no ?? null,
    lot: doc.lot ?? null,
    location_id: doc.location_id ?? null,
    location: doc.location ?? null,
    location_dest_id: doc.location_dest_id ?? null,
    location_dest: doc.location_dest ?? null,
    department_id: doc.department_id ?? null,
    department: doc.department ?? null,
    quantity: doc.quantity ?? null,
    reference: doc.reference ?? null,
    origin: doc.origin ?? null,
    date: doc.date.toISOString(),
    in_type: doc.in_type,
    created_at: doc.created_at.toISOString(),
    updated_at: doc.updated_at ? doc.updated_at.toISOString() : null,

    items: doc.transfer_doc_items
      ? doc.transfer_doc_items
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