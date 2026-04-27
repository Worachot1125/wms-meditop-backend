import type {
  doc_invoice,
  invoice,
  invoice_item,
  goods_out,
  lot,
} from "@prisma/client";

export interface DocInvoiceDetailFormatter {
  id: string;
  doc_barcode: string | null;
  doc_invoice: string;
  out_type: string;

  invoices: {
    id: string;
    no: string;
    invoice_barcode: string | null;

    items: {
      invoice_item_id: number;

      goods_out_id: string;
      barcode: string;
      sku: string;
      name: string;
      lock_no: string;
      lock_name: string;
      lot_no: string;
      lot_name: string | null;

      quantity: number;
      pack: number;   // ✅ pack จาก invoice_item
      pick: number;   // (ถ้าต้องโชว์ด้วย)
      box_id: string | null; // ✅ box_id จาก goods_out
    }[];

    total_quantity: number;
    total_pack: number;
    total_pick: number;

    created_at: string;
    updated_at: string | null;
    deleted_at: string | null;
  }[];

  created_at: string;
  updated_at: string | null;
  deleted_at: string | null;
}

export function formatDocInvoiceDetail(
  s: doc_invoice & {
    invoices?: (invoice & {
      items?: (invoice_item & {
        goods_out?: (goods_out & { lot?: lot | null }) | null;
      })[];
    })[];
    deleted_at?: Date | null;
  },
): DocInvoiceDetailFormatter {
  const invoices = (s.invoices ?? []).map((inv) => {
    const items = (inv.items ?? [])
      .filter((it) => !!it.goods_out)
      .map((it) => {
        const g = it.goods_out!;
        return {
          invoice_item_id: it.id,

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
          box_id: g.box_id ?? null,
        };
      });

    const total_quantity = items.reduce((sum, x) => sum + (x.quantity ?? 0), 0);
    const total_pack = items.reduce((sum, x) => sum + (x.pack ?? 0), 0);
    const total_pick = items.reduce((sum, x) => sum + (x.pick ?? 0), 0);

    return {
      id: inv.id,
      no: inv.no,
      invoice_barcode: inv.invoice_barcode ?? null,

      items,
      total_quantity,
      total_pack,
      total_pick,

      created_at: inv.created_at.toISOString(),
      updated_at: inv.updated_at ? inv.updated_at.toISOString() : null,
      deleted_at: inv.deleted_at ? inv.deleted_at.toISOString() : null,
    };
  });

  return {
    id: s.id,
    doc_barcode: s.doc_barcode ?? null,
    doc_invoice: s.doc_invoice,
    out_type: s.out_type,

    invoices,

    created_at: s.created_at.toISOString(),
    updated_at: s.updated_at ? s.updated_at.toISOString() : null,
    deleted_at: s.deleted_at ? s.deleted_at.toISOString() : null,
  };
}
