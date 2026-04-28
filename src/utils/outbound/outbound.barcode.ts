import { prisma } from "../../lib/prisma";
import { normalizeScanText } from "../helper_scan/barcode";
import type { InputKey, LockKey, LockLocRow } from "./outbound.type";
import { normalizeLot } from "./outbound.parse";
import { Prisma } from "@prisma/client";

export const keyOf = (
  product_id: number | null | undefined,
  lot_serial: string | null | undefined,
): InputKey => `p:${product_id ?? "null"}|lotSer:${(lot_serial ?? "").trim()}`;

export async function buildInputNumberMapFromItems(
  items: Array<{
    product_id?: number | null;
    lot_serial?: string | null;
    lot_name?: string | null;
  }>,
) {
  const pids = Array.from(
    new Set(
      items
        .map((x) => (typeof x.product_id === "number" ? x.product_id : null))
        .filter((x): x is number => x != null),
    ),
  );

  const map = new Map<InputKey, boolean>();
  if (pids.length === 0) return map;

  const rows = await prisma.wms_mdt_goods.findMany({
    where: { product_id: { in: pids } },
    select: { id: true, product_id: true, input_number: true },
    orderBy: { id: "desc" },
  });

  for (const r of rows) {
    const k = keyOf(r.product_id, "");
    if (!map.has(k)) map.set(k, Boolean(r.input_number));
  }

  return map;
}

export function resolveInputNumberFromMap(
  map: Map<InputKey, boolean>,
  product_id: number | null | undefined,
  lot_serial: string | null | undefined,
) {
  if (typeof product_id !== "number") return false;

  const exact = map.get(keyOf(product_id, (lot_serial ?? "").trim()));
  if (exact !== undefined) return exact;

  const fallback = map.get(keyOf(product_id, ""));
  if (fallback !== undefined) return fallback;

  return false;
}

export const lockKeyOf = (
  product_id: number | null | undefined,
  lot_name: string | null | undefined,
) => `p:${product_id ?? "null"}|lot_name:${(lot_name ?? "").trim()}`;

export async function buildLockNoMapFromItems(
  items: Array<{
    product_id?: number | null;
    lot_name?: string | null;
  }>,
) {
  const keys = items
    .map((x) => lockKeyOf(x.product_id ?? null, x.lot_name ?? null))
    .filter(Boolean);

  const uniqueKeys = Array.from(new Set(keys));
  const map = new Map<LockKey, LockLocRow[]>();
  if (uniqueKeys.length === 0) return map;

  const pids = Array.from(
    new Set(
      items
        .map((x) => (typeof x.product_id === "number" ? x.product_id : null))
        .filter((x): x is number => x != null),
    ),
  );

  if (pids.length === 0) return map;

  const rows = await prisma.stock.findMany({
    where: {
      source: "wms",
      product_id: { in: pids },
    } as any,
    select: {
      product_id: true,
      lot_name: true,
      location_id: true,
      location_name: true,
      quantity: true,
      expiration_date: true,
    } as any,
    orderBy: [{ product_id: "asc" }, { location_name: "asc" }],
  });

  const temp = new Map<
    LockKey,
    Map<number, { location_id: number; location_name: string; qty: number }>
  >();

  for (const r of rows as any[]) {
    const k = lockKeyOf(r.product_id, r.lot_name ?? null);
    if (!uniqueKeys.includes(k)) continue;

    const locId = Number(r.location_id ?? 0);
    if (!Number.isFinite(locId) || locId <= 0) continue;

    const locName = String(r.location_name ?? "").trim();
    if (!locName) continue;

    const qty = Number(r.quantity ?? 0);
    if (!Number.isFinite(qty)) continue;

    if (!temp.has(k)) temp.set(k, new Map());
    const byLoc = temp.get(k)!;

    const prev = byLoc.get(locId);
    if (prev) {
      prev.qty += qty;
    } else {
      byLoc.set(locId, { location_id: locId, location_name: locName, qty });
    }
  }

  for (const [k, byLoc] of temp.entries()) {
    const arr: LockLocRow[] = Array.from(byLoc.values())
      .filter((x) => x.qty !== 0)
      .sort((a, b) => b.qty - a.qty);

    map.set(k, arr);
  }

  for (const k of uniqueKeys) {
    if (!map.has(k)) map.set(k, []);
  }

  return map;
}

export function resolveLockLocationsFromMap(
  map: Map<LockKey, LockLocRow[]>,
  product_id: number | null | undefined,
  lot_name: string | null | undefined,
) {
  const k = lockKeyOf(product_id ?? null, lot_name ?? null);
  return map.get(k) ?? [];
}

export function resolveLockNoFromMap(
  map: Map<LockKey, LockLocRow[]>,
  product_id: number | null | undefined,
  lot_name: string | null | undefined,
) {
  const locs = resolveLockLocationsFromMap(map, product_id, lot_name);
  return locs.map((x) => `${x.location_name} (จำนวน ${x.qty})`);
}

export type ExpKeyLoc = string;
export type ExpKeyNoLoc = string;

export const expKeyLocOf = (
  product_id: number | null,
  lot_serial: string | null,
  location_id: number | null,
) =>
  `p:${product_id ?? 0}|lot:${normalizeLot(lot_serial)}|loc:${
    location_id ?? 0
  }`;

export const expKeyNoLocOf = (
  product_id: number | null,
  lot_serial: string | null,
) => `p:${product_id ?? 0}|lot:${normalizeLot(lot_serial)}`;

export async function buildExpirationMapsFromStocks(args: {
  items: Array<{
    product_id: number | null;
    lot_serial: string | null;
    location_ids?: number[];
  }>;
}) {
  const { items } = args;

  const pids = Array.from(
    new Set(
      items
        .map((x) => x.product_id)
        .filter(
          (x): x is number => typeof x === "number" && Number.isFinite(x),
        ),
    ),
  );

  const byLoc = new Map<ExpKeyLoc, Date | null>();
  const byNoLoc = new Map<ExpKeyNoLoc, Date | null>();
  if (pids.length === 0) return { byLoc, byNoLoc };

  const locIds = Array.from(
    new Set(
      items
        .flatMap((x) => x.location_ids ?? [])
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  );

  const rows = await prisma.stock.findMany({
    where: {
      source: "wms",
      product_id: { in: pids },
      ...(locIds.length ? { location_id: { in: locIds } } : {}),
    } as any,
    select: {
      product_id: true,
      lot_name: true,
      location_id: true,
      expiration_date: true,
    } as any,
    orderBy: [{ expiration_date: "asc" }] as any,
  });

  for (const r of rows as any[]) {
    const pid = typeof r.product_id === "number" ? r.product_id : null;
    const lotNorm = normalizeLot(r.lot_name);
    const locId = typeof r.location_id === "number" ? r.location_id : null;
    const exp = (r.expiration_date ?? null) as Date | null;

    const kNoLoc: ExpKeyNoLoc = `p:${pid ?? 0}|lot:${lotNorm}`;
    if (!byNoLoc.has(kNoLoc)) byNoLoc.set(kNoLoc, exp);

    if (locId != null) {
      const kLoc: ExpKeyLoc = `p:${pid ?? 0}|lot:${lotNorm}|loc:${
        locId ?? 0
      }`;
      if (!byLoc.has(kLoc)) byLoc.set(kLoc, exp);
    }
  }

  return { byLoc, byNoLoc };
}

export function firstLocId(lockLocations: LockLocRow[]): number | null {
  if (!Array.isArray(lockLocations) || lockLocations.length === 0) return null;
  const id = lockLocations[0]?.location_id;
  return typeof id === "number" && Number.isFinite(id) && id > 0 ? id : null;
}

export const expKeyOf = (
  product_id: number | null,
  lot_serial: string | null,
): string => `p:${product_id ?? 0}|lot:${normalizeLot(lot_serial)}`;

export async function buildExpirationDateMapForGoodsOutItems(
  items: Array<{ product_id: number | null; lot_serial: string | null }>,
) {
  const map = new Map<string, Date | null>();

  const pids = Array.from(
    new Set(
      items
        .map((x) => x.product_id)
        .filter(
          (x): x is number => typeof x === "number" && Number.isFinite(x),
        ),
    ),
  );

  const lotNorms = Array.from(
    new Set(
      items.map((x) => normalizeLot(x.lot_serial)).filter((s) => s.length > 0),
    ),
  );

  if (pids.length === 0 || lotNorms.length === 0) return map;

  const rows = await prisma.stock.findMany({
    where: {
      source: "wms",
      product_id: { in: pids },
    } as any,
    select: {
      product_id: true,
      lot_name: true,
      expiration_date: true,
    } as any,
    orderBy: [{ expiration_date: "asc" }] as any,
  });

  for (const r of rows as any[]) {
    const pid = typeof r.product_id === "number" ? r.product_id : null;
    const lotNorm = normalizeLot(r.lot_name);
    if (!lotNorm) continue;
    if (!lotNorms.includes(lotNorm)) continue;

    const k = `p:${pid ?? 0}|lot:${lotNorm}`;
    if (!map.has(k)) map.set(k, (r.expiration_date ?? null) as Date | null);
  }

  return map;
}

export function lotMatchedNullable(
  itemLot: string | null | undefined,
  scannedLot: string | null | undefined,
) {
  const itemNull = !String(itemLot ?? "").trim();
  const scanNull = !String(scannedLot ?? "").trim();

  if (itemNull && scanNull) return true;
  if (itemNull !== scanNull) return false;

  return (
    normalizeScanText(itemLot ?? "") === normalizeScanText(scannedLot ?? "")
  );
}

export async function hydrateOutboundItemsBarcodeTextFromBarcodeMaster<
  T extends { product_id: number | null; barcode_text?: string | null },
>(tx: Prisma.TransactionClient, items: T[]) {
  const productIds = Array.from(
    new Set(
      items
        .filter((x) => !String(x.barcode_text ?? "").trim())
        .map((x) => x.product_id)
        .filter((x): x is number => typeof x === "number"),
    ),
  );

  if (productIds.length === 0) return items;

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
    orderBy: { id: "desc" },
  });

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
    if (!fallback) {
      return {
        ...item,
        barcode_text: null,
      };
    }

    return {
      ...item,
      barcode_text: fallback,
    };
  });
}