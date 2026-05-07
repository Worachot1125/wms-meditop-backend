import { prisma } from "../../lib/prisma";
import { Prisma } from "@prisma/client";
import { goodsInBarcodeReuseKey } from "./inbound.key.helper";
import { NormalizedInboundItem } from "./inbound.normalize.helper";

export async function attachBarcodeByText<
  T extends { barcode_text?: string | null },
>(rows: T[]) {
  const texts = Array.from(
    new Set(
      rows
        .map((x) => (x.barcode_text ?? "").trim())
        .filter((x) => x.length > 0),
    ),
  );

  const map = new Map<
    string,
    {
      barcode: string;
      lot_start: number | null;
      lot_stop: number | null;
      exp_start: number | null;
      exp_stop: number | null;
      barcode_length: number | null;
    }
  >();

  if (texts.length === 0) return { map, texts };

  const barcodeRows = await prisma.barcode.findMany({
    where: { barcode: { in: texts }, deleted_at: null },
    select: {
      barcode: true,
      lot_start: true,
      lot_stop: true,
      exp_start: true,
      exp_stop: true,
      barcode_length: true,
    },
  });

  barcodeRows.forEach((b) => map.set(b.barcode, b));
  return { map, texts };
}

export async function buildExistingGoodsInBarcodeTextMap(
  tx: Prisma.TransactionClient,
  items: Array<{
    product_id: number | null;
    lot_id: number | null;
    barcode_text?: string | null;
  }>,
) {
  const pairs = Array.from(
    new Map(
      items
        .filter(
          (x) =>
            x.product_id != null &&
            x.lot_id != null &&
            !String(x.barcode_text ?? "").trim(),
        )
        .map((x) => [
          goodsInBarcodeReuseKey({
            product_id: x.product_id,
            lot_id: x.lot_id,
          }),
          {
            product_id: x.product_id as number,
            lot_id: x.lot_id as number,
          },
        ]),
    ).values(),
  );

  const map = new Map<string, string>();

  if (pairs.length === 0) return map;

  const rows = await tx.goods_in.findMany({
    where: {
      deleted_at: null,
      barcode_text: {
        not: null,
      },
      OR: pairs.map((x) => ({
        product_id: x.product_id,
        lot_id: x.lot_id,
      })),
    },
    select: {
      id: true,
      product_id: true,
      lot_id: true,
      barcode_text: true,
      updated_at: true,
      created_at: true,
    },
    orderBy: [{ updated_at: "desc" }, { created_at: "desc" }],
  });

  for (const row of rows) {
    const text = String(row.barcode_text ?? "").trim();
    if (!text) continue;

    const key = goodsInBarcodeReuseKey({
      product_id: row.product_id ?? null,
      lot_id: row.lot_id ?? null,
    });

    if (!map.has(key)) {
      map.set(key, text);
    }
  }

  return map;
}

export async function hydrateInboundItemsBarcodeTextFromGoodsIn(
  tx: Prisma.TransactionClient,
  items: NormalizedInboundItem[],
) {
  const barcodeMap = await buildExistingGoodsInBarcodeTextMap(tx, items);

  return items.map((item) => {
    const current = String(item.barcode_text ?? "").trim();
    if (current) return item;

    const key = goodsInBarcodeReuseKey({
      product_id: item.product_id ?? null,
      lot_id: item.lot_id ?? null,
    });

    const reused = barcodeMap.get(key) ?? null;
    if (!reused) return item;

    return {
      ...item,
      barcode_text: reused,
    };
  });
}

export async function hydrateInboundItemsBarcodeTextFromBarcodeMaster(
  tx: Prisma.TransactionClient,
  items: NormalizedInboundItem[],
) {
  // เอาเฉพาะ item ที่ยังไม่มี barcode_text
  const productIds = Array.from(
    new Set(
      items
        .filter((x) => !String(x.barcode_text ?? "").trim())
        .map((x) => x.product_id)
        .filter((x): x is number => typeof x === "number"),
    ),
  );

  if (productIds.length === 0) return items;

  // หา barcode จาก master table
  const barcodeRows = await tx.barcode.findMany({
    where: {
      product_id: { in: productIds },
      deleted_at: null,
      active: true,
    },
    select: {
      product_id: true,
      barcode: true,
    },
    orderBy: { id: "desc" }, // เอา latest
  });

  // map product_id → barcode
  const map = new Map<number, string>();

  for (const row of barcodeRows) {
    const bc = String(row.barcode ?? "").trim();
    if (!bc) continue;

    if (!map.has(row.product_id!)) {
      map.set(row.product_id!, bc);
    }
  }

  return items.map((item) => {
    const current = String(item.barcode_text ?? "").trim();
    if (current) return item;

    const fallback = map.get(item.product_id ?? -1);
    if (!fallback) return item;

    return {
      ...item,
      barcode_text: fallback,
    };
  });
}
