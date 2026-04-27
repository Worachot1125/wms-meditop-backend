export interface CreateStockBody {
  bucket_key: string;

  product_id: number;
  product_code?: string;
  product_name?: string;
  unit?: string;

  location_id?: number;
  location_name?: string;

  lot_id?: number;
  lot_name?: string;
  expiration_date?: string; // ISO date string

  overwrite_remark?: string;
  product_last_modified_date?: string;

  source: string; // 'wms' | 'odoo'
  quantity: number;
  count?: number;
}


export interface UpdateStockBody {
  product_code?: string;
  product_name?: string;
  unit?: string;

  location_id?: number;
  location_name?: string;

  lot_id?: number;
  lot_name?: string;
  expiration_date?: string;

  overwrite_remark?: string;
  product_last_modified_date?: string;

  quantity?: number;
  count?: number;
  update_at?: string;
}
