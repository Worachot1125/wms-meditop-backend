import { prisma } from "../../lib/prisma";
import { Prisma } from "@prisma/client";
import {
  GoodsKey,
  goodsKeyByLotId,
  goodsKeyByLotText,
} from "./inbound.key.helper";
import { NormalizedInboundItem, toExpDate } from "./inbound.normalize.helper";
import { resolveLotText } from "../../controllers/inbound.odoo.controller";

export async function buildZoneTypeMapByProductId(
  goodsList: Array<{ product_id: number | null | undefined }>,
) {
  const productIds = Array.from(
    new Set(
      goodsList
        .map((g) => g.product_id)
        .filter((id): id is number => Number.isFinite(id)),
    ),
  );

  const map = new Map<number, string | null>();

  if (!productIds.length) return map;

  const rows = await prisma.wms_mdt_goods.findMany({
    where: {
      product_id: { in: productIds },
    },
    select: {
      product_id: true,
      zone_type: true,
    },
  });

  for (const row of rows) {
    // เอาตัวแรกของ product_id นั้น
    if (!map.has(row.product_id)) {
      map.set(row.product_id, row.zone_type ?? null);
    }
  }

  return map;
}

export async function buildInputNumberMapByLotText(
  goodsList: Array<{
    product_id: number;
    lot_id: number | null;
    lot_text: string;
  }>,
) {
  const map = new Map<GoodsKey, boolean>();
  if (goodsList.length === 0) return map;

  // query แบบเดิม (ไม่ทำให้ schema/flow พัง) แต่ "เอา lot_id ออกจากการเช็ค"
  const uniqLotIdPairs = Array.from(
    new Map(
      goodsList.map((g) => [
        goodsKeyByLotId(g.product_id, g.lot_id),
        { product_id: g.product_id, lot_id: g.lot_id },
      ]),
    ).values(),
  );

  const wmsGoods = await prisma.wms_mdt_goods.findMany({
    where: {
      OR: uniqLotIdPairs.map((g) => ({
        product_id: g.product_id,
        ...(g.lot_id != null ? { lot_id: g.lot_id } : {}),
      })),
    },
    select: { id: true, product_id: true, lot_id: true, input_number: true },
    orderBy: { id: "desc" },
  });

  // map ชั่วคราวตาม lot_id (ใช้เพื่อ “ดึงค่า”)
  const tmpByLotId = new Map<string, boolean>();
  for (const r of wmsGoods) {
    const k = goodsKeyByLotId(r.product_id, r.lot_id ?? null);
    if (!tmpByLotId.has(k)) tmpByLotId.set(k, r.input_number ?? false);
  }

  // ✅ map สุดท้ายตาม lot_text (ตัวที่ใช้เช็คจริง)
  for (const g of goodsList) {
    const byLotId =
      tmpByLotId.get(goodsKeyByLotId(g.product_id, g.lot_id)) ??
      tmpByLotId.get(goodsKeyByLotId(g.product_id, null)) ??
      false;

    map.set(goodsKeyByLotText(g.product_id, g.lot_text), byLotId);

    // ✅ ไม่กระทบ flow อื่น: ใส่ key แบบเดิมไว้ด้วย เผื่อส่วนอื่นยังเรียก
    map.set(goodsKeyByLotId(g.product_id, g.lot_id), byLotId);
  }

  return map;
}

export async function buildZoneTypeMapByLotText(
  goodsList: Array<{
    product_id: number;
    lot_id: number | null;
    lot_text: string;
  }>,
) {
  const map = new Map<GoodsKey, string | null>();
  if (goodsList.length === 0) return map;

  const uniqLotIdPairs = Array.from(
    new Map(
      goodsList.map((g) => [
        goodsKeyByLotId(g.product_id, g.lot_id),
        { product_id: g.product_id, lot_id: g.lot_id },
      ]),
    ).values(),
  );

  const rows = await prisma.wms_mdt_goods.findMany({
    where: {
      OR: uniqLotIdPairs.map((g) => ({
        product_id: g.product_id,
        ...(g.lot_id != null ? { lot_id: g.lot_id } : {}),
      })),
    },
    select: { id: true, product_id: true, lot_id: true, zone_type: true },
    orderBy: { id: "desc" }, // ให้ record ล่าสุดเป็นตัวแทน
  });

  const tmpByLotId = new Map<string, string | null>();
  for (const r of rows) {
    const k = goodsKeyByLotId(r.product_id, r.lot_id ?? null);
    if (!tmpByLotId.has(k)) tmpByLotId.set(k, r.zone_type ?? null);
  }

  for (const g of goodsList) {
    const z =
      tmpByLotId.get(goodsKeyByLotId(g.product_id, g.lot_id)) ??
      tmpByLotId.get(goodsKeyByLotId(g.product_id, null)) ??
      null;

    map.set(goodsKeyByLotText(g.product_id, g.lot_text), z);

    // compatibility key เดิม
    map.set(goodsKeyByLotId(g.product_id, g.lot_id), z);
  }

  return map;
}

export function resolveInputNumber(
  map: Map<GoodsKey, boolean>,
  product_id: number | null | undefined,
  lot_serial: any,
  lot: any,
  lot_id: number | null | undefined,
) {
  if (product_id == null) return false;

  const lot_text = resolveLotText({ lot_serial, lot });
  if (lot_text) {
    const v = map.get(goodsKeyByLotText(product_id, lot_text));
    if (v !== undefined) return v;
  }

  // fallback กันข้อมูลเก่า
  return map.get(goodsKeyByLotId(product_id, lot_id ?? null)) ?? false;
}

export function resolveZoneType(
  map: Map<GoodsKey, string | null>,
  product_id: number | null | undefined,
  lot_serial: any,
  lot: any,
  lot_id: number | null | undefined,
) {
  if (product_id == null) return null;

  const lot_text = resolveLotText({ lot_serial, lot });
  if (lot_text) {
    const v = map.get(goodsKeyByLotText(product_id, lot_text));
    if (v !== undefined) return v ?? null;
  }

  // fallback กันข้อมูลเก่า
  return map.get(goodsKeyByLotId(product_id, lot_id ?? null)) ?? null;
}

export async function buildWmsGoodsExpMap(
  tx: Prisma.TransactionClient,
  items: Array<{
    product_id: number | null;
    lot_id: number | null;
  }>,
) {
  const pairs = Array.from(
    new Map(
      items
        .filter((x) => x.product_id != null && x.lot_id != null)
        .map((x) => [
          `${x.product_id}|${x.lot_id}`,
          {
            product_id: x.product_id as number,
            lot_id: x.lot_id as number,
          },
        ]),
    ).values(),
  );

  const map = new Map<string, Date | null>();
  if (pairs.length === 0) return map;

  const rows = await tx.wms_mdt_goods.findMany({
    where: {
      OR: pairs.map((x) => ({
        product_id: x.product_id,
        lot_id: x.lot_id,
      })),
    },
    select: {
      product_id: true,
      lot_id: true,
      expiration_date: true,
      id: true,
    },
    orderBy: { id: "desc" },
  });

  for (const row of rows) {
    const key = `${row.product_id}|${row.lot_id ?? 0}`;
    if (!map.has(key)) {
      map.set(key, row.expiration_date ?? null);
    }
  }

  return map;
}

export function resolveInboundExp(
  item: NormalizedInboundItem,
  wmsExpMap: Map<string, Date | null>,
): Date | undefined {
  const fromOdoo = toExpDate(item.expire_date);
  if (fromOdoo) return fromOdoo;

  if (item.product_id == null || item.lot_id == null) return undefined;

  const fromWms = wmsExpMap.get(`${item.product_id}|${item.lot_id}`);
  return fromWms ?? undefined;
}
