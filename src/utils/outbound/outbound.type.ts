import type { Prisma } from "@prisma/client";

export type Tx = Prisma.TransactionClient;

export type LockTarget = "BOR" | "BOS" | "SER";
export type BorSerStockTable = "BOR" | "SER";

export type DeductMergedItem = {
  product_id: number | null;
  lot_id: number | null;
  lot_serial: string | null;
  qty: number;
  exp: Date | null;
};

export type ReplaceMergedItem = {
  product_id: number | null;
  lot_id: number | null;
  lot_serial: string | null;
  qty: number;
  code?: string | null;
  name?: string | null;
  unit?: string | null;
  exp: Date | null;
};

export type BorSerInternalLine = {
  sequence: number | null;
  product_id: number | null;
  code: string | null;
  name: string | null;
  unit: string | null;
  tracking: string | null;
  lot_id: number | null;
  lot_serial: string | null;
  qty: number;
  barcode_text: string | null;
  exp: Date | null;
};

export type TFLine = {
  sequence: number | null;
  product_id: number | null;
  code: string | null;
  name: string | null;
  unit: string | null;
  tracking: string | null;
  lot_id: number | null;
  lot_serial: string | null;
  qty: number;
  barcode_text: string | null;
  expire_date?: string | null;
  exp?: Date | null;
};

export type MasterLocationLite = {
  id: number;
  full_name: string;
};

export type InputKey = string;
export type LockKey = string;

export type LockLocRow = {
  location_id: number | null;
  location_name: string;
  qty: number;
};

export type DeptMap = Map<number, string>;
export type DeptShortMap = Map<number, string>;