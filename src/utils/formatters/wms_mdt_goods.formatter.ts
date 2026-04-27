import type { wms_mdt_goods } from "@prisma/client";
import { WmsMdtGoodsResponse } from "../../types/wms_mdt_goods";

export function formatWmsMdtGoods(goods: wms_mdt_goods): WmsMdtGoodsResponse {
  const expirationDate = goods.expiration_date ? goods.expiration_date.toISOString() : null;
  return {
    id: goods.id,
    product_id: goods.product_id,
    product_code: goods.product_code,
    product_name: goods.product_name,
    lot_id: goods.lot_id,
    lot_name: goods.lot_name,
    expiration_date: expirationDate,
    expiration_date_end: expirationDate,
    department_code: goods.department_code,
    unit: goods.unit,
    zone_type: goods.zone_type,
    input_number: goods.input_number ?? false,
  };
}
