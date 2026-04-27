export interface CreateDocInvoiceBody {
  id: string;
  doc_barcode: string | null;
  doc_invoice: string;
  out_type: string;

  // ใส่มาตอนสร้างได้เลย (optional)
  invoice_ids?: string[];
}

export interface UpdateDocInvoiceBody {
  id?: string;
  doc_barcode?: string | null;
  doc_invoice?: string;
  out_type?: string;

  // ส่งมาเพื่อ replace ทั้งชุด
  invoice_ids?: string[];

  updated_at?: string;
}
