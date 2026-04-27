import type { stock_balance } from "@prisma/client";
import { StockBalanceResponse } from "../../types/stock_balance";

export function formatStockBalance(
  sb: stock_balance,
  product_name?: string | null
): StockBalanceResponse {
  return {
    id: sb.id,
    snapshot_date: sb.snapshot_date.toISOString().split("T")[0],
    product_id: sb.product_id,
    product_name: product_name || null,
    product_code: sb.product_code,
    location_id: sb.location_id,
    location_path: sb.location_path,
    location_name: sb.location_name,
    lot_id: sb.lot_id,
    lot_name: sb.lot_name,
    quantity: sb.quantity.toNumber(),
    expiration_date: sb.expiration_date ? sb.expiration_date.toISOString() : null,
    active: sb.active !== null ? sb.active : true,
    source: sb.source,
    created_at: sb.created_at.toISOString(),
    updated_at: sb.updated_at ? sb.updated_at.toISOString() : null,
  };
}
