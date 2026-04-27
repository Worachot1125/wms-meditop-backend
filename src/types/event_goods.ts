// Types for EventGoods API (Odoo sync)

export interface OdooGoodsEventItem {
  event: string;
  product_id: number;
  code: string;
  name: string;
  type: string;
  tracking: string;
  department_id?: number;
  department?: string;
  zone_id?: number;
  zone?: string;
  zones?: Array<{ zone_id: number; zone: string }>; // Odoo ส่งมาเป็น array
  unit: string;
  active: boolean;
}

export interface EventGoodsRequestBody {
  goods: OdooGoodsEventItem[];
}

export interface SyncResult {
  created: number;
  updated: number;
  disabled: number;
  total_processed: number;
  errors?: string[];
}
