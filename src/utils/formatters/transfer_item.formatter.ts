import type { transfer_doc_item, transfer_doc } from "@prisma/client";
import { toExp6 } from "../../utils/barcode";

export interface TransferDocItemFormatter {
  id: string;

  department_code?: string | null;

  // ✅ ใส่ department ใน item ด้วย
  department: string | null;

  transfer_doc: {
    id: number;
    no: string | null;
    lot: string | null;
    date: string;
    quantity: number | null;
    in_type: string;
    department: string | null;
  } | null;

  name: string;
  quantity_receive: number;
  quantity_count: number;
  quantity_put: number;
  unit: string;
  zone_type: string | null;
  lot: string | null;
  exp: string | null;
  no_expiry: boolean;

  barcode13: string | null;
  qr_payload: string | null;

  barcode_id?: number | null;
  user_ref?: string | null;

  created_at: string;
  updated_at: string | null;
  deleted_at: string | null;
}

export function formatTransferDocItem(
  s: transfer_doc_item & {
    transfer_doc?: transfer_doc | null;
    deleted_at?: Date | null;
    barcode_id?: number | null;
  },
): TransferDocItemFormatter {
  const exp6 = toExp6((s as any).exp ?? null);
  const no_expiry = exp6 === "999999";

  return {
    id: s.id,
    department: s.transfer_doc?.department ?? null,
    department_code: (s.transfer_doc as any)?.department_id ?? null,

    transfer_doc: s.transfer_doc
      ? {
          id: s.transfer_doc.id,
          no: s.transfer_doc.no ?? null,
          lot: s.transfer_doc.lot ?? null,
          date: s.transfer_doc.date.toISOString(),
          quantity: s.transfer_doc.quantity ?? null,
          in_type: s.transfer_doc.in_type,
          department: s.transfer_doc.department ?? null,
        }
      : null,

    name: s.name,
    user_ref: s.user_ref,
    quantity_receive: s.quantity_receive ?? 0,
    quantity_count: s.quantity_count ?? 0,
    quantity_put: s.quantity_put ?? 0,
    unit: s.unit,
    zone_type: (s as any).zone_type ?? null,
    lot: (s as any).lot ?? null,
    exp: (s as any).exp ? (s as any).exp.toISOString() : null,
    no_expiry,

    barcode13: (s as any).barcode13 ?? null,
    qr_payload: (s as any).qr_payload ?? null,
    barcode_id: (s as any).barcode_id ?? null,

    created_at: (s as any).created_at.toISOString(),
    updated_at: (s as any).updated_at ? (s as any).updated_at.toISOString() : null,
    deleted_at: (s as any).deleted_at ? (s as any).deleted_at.toISOString() : null,
  };
}