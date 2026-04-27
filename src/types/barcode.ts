export interface CreateBarcodeBody {
  barcode_id?: number;          // Barcode ID from Odoo (optional for internal)
  barcode: string;
  product_id?: number;          // Product ID from Odoo
  wms_goods_id?: number;        // FK to wms_mdt_goods
  product_code?: string;
  product_name?: string;
  tracking?: string;
  ratio?: number;
  lot_start?: number;
  lot_stop?: number;
  exp_start?: number;
  exp_stop?: number;
  barcode_length?: number;
  internal_use?: boolean;
  active?: boolean;
}

export interface UpdateBarcodeBody {
  barcode_id?: number;
  barcode?: string;
  product_id?: number;
  wms_goods_id?: number;
  product_code?: string;
  product_name?: string;
  tracking?: string;
  ratio?: number;
  lot_start?: number;
  lot_stop?: number;
  exp_start?: number;
  exp_stop?: number;
  barcode_length?: number;
  internal_use?: boolean;
  active?: boolean;
}