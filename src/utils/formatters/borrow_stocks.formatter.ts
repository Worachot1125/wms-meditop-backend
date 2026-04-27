import type { borrow_stock, borrow_stock_item, department, borrow_stock_department } from "@prisma/client";

/** ===== Item Formatter ===== */
export interface BorrowStockItemFormatter {
  id: number;
  code: string;
  name: string | null;
  lot_serial: string;
  expiration_date: string | null;
  system_qty: number;
  executed_qty: number | null;

  created_at: string;
  updated_at: string | null;
}

/** ===== Department (optional) =====
 * หมายเหตุ: โครง department จริงของคุณอาจมี field มากกว่านี้
 * ถ้าต้องการให้ strict ให้ปรับ select/include ให้ตรง schema จริง
 */
export interface DepartmentFormatter {
  id: number;
  full_name?: string | null;
  short_name?: string | null;
  department_code?: string | null;
}

/** ===== Borrow Stock Formatter ===== */
export interface BorrowStockFormatter {
  id: number;
  location_name: string;

  departments: DepartmentFormatter[];

  status: string;
  user_ref: string | null;
  remark: string | null;

  created_at: string;
  updated_at: string | null;

  items: BorrowStockItemFormatter[];
}

export function formatBorrowStock(
  doc: borrow_stock & {
    borrowStockDepartments?: (borrow_stock_department & {
      department?: department | null;
    })[];
    borrowStockItems?: (borrow_stock_item & { deleted_at?: Date | null })[];
    deleted_at?: Date | null;
  },
): BorrowStockFormatter {
  return {
    id: doc.id,
    location_name: doc.location_name,

    departments: doc.borrowStockDepartments
      ? doc.borrowStockDepartments
          .map((rel) => rel.department)
          .filter((d): d is department => Boolean(d))
          .map((d) => ({
            id: d.id,
            full_name: (d as any).full_name ?? null,
            short_name: (d as any).short_name ?? null,
            department_code: (d as any).department_code ?? null,
          }))
      : [],

    status: doc.status,
    user_ref: doc.user_ref ?? null,
    remark: doc.remark ?? null,

    created_at: doc.created_at.toISOString(),
    updated_at: doc.updated_at ? doc.updated_at.toISOString() : null,

    items: doc.borrowStockItems
      ? doc.borrowStockItems
          .filter((it) => !it.deleted_at)
          .map((it) => ({
            id: it.id,
            code: it.code,
            name: it.name ?? null,
            lot_serial: it.lot_serial,
            expiration_date: it.expiration_date
              ? it.expiration_date.toISOString()
              : null,
            system_qty: it.system_qty,
            executed_qty: it.executed_qty ?? null,
            created_at: it.created_at.toISOString(),
            updated_at: it.updated_at ? it.updated_at.toISOString() : null,
          }))
      : [],
  };
}