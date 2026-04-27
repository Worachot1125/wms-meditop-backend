import { prisma } from "../lib/prisma";

async function findWmsGoodsForItem(product_id: number, lot_id: number | null) {
  return prisma.wms_mdt_goods.findFirst({
    where: {
      product_id,
      ...(lot_id ? { lot_id } : {}),
      active: true,
    },
    orderBy: { id: "desc" },
    select: {
      product_id: true,
      product_code: true,
      product_name: true,
      unit: true,
      lot_id: true,
      lot_name: true,
      expiration_date: true,
    },
  });
}

export { findWmsGoodsForItem };