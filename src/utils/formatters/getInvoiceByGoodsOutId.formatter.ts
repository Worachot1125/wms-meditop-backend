import type {
  invoice_item,
  invoice,
  doc_invoice,
  goods_out,
  lot,
} from "@prisma/client";

export interface InvoiceByGoodsOutFormatter {
  invoice_item_id: number;

  invoice_id: string;
  invoice_no: string;
  invoice_barcode: string | null;

  doc_invoice: {
    id: string;
    doc_invoice: string;
    out_type: string;
  } | null;

  goods_out: {
    id: string;
    sku: string;
    barcode: string;
    name: string;
    lock_no: string;
    lock_name: string;
    lot_no: string;
    lot_name: string | null;
  } | null;

  quantity: number;
  pick: number;
  pack: number;

  created_at: string;
  updated_at: string | null;
  deleted_at: string | null;
}

export function formatInvoiceByGoodsOut(
  r: invoice_item & {
    invoice: invoice & { doc_invoice?: doc_invoice | null; deleted_at?: Date | null };
    goods_out?: (goods_out & { lot?: lot | null; deleted_at?: Date | null }) | null;
  },
): InvoiceByGoodsOutFormatter {
  return {
    invoice_item_id: r.id,

    invoice_id: r.invoice_id,
    invoice_no: r.invoice.no,
    invoice_barcode: r.invoice.invoice_barcode ?? null,

    doc_invoice: r.invoice.doc_invoice
      ? {
          id: r.invoice.doc_invoice.id,
          doc_invoice: r.invoice.doc_invoice.doc_invoice,
          out_type: r.invoice.doc_invoice.out_type,
        }
      : null,

    goods_out: r.goods_out
      ? {
          id: r.goods_out.id,
          sku: r.goods_out.sku,
          barcode: r.goods_out.barcode,
          name: r.goods_out.name,
          lock_no: r.goods_out.lock_no,
          lock_name: r.goods_out.lock_name,
          lot_no: r.goods_out.lot_no,
          lot_name: r.goods_out.lot?.name ?? null,
        }
      : null,

    quantity: r.quantity ?? 0,
    pick: r.pick ?? 0,
    pack: r.pack ?? 0,

    created_at: r.invoice.created_at.toISOString(),
    updated_at: r.invoice.updated_at ? r.invoice.updated_at.toISOString() : null,
    deleted_at: r.invoice.deleted_at ? r.invoice.deleted_at.toISOString() : null,
  };
}
