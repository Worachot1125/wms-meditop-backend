export interface StockBalanceQuery {
  date?: string;
  source?: "odoo" | "wms";
  product_code?: string;
  product_id?: number;
  location_id?: number;
  lot_id?: number;
  page?: string;
  limit?: string;
  search?: string;
  columns?: string | string[];
}

export interface StockBalanceResponse {
  id: number;
  snapshot_date: string;
  product_id: number;
  product_name: string | null;
  product_code: string;
  location_id: number | null;
  location_path: string | null;
  location_name: string | null;
  lot_id: number | null;
  lot_name: string | null;
  quantity: number;
  expiration_date: string | null;
  active: boolean | null;
  source: string;
  created_at: string;
  updated_at: string | null;
}
