export type CreateTransferMovementItemBody = {
  product_id?: number | null;
  code?: string | null; // ✅ code == barcode.product_name (ตาม rule ใหม่)
  name: string;
  lot_serial?: string | null;
  lock_no?: string | null;
  lock_no_dest?: string | null;
  unit: string;
  expire_date?: string | null; // "YYYY-MM-DD" | ISO | null
  status: string;
  qty: number;
};

export interface CreateTransferMovementBody {
  number: string;

  // ✅ NEW: multi
  department_ids?: number[];

  // ✅ OLD (compat)
  department_id?: number;

  // ✅ NEW: multi
  user_work_ids?: number[] | null;

  // ✅ OLD (compat)
  user_work_id?: number | null;

  user_id?: number; // compat
  items: CreateTransferMovementItemBody[];
}

export interface UpdateTransferMovementBody {
  number?: string;

  // ✅ NEW: multi
  department_ids?: number[];

  // ✅ OLD
  department_id?: number;

  // ✅ NEW: multi
  user_work_ids?: number[] | null;

  // ✅ OLD
  user_work_id?: number | null;

  user_id?: number;
  status?: string;
  items?: CreateTransferMovementItemBody[];
}

export interface ScanMovementLocationBody {
  location_full_name: string;
}

export interface ScanMovementBarcodeBody  {
  barcode: string;
  location_full_name: string;
  mode?: "inc" | "set" | "dec" | "clear"; // default inc
  value?: number; // ใช้ตอน set/dec
}

export interface ConfirmMovementPickBody {
  location_full_name: string;
}

export interface ConfirmMovementPutBody {
  pin: string;
  location_full_name: string;
  lines: Array<{
    transfer_movement_item_id: string;
    put_qty?: number;
  }>;
}