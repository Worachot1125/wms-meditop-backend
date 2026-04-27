export interface CreateGoodsInBody {
  // ✅ เปลี่ยนจาก required -> optional (หรือจะลบทิ้งเลยก็ได้)
  id?: string;

  inbound_id: number;

  name: string;
  quantity_receive: number;
  quantity_count: number;
  unit: string;
  zone_type?: string | null;

  lot?: string | null;
  exp?: string | null;
  no_expiry?: boolean;

  code?: string | null;
  lot_id?: number | null;
  lot_serial?: string | null;
  product_id?: number | null;
  qty?: number | null;
  sequence?: number | null;
  tracking?: string | null;
  barcode_id?: number | null;

  // ✅ NEW
  odoo_line_key?: string | null;
  odoo_sequence?: number | null;
}

export interface UpdateGoodsInBody {
  inbound_id?: number;

  name?: string;
  quantity_receive?: number;
  quantity_count?: number;
  unit?: string;
  zone_type?: string | null;

  lot?: string | null;
  exp?: string | null;
  no_expiry?: boolean;

  code?: string | null;
  lot_id?: number | null;
  lot_serial?: string | null;
  product_id?: number | null;
  qty?: number | null;
  sequence?: number | null;
  tracking?: string | null;
  barcode_id?: number | null;

  // ✅ NEW
  odoo_line_key?: string | null;
  odoo_sequence?: number | null;
  print_check?: boolean;

  updated_at?: string;
}