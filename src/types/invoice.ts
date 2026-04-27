export interface CreateInvoiceItemInput {
  goods_out_id: string;
  quantity: number;
  pick: number;
  pack: number;
}

export interface UpdateInvoiceItemInput {
  goods_out_id: string;
  quantity?: number;
  pick?: number;
  pack?: number;
}

export interface CreateInvoiceBody {
  id: string;
  no: string;
  doc_invoice_id?: string;
  invoice_barcode?: string | null;

  // ✅ เปลี่ยนเป็นรายการต่อบรรทัด
  items?: CreateInvoiceItemInput[];
}

export interface UpdateInvoiceBody {
  no?: string;
  doc_invoice_id?: string | null;
  invoice_barcode?: string | null;

  // ✅ ถ้าส่งมา = replace ทั้งรายการ (ลบของเดิมแล้วสร้างใหม่)
  items?: UpdateInvoiceItemInput[];

  updated_at?: string;
}
