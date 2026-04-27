export interface OdooAdjustDepartment {
  department_id?: number | string;
  department?: string;
}

export interface OdooAdjustItem {
  sequence?: number;
  product_id?: number;
  code?: string;
  name: string;
  unit: string;
  location_id?: number;
  location?: string;
  location_dest_id?: number;
  location_dest?: string;
  tracking?: string;
  lot_id?: number;
  lot_serial?: string;
  qty?: number;
  qty_pick: number;
  expire_date?: string | null;
}

export interface OdooAdjust {
  inventory_id?: number;
  no?: string;
  picking_id?: number;
  picking_no?: string;
  reference?: string | boolean | any;
  origin?: string | any;
  description?: string; // ✅ เพิ่ม

  departments?: OdooAdjustDepartment[];

  // fallback รองรับของเก่าที่บางทีส่งมาเป็น singular
  department_id?: number | string;
  department?: string;

  items: OdooAdjustItem[];
}

export interface OdooAdjustRequestParams {
  params: { adjusts: OdooAdjust[] };
}

export interface OdooAdjustRequest {
  adjusts: OdooAdjust[];
}