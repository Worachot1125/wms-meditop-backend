// Types for EventBarcodes API (Odoo sync)

export interface OdooBarcodeEventItem {
  event: string;              // "create", "update", "delete"
  barcode_id: number;         // Barcode ID from Odoo
  barcode: string;            // Barcode value
  product_id: number;         // Product ID from Odoo
  product_code: string;       // Product code (SKU)
  product_name: string;       // Product name
  ratio: number;              // Ratio
  lot_start: number;          // Lot start position
  lot_stop: number;           // Lot stop position
  exp_start: number;          // Expiry start position
  exp_stop: number;           // Expiry stop position
}

export interface EventBarcodesRequestBody {
  barcodes: OdooBarcodeEventItem[];
}

export interface BarcodeSyncResult {
  created: number;
  updated: number;
  deleted: number;
  total_processed: number;
  errors?: string[];
}
