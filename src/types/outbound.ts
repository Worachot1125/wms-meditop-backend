// ===== Odoo Transfer Types =====

export interface OdooOutboundItem {
  sequence: number;
  product_id: number;
  code: string;          // SKU
  name: string;          // ชื่อสินค้า
  unit: string;          // หน่วย
  tracking: string;      // tracking type
  lot_id: number;
  lot_serial: string;    // lot/serial number
  qty: number;           // จำนวน
  expiration_date?: string | null; // วันหมดอายุ
}

export interface OdooOutboundTransfer {
  picking_id: number;
  no: string;                    // Transfer number
  location_id: number;
  location: string;              // ชื่อ location ต้นทาง
  location_dest_id: number;
  location_dest: string;         // ชื่อ location ปลายทาง
  department_id: number;
  department: string;            // ชื่อแผนก
  reference: string | null;      // เลขอ้างอิง
  origin: string;                // ต้นทาง
  invoice: string | null;
  in_process: Boolean;
  items: OdooOutboundItem[];
}

export interface OdooOutboundRequest {
  transfers: OdooOutboundTransfer[];
}

// สำหรับรับข้อมูลจาก Odoo ที่มี params wrapper
export interface OdooOutboundRequestParams {
  params: {
    transfers: OdooOutboundTransfer[];
  };
}
