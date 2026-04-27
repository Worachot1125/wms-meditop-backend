import type { invoice, doc_invoice, goods_out, invoice_item, lot } from "@prisma/client";

export interface InvoiceFormatter {
  id: string;
  no: string;

  doc_invoice_id: string | null;
  invoice_barcode: string | null;
  doc_invoice: {
    id: string;
    doc_invoice: string;
    out_type: string;
  } | null;

  // ✅ รายการสินค้าในใบ + จำนวนแยกต่อบรรทัด
  items: {
    goods_out_id: string;
    sku: string;
    barcode: string;
    name: string;
    lock_no: string;
    lock_name: string;
    lot_no: string;
    lot_name: string | null;

    quantity: number;
    pick: number;
    pack: number;
  }[];

  // (optional) ยอดรวมคำนวณจาก items
  total_quantity: number;
  total_pick: number;
  total_pack: number;

  created_at: string;
  updated_at: string | null;
  deleted_at: string | null;
}

export function formatInvoice(
  s: invoice & {
    doc_invoice?: doc_invoice | null;
    items?: (invoice_item & { goods_out?: (goods_out & { lot?: lot | null }) | null })[] | null;
    deleted_at?: Date | null;
  },
): InvoiceFormatter {
  const items = (s.items ?? [])
    .filter((it) => !!it.goods_out)
    .map((it) => {
      const g = it.goods_out!;
      return {
        goods_out_id: g.id,
        sku: g.sku,
        barcode: g.barcode,
        name: g.name,
        lock_no: g.lock_no,
        lock_name: g.lock_name,
        lot_no: g.lot_no,
        lot_name: g.lot?.name ?? null,

        quantity: it.quantity ?? 0,
        pick: it.pick ?? 0,
        pack: it.pack ?? 0,
      };
    });

  const total_quantity = items.reduce((sum, x) => sum + (x.quantity ?? 0), 0);
  const total_pick = items.reduce((sum, x) => sum + (x.pick ?? 0), 0);
  const total_pack = items.reduce((sum, x) => sum + (x.pack ?? 0), 0);

  return {
    id: s.id,
    no: s.no,

    doc_invoice_id: s.doc_invoice_id || null,
    invoice_barcode: s.invoice_barcode || null,
    doc_invoice: s.doc_invoice
      ? {
          id: s.doc_invoice.id,
          doc_invoice: s.doc_invoice.doc_invoice,
          out_type: s.doc_invoice.out_type,
        }
      : null,

    items,
    total_quantity,
    total_pick,
    total_pack,

    created_at: s.created_at.toISOString(),
    updated_at: s.updated_at ? s.updated_at.toISOString() : null,
    deleted_at: s.deleted_at ? s.deleted_at.toISOString() : null,
  };
}
