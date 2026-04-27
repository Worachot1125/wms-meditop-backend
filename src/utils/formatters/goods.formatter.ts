import type { goods, department, zone_type } from "@prisma/client";

export interface GoodsFormatter {
  id: string;
  sku: string;
  name: string;
  lot: string;
  exp_date_start: string;
  exp_date_end: string;
  unit: string;
  remark?: string | null;
  department: {
    id: number;
    department_code: string | null;
    full_name: string;
    short_name: string;
    remark: string;
  };
  zone_type: {
    id: number;
    zone_type_code?: string | null;
    full_name: string;
    short_name: string;
    remark: string;
  };
  created_at: string;
  updated_at: string | null;
  deleted_at: string | null;
}

export function formatGoods(
  s: goods & { department: department; zone_type: zone_type }
): GoodsFormatter {
  return {
    id: s.id,
    sku: s.sku,
    name: s.name,
    lot: s.lot,
    exp_date_start: s.exp_date_start.toISOString(),
    exp_date_end: s.exp_date_end.toISOString(),
    unit: s.unit,
    remark: s.remark ?? null,

    department: {
      id: s.department.id,
      department_code: s.department.department_code,
      full_name: s.department.full_name,
      short_name: s.department.short_name,
      remark: s.department.remark ?? "",
    },
    zone_type: {
      id: s.zone_type.id,
      zone_type_code: s.zone_type.zone_type_code,
      full_name: s.zone_type.full_name,
      short_name: s.zone_type.short_name,
      remark: s.zone_type.remark ?? "",
    },

    created_at: s.created_at.toISOString(),
    updated_at: s.updated_at ? s.updated_at.toISOString() : null,
    deleted_at: s.deleted_at ? s.deleted_at.toISOString() : null,
  };
}
