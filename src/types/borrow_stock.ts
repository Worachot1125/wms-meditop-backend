/** ===== Create / Update Borrow Stock ===== */
export interface CreateBorrowStockBody {
  location_name: string;
  department_id?: number | null;
  user_ref?: string | null;
  remark?: string | null;

  // ถ้าจะสร้างพร้อม item ในครั้งเดียว
  items?: CreateBorrowStockItemBody[];
}

export interface UpdateBorrowStockBody {
  location_name?: string;
  department_id?: number | null;
  status?: string; // pending / completed / cancelled (แล้วแต่คุณกำหนด)
  user_ref?: string | null;
  remark?: string | null;

  updated_at?: string; // optional (controller set ให้เองก็ได้)
}

/** ===== Item ===== */
export interface CreateBorrowStockItemBody {
  code: string;
  name?: string | null;
  lot_serial: string;
  expiration_date?: string | null; // รับ string แล้ว parse เป็น Date
  system_qty: number;
  executed_qty?: number | null;
}

export interface UpdateBorrowStockItemBody {
  code?: string;
  name?: string | null;
  lot_serial?: string;
  expiration_date?: string | null;
  system_qty?: number;
  executed_qty?: number | null;

  updated_at?: string;
}