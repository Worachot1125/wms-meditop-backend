export interface CreateInboundBody {
  no: string;
  lot: string;
  date: string; // รับเป็น string แล้ว parse เป็น Date
  quantity: number;
  in_type: string;
  department: string;
  invoice?: string;


  remark?: string | null; // ถ้าคุณมีคอลัมน์ remark ในตารางจริง (ถ้าไม่มีให้ลบทิ้ง)
}

export interface UpdateInboundBody {
  no?: string;
  lot?: string;
  date?: string;
  quantity?: number;
  in_type?: string;
  department?: string;

  supplier?: string | null;
  po_no?: string | null;
  inv_sup?: string | null;
  invoice?: string;

  remark?: string | null;
  updated_at?: string; // optional (ส่วนใหญ่ controller set ให้เอง)
}

// ===== Odoo Transfer Types =====

export interface OdooTransferItem {
  sequence: number;
  product_id: number;
  code: string;          // SKU
  name: string;          // ชื่อสินค้า
  unit: string;          // หน่วย
  tracking: string;      // tracking type
  lot_id: number;
  lot_serial: string;    // lot/serial number
  qty: number;           // จำนวน
  expiration_date?: string | null; // วันหมดอายุ (optional)
}

export interface OdooTransfer {
  picking_id: number;
  number: string;                // GR number
  location_id: number;
  location: string;              // ชื่อ location ต้นทาง
  location_dest_id: number;
  location_dest: string;         // ชื่อ location ปลายทาง
  department_id: number;
  department: string;            // ชื่อแผนก
  reference: string;             // เลขอ้างอิง
  origin: string;                // ต้นทาง
  invoice?: string
  items: OdooTransferItem[];
}

export interface OdooInboundRequest {
  transfers: OdooTransfer[];
}

// สำหรับรับข้อมูลจาก Odoo ที่มี params wrapper
export interface OdooInboundRequestParams {
  params: {
    transfers: OdooTransfer[];
  };
}
