import type { doc_invoice, invoice } from "@prisma/client";

export interface DocInvoiceFormatter {
  id: string;
  doc_barcode: string | null;
  doc_invoice: string;
  out_type: string;

  invoices: {
    id: string;
    no: string;
    created_at: string;
    updated_at: string | null;
    deleted_at: string | null;
  }[];

  created_at: string;
  updated_at: string | null;
  deleted_at: string | null;
}

export function formatDocInvoice(
  s: doc_invoice & { invoices?: invoice[] | null; deleted_at?: Date | null },
): DocInvoiceFormatter {
  return {
    id: s.id,
    doc_barcode: s.doc_barcode,
    doc_invoice: s.doc_invoice,
    out_type: s.out_type,

    invoices: (s.invoices ?? []).map((inv) => ({
      id: inv.id,
      no: inv.no,
      created_at: inv.created_at.toISOString(),
      updated_at: inv.updated_at ? inv.updated_at.toISOString() : null,
      deleted_at: inv.deleted_at ? inv.deleted_at.toISOString() : null,
    })),

    created_at: s.created_at.toISOString(),
    updated_at: s.updated_at ? s.updated_at.toISOString() : null,
    deleted_at: s.deleted_at ? s.deleted_at.toISOString() : null,
  };
}