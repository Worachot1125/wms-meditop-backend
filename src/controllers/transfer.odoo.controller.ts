import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";
import { formatOdooTransferDoc } from "../utils/formatters/odoo.transfer_doc.formatter";

/**
 * =========================
 * Helpers (เหมือน inbound controller)
 * =========================
 */

// ✅ normalize สำหรับ lot_serial / lot_name เพื่อใช้เป็น key (ไม่สน lot_id)
function normalizeLotText(v: any): string {
  return String(v ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

// ✅ เลือก lot_text สำหรับ item (lot_serial มาก่อน ถ้าไม่มีค่อยใช้ lot)
function resolveLotText(input: { lot_serial?: any; lot?: any }): string {
  const ls = normalizeLotText(input.lot_serial);
  if (ls) return ls;
  const l = normalizeLotText(input.lot);
  return l;
}

// ===== barcode lookup by barcode_text (เหมือน inbound) =====
async function attachBarcodeByText<T extends { barcode_text?: string | null }>(
  rows: T[],
) {
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

/**
 * =========================
 * ✅ NEW helpers: input_number / zone_type map
 * ✅ เปลี่ยนการ "เช็ค/จับคู่" เป็น product_id + lot_serial(lot_name)
 * - แต่ยังใช้ lot_id ในการ query DB ได้ (เพื่อความแม่น/ไม่กระทบ flow เดิม)
 * =========================
 */
type GoodsKey = string;

// ✅ key ใหม่ (ตาม requirement): product_id + lot_serial(lot_name)
const goodsKeyByLotText = (product_id: number, lot_text: string): GoodsKey =>
  `${product_id}__${lot_text}`;

// (คงไว้เพื่อ compatibility ภายใน: product_id + lot_id)
const goodsKeyByLotId = (
  product_id: number,
  lot_id: number | null | undefined,
): GoodsKey => `${product_id}_${lot_id ?? "null"}`;

async function buildInputNumberMapByLotText(
  goodsList: Array<{
    product_id: number;
    lot_id: number | null;
    lot_text: string;
  }>,
) {
  const map = new Map<GoodsKey, boolean>();
  if (goodsList.length === 0) return map;

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

  const tmpByLotId = new Map<string, boolean>();
  for (const r of wmsGoods) {
    const k = goodsKeyByLotId(r.product_id, r.lot_id ?? null);
    if (!tmpByLotId.has(k)) tmpByLotId.set(k, r.input_number ?? false);
  }

  for (const g of goodsList) {
    const byLotId =
      tmpByLotId.get(goodsKeyByLotId(g.product_id, g.lot_id)) ??
      tmpByLotId.get(goodsKeyByLotId(g.product_id, null)) ??
      false;

    map.set(goodsKeyByLotText(g.product_id, g.lot_text), byLotId);
    map.set(goodsKeyByLotId(g.product_id, g.lot_id), byLotId); // compatibility
  }

  return map;
}

async function buildZoneTypeMapByLotText(
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
    orderBy: { id: "desc" },
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
    map.set(goodsKeyByLotId(g.product_id, g.lot_id), z); // compatibility
  }

  return map;
}

function resolveInputNumber(
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

  return map.get(goodsKeyByLotId(product_id, lot_id ?? null)) ?? false;
}

function resolveZoneType(
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

  return map.get(goodsKeyByLotId(product_id, lot_id ?? null)) ?? null;
}

/**
 * =========================
 * Helpers: stock lock_locations + NCR check enrichment
 * =========================
 */
type LockKey = string;
type LockLocRow = { location_name: string; qty: number };

const lockKeyOf = (
  product_id: number | null | undefined,
  lot_name: string | null | undefined,
) => `p:${product_id ?? "null"}|lot_name:${String(lot_name ?? "").trim()}`;

function normalizeLotNameFromItem(it: {
  lot_serial?: string | null;
  lot?: string | null;
}) {
  const v = it.lot_serial ?? it.lot ?? null;
  const s = v == null ? "" : String(v).trim();
  return s.length > 0 ? s : null;
}

export async function buildLockLocationsMapFromTransferItems(
  items: Array<{
    product_id?: number | null;
    lot_serial?: string | null;
    lot?: string | null;
  }>,
) {
  const keys = items
    .map((x) => lockKeyOf(x.product_id ?? null, normalizeLotNameFromItem(x)))
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
      location_name: true,
      quantity: true,
    },
    orderBy: [{ product_id: "asc" }, { location_name: "asc" }],
  });

  const temp = new Map<LockKey, Map<string, number>>();

  for (const r of rows as any[]) {
    const k = lockKeyOf(r.product_id, r.lot_name ?? null);
    if (!uniqueKeys.includes(k)) continue;

    const locName = String(r.location_name ?? "").trim();
    if (!locName) continue;

    const qty = Number(r.quantity ?? 0);
    if (!Number.isFinite(qty) || qty === 0) continue;

    if (!temp.has(k)) temp.set(k, new Map<string, number>());
    const byLoc = temp.get(k)!;
    byLoc.set(locName, (byLoc.get(locName) ?? 0) + qty);
  }

  for (const [k, byLoc] of temp.entries()) {
    const arr: LockLocRow[] = Array.from(byLoc.entries())
      .map(([location_name, qty]) => ({ location_name, qty }))
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
  return map.get(lockKeyOf(product_id ?? null, lot_name ?? null)) ?? [];
}

export function resolveLockNoListFromMap(
  map: Map<LockKey, LockLocRow[]>,
  product_id: number | null | undefined,
  lot_name: string | null | undefined,
) {
  const locs = resolveLockLocationsFromMap(map, product_id, lot_name);
  return locs.map((x) => `${x.location_name} (จำนวน ${x.qty})`);
}

// ✅ enrich: lock_locations[].ncr_check จาก locations.full_name
const normKey = (v: any) =>
  String(v ?? "")
    .trim()
    .toLowerCase();

async function enrichLockLocationsWithNcrCheck<
  T extends { lock_locations?: any[] },
>(rows: T[]) {
  const names = Array.from(
    new Set(
      rows
        .flatMap((it: any) => it.lock_locations || [])
        .map((x: any) => String(x?.location_name ?? "").trim())
        .filter((x) => x.length > 0),
    ),
  );

  const ncrMap = new Map<string, boolean>();
  if (names.length > 0) {
    const locRows = await prisma.location.findMany({
      where: {
        deleted_at: null,
        OR: names.map((name) => ({
          full_name: { equals: name, mode: "insensitive" as any },
        })),
      },
      select: { full_name: true, ncr_check: true },
    });

    for (const r of locRows) {
      ncrMap.set(normKey(r.full_name), Boolean(r.ncr_check));
    }
  }

  return rows.map((it: any) => ({
    ...it,
    lock_locations: (it.lock_locations || []).map((x: any) => ({
      ...x,
      ncr_check: ncrMap.get(normKey(x?.location_name)) ?? false,
    })),
  }));
}

/**
 * ==============
 * 2) GET list (all transfer_docs)
 * ==============
 * ✅ FIX/ADD:
 * - เพิ่ม lock_locations + lock_no_list
 * - เพิ่ม lock_locations[].ncr_check
 * - เพิ่ม ncr_location ใน item
 */
export const getOdooTransferDocs = asyncHandler(
  async (req: Request, res: Response) => {
    const docs = await prisma.transfer_doc.findMany({
      where: {
        deleted_at: null,
        picking_id: { not: null },
      },
      include: {
        transfer_doc_items: {
          where: {
            deleted_at: null,
            transfer_doc_id: { not: null },
          },
          orderBy: { sequence: "asc" },
        },
      },
      orderBy: { created_at: "desc" },
    });

    const departmentIds = [
      ...new Set(
        docs
          .map((d) => d.department_id)
          .filter((id): id is string => id != null)
          .map((id) => parseInt(id, 10))
          .filter((id) => !isNaN(id)),
      ),
    ];

    const deptMap = new Map<number, string>();
    if (departmentIds.length > 0) {
      const departments = await prisma.department.findMany({
        where: { odoo_id: { in: departmentIds } },
        select: { odoo_id: true, short_name: true },
      });
      departments.forEach((dept) => {
        if (dept.odoo_id) deptMap.set(dept.odoo_id, dept.short_name);
      });
    }

    const allItems = docs.flatMap((d) => d.transfer_doc_items || []);
    const { map: barcodeMap } = await attachBarcodeByText(allItems as any);

    // ✅ lock locations map for all items (ลดจำนวน query)
    const lockLocMap = await buildLockLocationsMapFromTransferItems(
      (allItems || []).map((it: any) => ({
        product_id: it.product_id,
        lot_serial: it.lot_serial,
        lot: it.lot,
      })),
    );

    // สร้าง item base ก่อน เพื่อ enrich ncr_check ทีเดียว
    const allItemBase = allItems.map((it: any) => {
      const t = (it.barcode_text ?? "").trim();
      const b = t ? barcodeMap.get(t) : null;

      const lot_name = normalizeLotNameFromItem({
        lot_serial: it.lot_serial,
        lot: it.lot,
      });

      const lock_locations = resolveLockLocationsFromMap(
        lockLocMap,
        it.product_id,
        lot_name,
      );

      const lock_no_list = resolveLockNoListFromMap(
        lockLocMap,
        it.product_id,
        lot_name,
      );

      return {
        id: it.id,
        transfer_doc_id: it.transfer_doc_id,
        sequence: it.sequence,
        product_id: it.product_id,
        code: it.code,
        name: it.name,
        unit: it.unit,
        tracking: it.tracking,
        lot_id: it.lot_id,
        lot_serial: it.lot_serial,
        qty: it.qty,
        quantity_receive: it.quantity_receive,
        quantity_count: it.quantity_count,
        quantity_put: it.quantity_put,
        ncr_location: it.ncr_location ?? null, // ✅ NEW
        lot: it.lot,
        exp: it.exp,

        lock_locations,
        lock_no_list,

        barcode_text: it.barcode_text ?? null,
        barcode: b
          ? {
              barcode: b.barcode,
              lot_start: b.lot_start ?? null,
              lot_stop: b.lot_stop ?? null,
              exp_start: b.exp_start ?? null,
              exp_stop: b.exp_stop ?? null,
              barcode_length: b.barcode_length ?? null,
            }
          : null,

        created_at: it.created_at,
        updated_at: it.updated_at,
      };
    });

    const allItemEnriched = await enrichLockLocationsWithNcrCheck(allItemBase);
    const itemById = new Map<string, any>();
    for (const it of allItemEnriched as any[]) itemById.set(String(it.id), it);

    const formattedData = docs.map((doc) => {
      const formatted = formatOdooTransferDoc(doc as any);
      const deptId = doc.department_id ? parseInt(doc.department_id, 10) : NaN;
      const shortName = !isNaN(deptId) ? deptMap.get(deptId) : undefined;

      return {
        ...formatted,
        department: shortName ?? formatted.department,
        items: (doc.transfer_doc_items || []).map((it: any) => {
          return itemById.get(String(it.id)) ?? it;
        }),
      };
    });

    return res.json({
      total: formattedData.length,
      data: formattedData,
    });
  },
);

type NcrLocRow = {
  transfer_doc_item_id: string;
  location_id: number;
};

async function buildNcrLocationNamesMapByItemIds(
  prismaOrTx: any,
  itemIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (itemIds.length === 0) return map;

  // init กัน undefined
  for (const id of itemIds) map.set(id, []);

  // ✅ IMPORTANT:
  // ชื่อ model ใน Prisma Client จะเป็น camelCase จาก model Prisma
  // ถ้า model คุณชื่อ transfer_doc_item_ncr_location -> จะเรียก prismaOrTx.transfer_doc_item_ncr_location
  const links = await prismaOrTx.transfer_doc_item_ncr_location.findMany({
    where: { transfer_doc_item_id: { in: itemIds } },
    select: { transfer_doc_item_id: true, location_id: true },
  });

  if (!Array.isArray(links) || links.length === 0) return map;

  const locIds = Array.from(
    new Set(links.map((x: any) => Number(x.location_id))),
  );

  const locRows = await prismaOrTx.location.findMany({
    where: { id: { in: locIds }, deleted_at: null },
    select: { id: true, full_name: true },
  });

  const locNameById = new Map<number, string>();
  for (const r of locRows as any[]) {
    locNameById.set(Number(r.id), String(r.full_name));
  }

  for (const link of links as any[]) {
    const itemId = String(link.transfer_doc_item_id);
    const locName = locNameById.get(Number(link.location_id));
    if (!locName) continue;

    const arr = map.get(itemId) ?? [];
    arr.push(locName);
    map.set(itemId, arr);
  }

  // unique + sort
  for (const [itemId, arr] of map.entries()) {
    const uniq = Array.from(new Set(arr));
    uniq.sort((a, b) => a.localeCompare(b));
    map.set(itemId, uniq);
  }

  return map;
}

type TransferPickConfirmView = {
  location_id: number;
  location_name: string;
  confirmed_qty: number;
};

type TransferPutConfirmView = {
  location_id: number;
  location_name: string;
  confirmed_put: number;
};

async function buildPickLocationMapByItemIds(
  prismaOrTx: any,
  itemIds: string[],
): Promise<Map<string, TransferPickConfirmView[]>> {
  const map = new Map<string, TransferPickConfirmView[]>();
  if (itemIds.length === 0) return map;

  for (const id of itemIds) map.set(id, []);

  const rows = await prismaOrTx.transfer_doc_item_location_confirm.findMany({
    where: {
      transfer_doc_item_id: { in: itemIds },
      confirmed_qty: { gt: 0 },
    },
    select: {
      transfer_doc_item_id: true,
      location_id: true,
      confirmed_qty: true,
      location: {
        select: {
          id: true,
          full_name: true,
        },
      },
    },
    orderBy: [{ location_id: "asc" }],
  });

  for (const row of rows as any[]) {
    const itemId = String(row.transfer_doc_item_id);
    const arr = map.get(itemId) ?? [];
    arr.push({
      location_id: Number(row.location_id),
      location_name: String(row.location?.full_name ?? ""),
      confirmed_qty: Number(row.confirmed_qty ?? 0),
    });
    map.set(itemId, arr);
  }

  return map;
}

async function buildPutLocationMapByItemIds(
  prismaOrTx: any,
  itemIds: string[],
): Promise<Map<string, TransferPutConfirmView[]>> {
  const map = new Map<string, TransferPutConfirmView[]>();
  if (itemIds.length === 0) return map;

  for (const id of itemIds) map.set(id, []);

  const rows = await prismaOrTx.transfer_doc_item_location_put_confirm.findMany(
    {
      where: {
        transfer_doc_item_id: { in: itemIds },
        confirmed_put: { gt: 0 },
      },
      select: {
        transfer_doc_item_id: true,
        location_id: true,
        confirmed_put: true,
        location: {
          select: {
            id: true,
            full_name: true,
          },
        },
      },
      orderBy: [{ location_id: "asc" }],
    },
  );

  for (const row of rows as any[]) {
    const itemId = String(row.transfer_doc_item_id);
    const arr = map.get(itemId) ?? [];
    arr.push({
      location_id: Number(row.location_id),
      location_name: String(row.location?.full_name ?? ""),
      confirmed_put: Number(row.confirmed_put ?? 0),
    });
    map.set(itemId, arr);
  }

  return map;
}

/**
 * ==============
 * 3) GET by no (full)
 * ==============
 * ✅ FIX/ADD:
 * - เพิ่ม ncr_location ใน item
 * - เพิ่ม lock_locations + lock_no_list
 * - เพิ่ม lock_locations[].ncr_check
 */
export const getOdooTransferDocByNo = asyncHandler(
  async (req: Request<{ no: string }>, res: Response) => {
    const rawNo = Array.isArray(req.params.no)
      ? req.params.no[0]
      : req.params.no;
    if (!rawNo) throw badRequest("กรุณาระบุเลข no");
    const no = decodeURIComponent(rawNo);

    const doc = await prisma.transfer_doc.findUnique({
      where: { no },
      include: {
        transfer_doc_items: {
          where: { deleted_at: null },
          orderBy: { sequence: "asc" },
        },
      },
    });

    if (!doc) throw notFound(`ไม่พบ TransferDoc no: ${no}`);
    if (doc.deleted_at) throw badRequest("TransferDoc นี้ถูกลบไปแล้ว");

    let departmentShortName: string | undefined;
    if (doc.department_id) {
      const deptId = parseInt(doc.department_id, 10);
      if (!isNaN(deptId)) {
        const dept = await prisma.department.findFirst({
          where: { odoo_id: deptId },
          select: { short_name: true },
        });
        departmentShortName = dept?.short_name;
      }
    }

    const goodsList =
      doc.transfer_doc_items
        ?.filter((it) => it.product_id != null)
        .map((it) => ({
          product_id: it.product_id!,
          lot_id: it.lot_id ?? null,
          lot_text: resolveLotText({
            lot_serial: it.lot_serial,
            lot: it.lot,
          }),
        })) || [];

    const inputNumberMap = await buildInputNumberMapByLotText(goodsList);
    const zoneTypeMap = await buildZoneTypeMapByLotText(goodsList);

    const { map: barcodeMap } = await attachBarcodeByText(
      doc.transfer_doc_items as any,
    );

    const lockLocMap = await buildLockLocationsMapFromTransferItems(
      (doc.transfer_doc_items || []).map((it) => ({
        product_id: it.product_id,
        lot_serial: it.lot_serial,
        lot: it.lot,
      })),
    );

    const formattedDoc = formatOdooTransferDoc(doc as any);

    const itemIds = (doc.transfer_doc_items || []).map((x: any) =>
      String(x.id),
    );
    const ncrLocNameMap = await buildNcrLocationNamesMapByItemIds(
      prisma,
      itemIds,
    );
    const pickLocationMap = await buildPickLocationMapByItemIds(
      prisma,
      itemIds,
    );
    const putLocationMap = await buildPutLocationMapByItemIds(prisma, itemIds);

    // ✅ ดึง exp จาก wms_mdt_goods โดยใช้ product_id + lot_id
    const productLotKeys = Array.from(
      new Set(
        (doc.transfer_doc_items || [])
          .filter(
            (it: any) =>
              typeof it.product_id === "number" &&
              typeof it.lot_id === "number",
          )
          .map((it: any) => `${it.product_id}__${it.lot_id}`),
      ),
    );

    const mdtRows = await prisma.wms_mdt_goods.findMany({
      where: {
        OR: productLotKeys.map((key) => {
          const [productIdText, lotIdText] = key.split("__");
          return {
            product_id: Number(productIdText),
            lot_id: Number(lotIdText),
          };
        }),
      },
      select: {
        product_id: true,
        lot_id: true,
        expiration_date: true,
      },
    });

    const mdtExpMap = new Map<string, Date | null>();
    for (const row of mdtRows) {
      if (
        typeof row.product_id !== "number" ||
        typeof row.lot_id !== "number"
      ) {
        continue;
      }
      const key = `${row.product_id}__${row.lot_id}`;
      if (!mdtExpMap.has(key)) {
        mdtExpMap.set(key, row.expiration_date ?? null);
      }
    }

    const baseItems = (doc.transfer_doc_items || []).map((it: any) => {
      const input_number = resolveInputNumber(
        inputNumberMap,
        it.product_id,
        it.lot_serial,
        it.lot,
        it.lot_id ?? null,
      );

      const zone_type = resolveZoneType(
        zoneTypeMap,
        it.product_id,
        it.lot_serial,
        it.lot,
        it.lot_id ?? null,
      );

      const t = (it.barcode_text ?? "").trim();
      const b = t ? barcodeMap.get(t) : null;

      const lot_name = normalizeLotNameFromItem({
        lot_serial: it.lot_serial,
        lot: it.lot,
      });

      const lock_locations = resolveLockLocationsFromMap(
        lockLocMap,
        it.product_id,
        lot_name,
      );

      const lock_no_list = resolveLockNoListFromMap(
        lockLocMap,
        it.product_id,
        lot_name,
      );

      const mdtExpKey =
        typeof it.product_id === "number" && typeof it.lot_id === "number"
          ? `${it.product_id}__${it.lot_id}`
          : null;

      const mdtExp = mdtExpKey ? mdtExpMap.get(mdtExpKey) : undefined;
      const resolvedExp = mdtExp ?? it.exp ?? null;

      return {
        id: it.id,
        transfer_doc_id: it.transfer_doc_id,
        sequence: it.sequence,
        product_id: it.product_id,
        code: it.code,
        name: it.name,
        unit: it.unit,
        tracking: it.tracking,
        lot_id: it.lot_id,
        lot_serial: it.lot_serial,

        zone_type,
        user_ref: (it as any).user_ref ?? null,

        qty: it.qty,
        quantity_receive: it.quantity_receive,
        quantity_count: it.quantity_count,
        quantity_put: it.quantity_put,

        pick_locations: pickLocationMap.get(String(it.id)) ?? [],
        put_locations: putLocationMap.get(String(it.id)) ?? [],

        ncr_locations: ncrLocNameMap.get(String(it.id)) ?? [],
        ncr_location: it.ncr_location ?? null,

        lot: it.lot,
        exp: resolvedExp,

        odoo_line_key: it.odoo_line_key,
        odoo_sequence: it.odoo_sequence,
        input_number,

        lock_locations,
        lock_no_list,

        barcode_text: it.barcode_text ?? null,
        barcode: b
          ? {
              barcode: b.barcode,
              lot_start: b.lot_start ?? null,
              lot_stop: b.lot_stop ?? null,
              exp_start: b.exp_start ?? null,
              exp_stop: b.exp_stop ?? null,
              barcode_length: b.barcode_length ?? null,
            }
          : null,

        created_at: it.created_at,
        updated_at: it.updated_at,
      };
    });

    const items = await enrichLockLocationsWithNcrCheck(baseItems);

    return res.json({
      ...formattedDoc,
      department: departmentShortName ?? formattedDoc.department,
      items,
    });
  },
);

/**
 * ==============
 * 4) GET by no (Paginated)
 * ==============
 * ✅ FIX/ADD:
 * - เพิ่ม ncr_location ใน item
 * - เพิ่ม lock_locations + lock_no_list
 * - เพิ่ม lock_locations[].ncr_check
 */
export const getOdooTransferDocByNoPaginated = asyncHandler(
  async (req: Request<{ no: string }>, res: Response) => {
    const rawNo = Array.isArray(req.params.no)
      ? req.params.no[0]
      : req.params.no;
    if (!rawNo) throw badRequest("กรุณาระบุเลข no");
    const no = decodeURIComponent(rawNo);

    const page = Number(req.query.page) || 1;
    const limit =
      req.query.limit !== undefined ? Number(req.query.limit) || 10 : 10;
    if (isNaN(page) || page < 1) {
      throw badRequest("page ต้องเป็นตัวเลขบวกที่มีค่ามากกว่า 0");
    }
    const skip = (page - 1) * limit;

    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

    const doc = await prisma.transfer_doc.findUnique({ where: { no } });
    if (!doc) throw notFound(`ไม่พบ TransferDoc no: ${no}`);
    if (doc.deleted_at) throw badRequest("TransferDoc นี้ถูกลบไปแล้ว");

    let departmentShortName: string | undefined;
    if (doc.department_id) {
      const deptId = parseInt(doc.department_id, 10);
      if (!isNaN(deptId)) {
        const dept = await prisma.department.findFirst({
          where: { odoo_id: deptId },
          select: { short_name: true },
        });
        departmentShortName = dept?.short_name;
      }
    }

    const baseWhere: Prisma.transfer_doc_itemWhereInput = {
      transfer_doc_id: doc.id,
      deleted_at: null,
    };

    let where: Prisma.transfer_doc_itemWhereInput = baseWhere;

    if (search) {
      const searchCondition: Prisma.transfer_doc_itemWhereInput = {
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { code: { contains: search, mode: "insensitive" } },
          { lot: { contains: search, mode: "insensitive" } },
          { lot_serial: { contains: search, mode: "insensitive" } },
          { tracking: { contains: search, mode: "insensitive" } },
          { barcode_text: { contains: search, mode: "insensitive" } },
        ],
      };

      if (!isNaN(Number(search))) {
        searchCondition.OR?.push({ qty: { equals: Number(search) } });
      }

      where = { AND: [baseWhere, searchCondition] };
    }

    const [items, total] = await Promise.all([
      prisma.transfer_doc_item.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: "asc" },
      }),
      prisma.transfer_doc_item.count({ where }),
    ]);

    const goodsList = items
      .filter((it) => it.product_id != null)
      .map((it) => ({
        product_id: it.product_id!,
        lot_id: it.lot_id ?? null,
        lot_text: resolveLotText({
          lot_serial: it.lot_serial,
          lot: it.lot,
        }),
      }));

    const inputNumberMap = await buildInputNumberMapByLotText(goodsList);
    const zoneTypeMap = await buildZoneTypeMapByLotText(goodsList);

    const { map: barcodeMap } = await attachBarcodeByText(items as any);

    const lockLocMap = await buildLockLocationsMapFromTransferItems(
      (items || []).map((it) => ({
        product_id: it.product_id,
        lot_serial: it.lot_serial,
        lot: it.lot,
      })),
    );

    const pagedItemIds = items.map((x: any) => String(x.id));
    const pickLocationMap = await buildPickLocationMapByItemIds(
      prisma,
      pagedItemIds,
    );
    const putLocationMap = await buildPutLocationMapByItemIds(
      prisma,
      pagedItemIds,
    );

    const baseData = items.map((it: any) => {
      const input_number = resolveInputNumber(
        inputNumberMap,
        it.product_id,
        it.lot_serial,
        it.lot,
        it.lot_id ?? null,
      );

      const zone_type = resolveZoneType(
        zoneTypeMap,
        it.product_id,
        it.lot_serial,
        it.lot,
        it.lot_id ?? null,
      );

      const t = (it.barcode_text ?? "").trim();
      const b = t ? barcodeMap.get(t) : null;

      const lot_name = normalizeLotNameFromItem({
        lot_serial: it.lot_serial,
        lot: it.lot,
      });

      const lock_locations = resolveLockLocationsFromMap(
        lockLocMap,
        it.product_id,
        lot_name,
      );

      const lock_no_list = resolveLockNoListFromMap(
        lockLocMap,
        it.product_id,
        lot_name,
      );

      return {
        id: it.id,
        transfer_doc_id: it.transfer_doc_id,
        sequence: it.sequence,
        product_id: it.product_id,
        code: it.code,
        name: it.name,
        unit: it.unit,
        tracking: it.tracking,
        lot_id: it.lot_id,
        lot_serial: it.lot_serial,

        zone_type,
        user_ref: (it as any).user_ref ?? null,

        qty: it.qty,
        quantity_receive: it.quantity_receive,
        quantity_count: it.quantity_count,
        quantity_put: it.quantity_put,

        pick_locations: pickLocationMap.get(String(it.id)) ?? [],
        put_locations: putLocationMap.get(String(it.id)) ?? [],

        ncr_location: it.ncr_location ?? null,

        lot: it.lot,
        exp: it.exp,

        odoo_line_key: it.odoo_line_key,
        odoo_sequence: it.odoo_sequence,
        input_number,

        lock_locations,
        lock_no_list,

        barcode_text: it.barcode_text ?? null,
        barcode: b
          ? {
              barcode: b.barcode,
              lot_start: b.lot_start ?? null,
              lot_stop: b.lot_stop ?? null,
              exp_start: b.exp_start ?? null,
              exp_stop: b.exp_stop ?? null,
              barcode_length: b.barcode_length ?? null,
            }
          : null,

        created_at: it.created_at,
        updated_at: it.updated_at,
      };
    });

    const data = await enrichLockLocationsWithNcrCheck(baseData);

    return res.json({
      transfer_doc: {
        id: doc.id,
        picking_id: doc.picking_id,
        no: doc.no,
        lot: doc.lot,
        location_id: doc.location_id,
        location: doc.location,
        location_dest_id: doc.location_dest_id,
        location_dest: doc.location_dest,
        department_id: doc.department_id,
        department: departmentShortName ?? doc.department,
        reference: doc.reference,
        origin: doc.origin,
        date: doc.date,
        in_type: doc.in_type,
        created_at: doc.created_at,
        updated_at: doc.updated_at,
      },
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  },
);

/**
 * ==============
 * 5) UPDATE transfer_doc (header + items lot sync)
 * ==============
 * ✅ NOTE:
 * - ไม่ต้องแก้ logic หลัก
 * - แต่คืนค่า "full" ที่ include items ให้ formatter ใช้งานได้เต็ม (กันบาง formatter ต้องการ items)
 */
export const updateOdooTransferDoc = asyncHandler(
  async (req: Request<{ no: string }>, res: Response) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;
    const data = req.body;

    if (!no) throw badRequest("กรุณาระบุเลข no");

    const existing = await prisma.transfer_doc.findUnique({
      where: { no },
      select: { id: true, deleted_at: true },
    });
    if (!existing) throw notFound(`ไม่พบ TransferDoc no: ${no}`);
    if (existing.deleted_at)
      throw badRequest("ไม่สามารถแก้ไข TransferDoc ที่ถูกลบแล้ว");

    const lotText =
      data.lot !== undefined
        ? data.lot === null
          ? null
          : String(data.lot).trim() || null
        : undefined;

    const result = await prisma.$transaction(async (tx) => {
      const header = await tx.transfer_doc.update({
        where: { no },
        data: {
          picking_id: data.picking_id ?? undefined,
          location_id: data.location_id ?? undefined,
          location: data.location ?? undefined,
          location_dest_id: data.location_dest_id ?? undefined,
          location_dest: data.location_dest ?? undefined,
          department_id: data.department_id?.toString() ?? undefined,
          department: data.department ?? undefined,
          reference: data.reference ?? undefined,
          origin: data.origin ?? undefined,
          updated_at: new Date(),
          lot: lotText !== undefined ? lotText : undefined,
        },
        select: { id: true },
      });

      let updatedItems = 0;

      if (lotText !== undefined) {
        const now = new Date();
        const r = await tx.transfer_doc_item.updateMany({
          where: {
            transfer_doc_id: header.id,
            deleted_at: null,
          },
          data: {
            lot: lotText,
            lot_serial: lotText,
            updated_at: now,
          },
        });
        updatedItems = r.count;
      }

      // ✅ include items (กัน formatter/FE ต้องการ items ล่าสุด)
      const full = await tx.transfer_doc.findUniqueOrThrow({
        where: { no },
        include: {
          transfer_doc_items: {
            where: { deleted_at: null },
            orderBy: { sequence: "asc" },
          },
        },
      });

      return { full, updatedItems, lotText };
    });

    return res.json({
      message: "อัพเดท TransferDoc สำเร็จ",
      debug: {
        lotText: result.lotText,
        updatedItems: result.updatedItems,
      },
      data: formatOdooTransferDoc(result.full as any),
    });
  },
);

/**
 * ==============
 * 6) DELETE transfer_doc (soft delete + items)
 * ==============
 */
export const deleteOdooTransferDoc = asyncHandler(
  async (req: Request<{ no: string }>, res: Response) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;

    if (!no) throw badRequest("กรุณาระบุเลข no");

    const existing = await prisma.transfer_doc.findUnique({
      where: { no },
      include: { transfer_doc_items: true },
    });

    if (!existing) throw notFound(`ไม่พบ TransferDoc no: ${no}`);
    if (existing.deleted_at) throw badRequest("TransferDoc นี้ถูกลบไปแล้ว");

    const now = new Date();

    await prisma.transfer_doc.update({
      where: { no },
      data: {
        deleted_at: now,
        updated_at: now,
      },
    });

    if (existing.transfer_doc_items.length > 0) {
      await prisma.transfer_doc_item.updateMany({
        where: {
          transfer_doc_id: existing.id,
          deleted_at: null,
        },
        data: {
          deleted_at: now,
          updated_at: now,
        },
      });
    }

    return res.json({
      message: `ลบ TransferDoc ${no} และ ${existing.transfer_doc_items.length} items สำเร็จ`,
    });
  },
);
