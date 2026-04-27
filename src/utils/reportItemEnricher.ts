import { prisma } from "../lib/prisma";

type ItemLite = {
  product_id?: number | null;
  lot_id?: number | null;
  code?: string | null;
};

function expKey(productId: number, lotId: number) {
  return `p:${productId}|l:${lotId}`;
}

function normalizeCode(v: unknown) {
  return String(v ?? "").trim().toLowerCase();
}

export async function buildExpMapFromItems(items: ItemLite[]) {
  const pairs = Array.from(
    new Map(
      items
        .map((it) => {
          const product_id = Number(it.product_id ?? NaN);
          const lot_id = Number(it.lot_id ?? NaN);

          if (!Number.isFinite(product_id) || product_id <= 0) return null;
          if (!Number.isFinite(lot_id) || lot_id <= 0) return null;

          return [
            expKey(product_id, lot_id),
            { product_id, lot_id },
          ] as const;
        })
        .filter(Boolean) as Array<
        readonly [string, { product_id: number; lot_id: number }]
      >,
    ).values(),
  );

  const map = new Map<string, string | null>();
  if (pairs.length === 0) return map;

  const rows = await prisma.goods_in.findMany({
    where: {
      deleted_at: null,
      OR: pairs.map((p) => ({
        product_id: p.product_id,
        lot_id: p.lot_id,
      })),
    },
    select: {
      product_id: true,
      lot_id: true,
      exp: true,
      updated_at: true,
      created_at: true,
      id: true,
    },
    orderBy: [{ updated_at: "desc" }, { created_at: "desc" }, { id: "desc" }],
  });

  for (const r of rows) {
    const pid = Number(r.product_id ?? NaN);
    const lid = Number(r.lot_id ?? NaN);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (!Number.isFinite(lid) || lid <= 0) continue;

    const k = expKey(pid, lid);
    if (!map.has(k)) {
      map.set(k, r.exp ? r.exp.toISOString() : null);
    }
  }

  return map;
}

export async function buildZoneTypeMapFromItems(items: ItemLite[]) {
  const rawCodes = Array.from(
    new Set(
      items
        .map((it) => String(it.code ?? "").trim())
        .filter((x) => x.length > 0),
    ),
  );

  const map = new Map<string, string | null>();
  if (rawCodes.length === 0) return map;

  const rows = await prisma.wms_mdt_goods.findMany({
    where: {
      OR: rawCodes.map((code) => ({
        product_code: {
          equals: code,
          mode: "insensitive",
        },
      })),
    },
    select: {
      product_code: true,
      zone_type: true,
      id: true,
    },
    orderBy: { id: "desc" },
  });

  for (const r of rows) {
    const key = normalizeCode(r.product_code);
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, r.zone_type ?? null);
    }
  }

  return map;
}

export async function buildReportDetailMaps(items: ItemLite[]) {
  const [expMap, zoneTypeMap] = await Promise.all([
    buildExpMapFromItems(items),
    buildZoneTypeMapFromItems(items),
  ]);

  return { expMap, zoneTypeMap };
}

export function getExpFromMaps(
  expMap: Map<string, string | null>,
  product_id?: number | null,
  lot_id?: number | null,
) {
  const pid = Number(product_id ?? NaN);
  const lid = Number(lot_id ?? NaN);

  if (!Number.isFinite(pid) || pid <= 0) return null;
  if (!Number.isFinite(lid) || lid <= 0) return null;

  return expMap.get(expKey(pid, lid)) ?? null;
}

export function getZoneTypeFromMaps(
  zoneTypeMap: Map<string, string | null>,
  code?: string | null,
) {
  const key = normalizeCode(code);
  if (!key) return null;
  return zoneTypeMap.get(key) ?? null;
}