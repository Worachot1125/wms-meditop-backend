import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";
import { OdooInboundRequest, OdooInboundRequestParams } from "../types/inbound";
import { formatOdooInbound } from "../utils/formatters/odoo_inbound.formatter";
import { io } from "../index";

/**
 * ==============
 * Helpers
 * ==============
 */

/**
 * แปลง Date -> "YYYY-MM-DD" (UTC safe)
 * ใช้สำหรับ compare key เท่านั้น (ไม่ใช่ display)
 */
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

function toDateOnlyKey(d: Date | null | undefined): string | null {
  if (!d) return null;

  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return null;

  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

function rtcAdjustmentMatchKey(input: {
  product_id: number | null;
  lot_id: number | null;
  lot_serial: string | null;
  exp: Date | null | undefined;
}) {
  return [
    `p:${input.product_id ?? "null"}`,
    `lotId:${input.lot_id ?? "null"}`,
    `lotSer:${normalizeLotText(input.lot_serial)}`,
    `exp:${toDateOnlyKey(input.exp ?? null) ?? "null"}`,
  ].join("|");
}

function isTFNumber(no: string | null | undefined): boolean {
  const s = String(no ?? "")
    .trim()
    .toUpperCase();

  if (!s) return false;

  return s.startsWith("TF") || s.includes("/TF/");
}

function inferInTypeFromNumber(
  no: string | null | undefined,
): "TF" | "GR" | "BOR" | "RTC" | "PD" {
  const s = String(no ?? "").toUpperCase();
  if (!s) return "GR";

  const TYPES: Array<"TF" | "BOR" | "RTC" | "PD" | "GR"> = [
    "TF",
    "BOR",
    "RTC",
    "PD",
    "GR",
  ];

  for (const t of TYPES) {
    if (s.includes(t)) return t;
  }
  return "GR";
}

function isRTCNumber(no: string | null | undefined): boolean {
  const s = String(no ?? "")
    .trim()
    .toUpperCase();
  return s.startsWith("RTC");
}

function extractOutboundNoFromOrigin(origin: any): string | null {
  const s = String(origin ?? "").trim();

  if (!s) return null;

  // รองรับรูปแบบ: "การส่งคืนของ DOxxxx-xxxx"
  const m = s.match(/\b(DO[A-Z0-9-]+)\b/i);
  if (!m) return null;

  return String(m[1] ?? "")
    .trim()
    .toUpperCase();
}

function normalizeLotId(v: any): number | null {
  if (Array.isArray(v))
    return v.length > 0 && typeof v[0] === "number" ? v[0] : null;
  return typeof v === "number" ? v : null;
}

function normalizeLotSerial(v: any): string | null {
  if (Array.isArray(v))
    return v.length > 0 && typeof v[0] === "string" ? v[0] : null;
  return typeof v === "string" ? v : null;
}

function normalizeStr(v: any): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

function normalizeBarcodeTextFromOdoo(item: any): string | null {
  // spec ใหม่: Odoo ส่ง barcodes: [{ barcode: "xxxxx" }]
  if (Array.isArray(item?.barcodes) && item.barcodes.length > 0) {
    const bc = item.barcodes[0]?.barcode;
    const t = typeof bc === "string" ? bc.trim() : "";
    return t.length > 0 ? t : null;
  }
  return null;
}

/**
 * ✅ normalize สำหรับ lot_serial / lot_name เพื่อใช้เป็น key (ไม่สน lot_id)
 */
function normalizeLotText(v: any): string {
  return String(v ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * ✅ เลือก lot_text สำหรับ item (lot_serial มาก่อน ถ้าไม่มีค่อยใช้ lot)
 */
function resolveLotText(input: { lot_serial?: any; lot?: any }): string {
  const ls = normalizeLotText(input.lot_serial);
  if (ls) return ls;
  const l = normalizeLotText(input.lot);
  return l;
}

type NormalizedInboundItem = {
  sequence: number | null;
  product_id: number | null;
  code: string | null;
  name: string | null;
  unit: string | null;
  tracking: string | null;

  // ✅ ยังรับ lot_id มาได้ (เพื่อเก็บลง DB/flow อื่น) แต่ "ไม่ใช้เช็ค/merge"
  lot_id: number | null;

  // ✅ ตัวที่ใช้เช็คจริง: lot_serial (lot_name)
  lot_serial: string | null;

  expire_date: string | null; // เก็บ string เดิม (ถ้ามี)
  qty: number;
  barcode_text: string | null; // ✅ NEW
};

/**
 * ✅ KEY สำหรับ merge items:
 * - ใช้ product_id + lot_serial(lot_name) เป็นหลัก
 * - ❌ เอา lot_id ออกจาก key แล้ว
 * - ที่เหลือคงไว้ตามเดิม (กัน merge ข้ามของคนละตัว)
 */
function buildItemKeyForMerge(input: {
  product_id: number | null;
  code: string | null;
  name: string | null;
  unit: string | null;
  tracking: string | null;
  lot_serial: string | null; // ✅ ใช้ตัวนี้
  expire_date: string | null;
  barcode_text: string | null;
}) {
  return [
    `p:${input.product_id ?? "null"}`,
    `c:${input.code ?? ""}`,
    `n:${input.name ?? ""}`,
    `u:${input.unit ?? ""}`,
    `t:${input.tracking ?? ""}`,
    `lotSer:${normalizeLotText(input.lot_serial)}`,
    `exp:${input.expire_date ?? ""}`,
    `bc:${input.barcode_text ?? ""}`,
  ].join("|");
}

function normalizeExpireDateStr(item: any): string | null {
  const raw =
    item?.expire_date ??
    item?.expire_date ??
    item?.exp ??
    item?.expiry_date ??
    null;

  if (raw === null || raw === undefined) return null;

  const s = String(raw).trim();
  return s.length > 0 ? s : null;
}

function mergeInboundItems(items: any[]): NormalizedInboundItem[] {
  const map = new Map<string, NormalizedInboundItem>();

  items.forEach((item: any, index: number) => {
    const seq = item.sequence ?? index + 1;

    const product_id =
      typeof item.product_id === "number" ? item.product_id : null;
    const code = normalizeStr(item.code);
    const name = normalizeStr(item.name)?.trim() ?? null;
    const unit = normalizeStr(item.unit)?.trim() ?? null;
    const tracking = normalizeStr(item.tracking);

    // ✅ เก็บ lot_id ได้ แต่ "ไม่ใช้เช็ค"
    const lot_id = normalizeLotId(item.lot_id);

    // ✅ lot_serial (lot_name)
    const lot_serial = normalizeLotSerial(item.lot_serial);

    const expire_date = normalizeExpireDateStr(item);

    const qty =
      typeof item.qty === "number" && Number.isFinite(item.qty) ? item.qty : 0;

    const barcode_text = normalizeBarcodeTextFromOdoo(item);

    const key = buildItemKeyForMerge({
      product_id,
      code,
      name,
      unit,
      tracking,
      lot_serial, // ✅ ใช้ lot_serial
      expire_date,
      barcode_text,
    });

    const existing = map.get(key);
    if (existing) {
      existing.qty += qty;
    } else {
      map.set(key, {
        sequence: seq,
        product_id,
        code,
        name,
        unit,
        tracking,
        lot_id, // ✅ เก็บไว้เฉยๆ
        lot_serial,
        expire_date,
        qty,
        barcode_text,
      });
    }
  });

  return Array.from(map.values());
}

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
 * แปลง "YYYY-MM-DD" หรือ ISO string ให้เป็น Date สำหรับเก็บลง timestamp
 * - ถ้าเป็น "YYYY-MM-DD" -> ปักเป็น 00:00:00Z เพื่อไม่ให้ timezone ทำให้วันเพี้ยน
 */
function toExpDate(expStr: string | null): Date | undefined {
  if (!expStr) return undefined;

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(expStr)) {
    return new Date(`${expStr}T00:00:00.000Z`);
  }

  // ISO / other date strings
  const d = new Date(expStr);
  if (isNaN(d.getTime())) return undefined;

  return d;
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

  // fallback กันข้อมูลเก่า
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

  // fallback กันข้อมูลเก่า
  return map.get(goodsKeyByLotId(product_id, lot_id ?? null)) ?? null;
}

function goodsInMatchKey(input: { product_id: number; lot_serial?: any }) {
  return `p:${input.product_id}|lot:${normalizeLotText(input.lot_serial)}`;
}

async function handleTFTransfer(input: {
  picking_id: any;
  number: string;
  location_id: any;
  location: any;
  location_dest_id: any;
  location_dest: any;
  department_id: any;
  department: any;
  reference: any;
  origin: any;
  mergedItems: NormalizedInboundItem[];
}) {
  const {
    picking_id,
    number,
    location_id,
    location,
    location_dest_id,
    location_dest,
    department_id,
    department,
    reference,
    origin,
    mergedItems,
  } = input;

  const convertedReference =
    typeof reference === "boolean"
      ? reference
        ? "true"
        : null
      : reference || null;

  const convertedOrigin =
    typeof origin === "string" ? origin : origin ? String(origin) : null;

  const header = await prisma.$transaction(async (tx) => {
    // 1) upsert transfer_doc header
    const existing = await tx.transfer_doc.findFirst({
      where: { no: number, deleted_at: null },
    });

    const doc = existing
      ? await tx.transfer_doc.update({
          where: { id: existing.id },
          data: {
            picking_id,
            location_id,
            location,
            location_dest_id,
            location_dest,
            department_id: department_id?.toString(),
            department,
            reference: convertedReference,
            origin: convertedOrigin,
            in_type: "TF",
            updated_at: new Date(),
          },
        })
      : await tx.transfer_doc.create({
          data: {
            no: number,
            picking_id,
            location_id,
            location,
            location_dest_id,
            location_dest,
            department_id: department_id?.toString(),
            department,
            reference: convertedReference,
            origin: convertedOrigin,
            date: new Date(),
            in_type: "TF",
          },
        });

    /**
     * ✅ policy เหมือน inbound:
     * - match product_id + lot_serial
     * - ถ้า match และ in_process=false => +qty
     * - ถ้า in_process=true => create ใหม่
     */
    const existingLines = await tx.transfer_doc_item.findMany({
      where: { transfer_doc_id: doc.id, deleted_at: null },
      select: {
        id: true,
        sequence: true,
        product_id: true,
        lot_serial: true,
        in_process: true,
        quantity_receive: true,
        qty: true,
      },
    });

    const openMap = new Map<string, (typeof existingLines)[number]>();
    for (const r of existingLines) {
      if (r.product_id == null) continue;
      if (r.in_process) continue;
      openMap.set(
        goodsInMatchKey({ product_id: r.product_id, lot_serial: r.lot_serial }),
        r,
      );
    }

    const maxSeq = existingLines.reduce(
      (m, x) => Math.max(m, Number(x.sequence ?? 0)),
      0,
    );
    let nextSeq = maxSeq + 1;

    for (let i = 0; i < mergedItems.length; i++) {
      const item = mergedItems[i];

      if (item.product_id == null) {
        throw badRequest(`Odoo item missing product_id (TF: ${number})`);
      }
      if (!item.name || !item.unit) {
        throw badRequest(
          `Odoo item missing name/unit (TF: ${number}, product_id: ${item.product_id})`,
        );
      }

      const lotSerial = item.lot_serial ?? null;
      const key = goodsInMatchKey({
        product_id: item.product_id,
        lot_serial: lotSerial,
      });
      const match = openMap.get(key);

      if (match) {
        const add = Number(item.qty ?? 0);
        if (!Number.isFinite(add) || add <= 0) continue;

        await tx.transfer_doc_item.update({
          where: { id: match.id },
          data: {
            qty: { increment: add },
            quantity_receive: { increment: add },
            updated_at: new Date(),
          } as any,
        });

        (match as any).qty = Number(match.qty ?? 0) + add;
        (match as any).quantity_receive =
          Number(match.quantity_receive ?? 0) + add;
        continue;
      }

      const finalSeq = item.sequence ?? nextSeq++;
      await tx.transfer_doc_item.create({
        data: {
          transfer_doc_id: doc.id,
          sequence: finalSeq,
          odoo_sequence: finalSeq,
          odoo_line_key: `${number}-${finalSeq}`,

          product_id: item.product_id,
          code: item.code ?? undefined,
          name: item.name!,
          unit: item.unit!,
          tracking: item.tracking ?? undefined,

          lot_id: item.lot_id ?? undefined,
          lot_serial: item.lot_serial ?? undefined,
          lot: item.lot_serial ?? undefined,

          qty: item.qty,
          quantity_receive: item.qty,
          quantity_count: 0,

          barcode_text: item.barcode_text ?? undefined,
          exp: toExpDate(item.expire_date),

          updated_at: new Date(),
        },
      });
    }

    return doc;
  });

  const fullDoc = await prisma.transfer_doc.findUnique({
    where: { id: header.id },
    include: {
      transfer_doc_items: {
        where: { deleted_at: null },
        orderBy: { sequence: "asc" },
      },
    },
  });

  return fullDoc;
}

function goodsInBarcodeReuseKey(input: {
  product_id: number | null;
  lot_id: number | null;
}) {
  return `p:${input.product_id ?? "null"}|lotId:${input.lot_id ?? "null"}`;
}

async function buildExistingGoodsInBarcodeTextMap(
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

async function hydrateInboundItemsBarcodeTextFromGoodsIn(
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

async function hydrateInboundItemsBarcodeTextFromBarcodeMaster(
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

/**
 * =========================
 * ✅ NEW: handler Inbound (โค้ดเดิมของคุณ "ย้ายมาใส่ฟังก์ชัน" เพื่อไม่ปน TF)
 * =========================
 * หมายเหตุ: Logic ภายในคงเดิมตามที่คุณส่งมา (แค่ย้ายห่อ)
 */
async function handleInboundTransfer(input: {
  picking_id: any;
  number: string;
  location_id: any;
  location: any;
  location_dest_id: any;
  location_dest: any;
  department_id: any;
  department: any;
  reference: any;
  origin: any;
  invoice: any;
  mergedItems: NormalizedInboundItem[];
}) {
  const {
    picking_id,
    number,
    location_id,
    location,
    location_dest_id,
    location_dest,
    department_id,
    department,
    reference,
    origin,
    invoice,
    mergedItems,
  } = input;

  const convertedReference =
    typeof reference === "boolean"
      ? reference
        ? "true"
        : null
      : reference || null;

  const convertedInvoice =
    invoice === null || invoice === undefined
      ? null
      : String(invoice).trim() || null;

  const convertedOrigin =
    typeof origin === "string" ? origin : origin ? String(origin) : null;

  const header = await prisma.$transaction(async (tx) => {
    let hydratedItems = await hydrateInboundItemsBarcodeTextFromGoodsIn(
      tx,
      mergedItems,
    );

    // ✅ NEW: fallback จาก barcode master
    hydratedItems = await hydrateInboundItemsBarcodeTextFromBarcodeMaster(
      tx,
      hydratedItems,
    );

    // 1) upsert inbound header
    const existing = await tx.inbound.findFirst({
      where: { no: number, deleted_at: null },
    });

    const inType = inferInTypeFromNumber(String(number));

    const inbound = existing
      ? await tx.inbound.update({
          where: { id: existing.id },
          data: {
            picking_id,
            location_id,
            location,
            location_dest_id,
            location_dest,
            department_id: department_id?.toString(),
            department,
            reference: convertedReference,
            origin: convertedOrigin,
            invoice: convertedInvoice,
            in_type: inType,
            updated_at: new Date(),
          },
        })
      : await tx.inbound.create({
          data: {
            no: number,
            picking_id,
            location_id,
            location,
            location_dest_id,
            location_dest,
            department_id: department_id?.toString(),
            department,
            reference: convertedReference,
            origin: convertedOrigin,
            invoice: convertedInvoice,
            date: new Date(),
            in_type: inType,
          },
        });

    // preload goods_in ของ inbound นี้ (เฉพาะที่ยังไม่ถูกลบ)
    const existingLines = await tx.goods_in.findMany({
      where: { inbound_id: inbound.id, deleted_at: null },
      select: {
        id: true,
        sequence: true,
        product_id: true,
        lot_serial: true,
        in_process: true,
        quantity_receive: true,
        qty: true,
      },
    });

    // map เฉพาะตัวที่ in_process=false (ตัวที่ยัง “ต่อยอด qty” ได้)
    const openMap = new Map<string, (typeof existingLines)[number]>();
    for (const r of existingLines) {
      if (r.product_id == null) continue;
      if (r.in_process) continue; // ✅ ถ้า process จบแล้ว ห้าม merge
      openMap.set(
        goodsInMatchKey({
          product_id: r.product_id,
          lot_serial: r.lot_serial,
        }),
        r,
      );
    }

    // ใช้ sequence ต่อจากของเดิมเมื่อจำเป็นต้อง create ใหม่
    const maxSeq = existingLines.reduce(
      (m, x) => Math.max(m, Number(x.sequence ?? 0)),
      0,
    );
    let nextSeq = maxSeq + 1;

    for (let i = 0; i < hydratedItems.length; i++) {
      const item = hydratedItems[i];

      if (item.product_id == null) {
        throw badRequest(`Odoo item missing product_id (inbound: ${number})`);
      }
      if (!item.name || !item.unit) {
        throw badRequest(
          `Odoo item missing name/unit (inbound: ${number}, product_id: ${item.product_id})`,
        );
      }

      const lotSerial = item.lot_serial ?? null;
      const key = goodsInMatchKey({
        product_id: item.product_id,
        lot_serial: lotSerial,
      });

      const match = openMap.get(key);

      // ✅ CASE 1: match + in_process=false => update เพิ่ม qty
      if (match) {
        const add = Number(item.qty ?? 0);
        if (!Number.isFinite(add) || add <= 0) continue;

        await tx.goods_in.update({
          where: { id: match.id },
          data: {
            // ✅ เพิ่มทั้ง qty และ quantity_receive (คง quantity_count เดิมไว้)
            qty: { increment: add },
            quantity_receive: { increment: add },
            ...(item.barcode_text
              ? {
                  barcode_text: item.barcode_text,
                }
              : {}),
            updated_at: new Date(),
          } as any,
        });

        // update cache เผื่อมีซ้ำหลุดมา (แม้ mergeInboundItems จะกันแล้ว)
        (match as any).qty = Number(match.qty ?? 0) + add;
        (match as any).quantity_receive =
          Number(match.quantity_receive ?? 0) + add;

        continue;
      }

      // ✅ CASE 2: ไม่ match (หรือ match แต่ตัวเก่า in_process=true จะไม่อยู่ใน openMap) => create ใหม่
      const finalSeq = item.sequence ?? nextSeq++;
      await tx.goods_in.create({
        data: {
          inbound_id: inbound.id,
          sequence: finalSeq,
          odoo_sequence: finalSeq,
          odoo_line_key: `${number}-${finalSeq}`,

          product_id: item.product_id,
          code: item.code ?? undefined,
          name: item.name!,
          unit: item.unit!,
          tracking: item.tracking ?? undefined,

          // ✅ ยังเก็บ lot_id ได้ (ไม่ทำให้ flow อื่นพัง)
          lot_id: item.lot_id ?? undefined,

          // ✅ ใช้ lot_serial เป็น lot_name ด้วย
          lot_serial: item.lot_serial ?? undefined,
          lot: item.lot_serial ?? undefined,

          qty: item.qty,
          quantity_receive: item.qty,
          quantity_count: 0,

          barcode_text: item.barcode_text ?? undefined,
          exp: toExpDate(item.expire_date),

          updated_at: new Date(),
        },
      });
    }

    return inbound;
  });

  const fullInbound = await prisma.inbound.findUnique({
    where: { id: header.id },
    include: {
      goods_ins: {
        where: { deleted_at: null },
        orderBy: { sequence: "asc" },
      },
    },
  });

  return fullInbound;
}

function extractBorrowLockFromLocation(value: any): "BOR" | "BOS" | null {
  const s = String(value ?? "")
    .trim()
    .toUpperCase();

  const m = s.match(/^WH\/X?(BOR|BOS)(?:\/|$)/i);
  if (!m) return null;

  const code = String(m[1] ?? "").toUpperCase();
  return code === "BOR" || code === "BOS" ? code : null;
}

function isBorrowStoreTransferLike(input: {
  location?: any;
  location_dest?: any;
  location_dest_owner?: any;
}) {
  const srcLock = extractBorrowLockFromLocation(input.location);
  const destLock = extractBorrowLockFromLocation(input.location_dest);
  const owner = String(input.location_dest_owner ?? "").trim();

  return Boolean(srcLock && destLock && owner);
}

function normalizeNullableText(v: any): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function toNullableInt(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function swapItemKey(input: {
  product_id: number | null;
  lot_serial: string | null;
}) {
  return `p:${input.product_id ?? "null"}|lot:${normalizeLotText(input.lot_serial)}`;
}

async function upsertSwapLocationMasterFromOdoo(
  tx: Prisma.TransactionClient,
  input: {
    location_dest_id: any;
    location_dest: any;
    location_dest_owner: any;
    location_dest_owner_display?: any;
  },
) {
  const odooLocationId = toNullableInt(input.location_dest_id);
  if (!odooLocationId) {
    throw badRequest("BOR/BOS transfer ต้องมี location_dest_id");
  }

  const lockNo = extractBorrowLockFromLocation(input.location_dest);
  if (!lockNo) {
    throw badRequest(
      `location_dest ไม่ใช่ BOR/BOS ที่รองรับ: ${String(input.location_dest ?? "-")}`,
    );
  }

  const fullName = normalizeNullableText(input.location_dest_owner);
  if (!fullName) {
    throw badRequest("BOR/BOS transfer ต้องมี location_dest_owner");
  }

  const building = await tx.building.findFirst({
    where: { short_name: "BOR/BOS" as any },
    select: { id: true },
  });

  if (!building) {
    throw badRequest('ไม่พบ building ที่ short_name = "BOR/BOS"');
  }

  const zone = await tx.zone.findFirst({
    where: { short_name: "F01" as any },
    select: { id: true },
  });

  if (!zone) {
    throw badRequest('ไม่พบ zone ที่ short_name = "F01"');
  }

  const remarkParts = [
    "Auto upsert from Odoo BOR/BOS transfer",
    normalizeNullableText(input.location_dest),
    normalizeNullableText(input.location_dest_owner_display),
  ].filter(Boolean);

  const existing = await tx.location.findFirst({
    where: { odoo_id: odooLocationId },
    select: { id: true },
  });

  if (existing) {
    await tx.location.update({
      where: { id: existing.id },
      data: {
        full_name: fullName,
        building_id: building.id,
        zone_id: zone.id,
        lock_no: lockNo,
        location_code: normalizeNullableText(input.location_dest),
        status: "Activate",
        remark: remarkParts.join(" | "),
        ncr_check: false,
        deleted_at: null,
        updated_at: new Date(),
      },
    });

    return tx.location.findUnique({
      where: { id: existing.id },
      select: {
        id: true,
        odoo_id: true,
        full_name: true,
        lock_no: true,
        building_id: true,
        zone_id: true,
      },
    });
  }

  return tx.location.create({
    data: {
      odoo_id: odooLocationId,
      full_name: fullName,
      building_id: building.id,
      zone_id: zone.id,
      lock_no: lockNo,
      location_code: normalizeNullableText(input.location_dest),
      status: "ACTIVE",
      remark: remarkParts.join(" | "),
      ncr_check: false,
    },
    select: {
      id: true,
      odoo_id: true,
      full_name: true,
      lock_no: true,
      building_id: true,
      zone_id: true,
    },
  });
}

async function handleSwapTransfer(input: {
  picking_id: any;
  number: string;
  location_id: any;
  location: any;
  location_dest_id: any;
  location_dest: any;
  location_dest_owner: any;
  location_dest_owner_display?: any;
  department_id: any;
  department: any;
  reference: any;
  origin: any;
  mergedItems: NormalizedInboundItem[];
}) {
  const {
    picking_id,
    number,
    location_id,
    location,
    location_dest_id,
    location_dest,
    location_dest_owner,
    location_dest_owner_display,
    department_id,
    department,
    reference,
    origin,
    mergedItems,
  } = input;

  const convertedReference =
    typeof reference === "boolean"
      ? reference
        ? "true"
        : null
      : normalizeNullableText(reference);

  const convertedOrigin =
    typeof origin === "string" ? origin : origin ? String(origin) : null;

  const header = await prisma.$transaction(async (tx) => {
    const masterLocation = await upsertSwapLocationMasterFromOdoo(tx, {
      location_dest_id,
      location_dest,
      location_dest_owner,
      location_dest_owner_display,
    });

    let localDepartmentId: number | null = null;
    const deptOdooId = toNullableInt(department_id);

    if (deptOdooId) {
      const deptRow = await tx.department.findFirst({
        where: { odoo_id: deptOdooId as any },
        select: { id: true },
      });

      if (deptRow) {
        localDepartmentId = deptRow.id;
      }
    }

    const existingHeader = await tx.swap.findFirst({
      where: {
        no: number,
        deleted_at: null,
      },
      select: { id: true },
    });

    const headerData: any = {
      no: number,
      name: number,
      picking_id: toNullableInt(picking_id),
      odoo_location_id: toNullableInt(location_dest_id),
      source_location_id: toNullableInt(location_id),
      source_location: normalizeNullableText(location),
      location_id: masterLocation?.id ?? null,
      location_name:
        masterLocation?.full_name ?? String(location_dest_owner ?? "").trim(),
      department_id: localDepartmentId,
      reference: convertedReference,
      origin: convertedOrigin,
      status: "pending",
      remark:
        normalizeNullableText(location_dest_owner_display) ??
        "Auto upsert from Odoo",
      updated_at: new Date(),
      deleted_at: null,
    };

    const swapHeader = existingHeader
      ? await tx.swap.update({
          where: { id: existingHeader.id },
          data: headerData,
        })
      : await tx.swap.create({
          data: headerData,
        });

    const existingItems = await tx.swap_item.findMany({
      where: {
        swap_id: swapHeader.id,
        deleted_at: null,
      },
      select: {
        id: true,
        odoo_line_key: true,
        product_id: true,
        lot_serial: true,
      },
    });

    const existingByOdooLineKey = new Map<
      string,
      (typeof existingItems)[number]
    >();
    const existingByProductLot = new Map<
      string,
      (typeof existingItems)[number]
    >();

    for (const row of existingItems) {
      if (row.odoo_line_key) {
        existingByOdooLineKey.set(row.odoo_line_key, row);
      }

      existingByProductLot.set(
        swapItemKey({
          product_id: row.product_id ?? null,
          lot_serial: row.lot_serial ?? null,
        }),
        row,
      );
    }

    for (let i = 0; i < mergedItems.length; i++) {
      const item = mergedItems[i];

      if (item.product_id == null) {
        throw badRequest(`Odoo item missing product_id (swap: ${number})`);
      }

      const finalSeq = item.sequence ?? i + 1;
      const lineKey = `${number}-${finalSeq}`;
      const productLotKey = swapItemKey({
        product_id: item.product_id,
        lot_serial: item.lot_serial ?? null,
      });

      const existing =
        existingByOdooLineKey.get(lineKey) ??
        existingByProductLot.get(productLotKey);

      const itemData: any = {
        source_sequence: finalSeq,
        odoo_line_key: lineKey,
        product_id: item.product_id,
        code: item.code ?? "",
        name: item.name ?? null,
        unit: item.unit ?? null,
        tracking: item.tracking ?? null,
        lot_id: item.lot_id ?? null,
        lot_serial: item.lot_serial ?? "",
        barcode_text: item.barcode_text ?? null,
        expiration_date: toExpDate(item.expire_date),
        system_qty: Number(item.qty ?? 0),
        updated_at: new Date(),
        deleted_at: null,
      };

      if (existing?.id) {
        await tx.swap_item.update({
          where: { id: existing.id },
          data: itemData,
        });
      } else {
        await tx.swap_item.create({
          data: {
            swap_id: swapHeader.id,
            executed_qty: 0,
            ...itemData,
          },
        });
      }
    }

    return swapHeader;
  });

  return prisma.swap.findUnique({
    where: { id: header.id },
    include: {
      location: true,
      department: true,
      swapItems: {
        where: { deleted_at: null },
        orderBy: { source_sequence: "asc" },
      },
    },
  });
}

async function handleRTCReturnTransfer(input: {
  number: string;
  origin: any;
  mergedItems: NormalizedInboundItem[];
}) {
  const { number, origin, mergedItems } = input;

  const outboundNo = extractOutboundNoFromOrigin(origin);
  if (!outboundNo) {
    throw badRequest(
      `RTC ${number} ไม่สามารถหา outbound no จาก origin ได้: ${String(origin ?? "")}`,
    );
  }

  const outbound = await prisma.outbound.findFirst({
    where: {
      no: outboundNo,
      deleted_at: null,
    },
    select: {
      id: true,
      no: true,
      in_process: true,
      picking_id: true,
      location_id: true,
      location: true,
      location_dest_id: true,
      location_dest: true,
      department_id: true,
      department: true,
      reference: true,
      origin: true,
      invoice: true,
    },
  });

  if (!outbound) {
    throw badRequest(`RTC ${number} ไม่พบ outbound จาก origin: ${outboundNo}`);
  }

  /**
   * ==========================================
   * CASE 1: outbound.in_process === true
   * -> เอา RTC เข้า inbound/goods_in เพื่อทำ pick/receive ปกติ
   * ==========================================
   */
  if (Boolean(outbound.in_process)) {
    const inbound = await handleInboundTransfer({
      picking_id: outbound.picking_id ?? null,
      number,
      location_id: outbound.location_id ?? null,
      location: outbound.location ?? null,
      location_dest_id: outbound.location_dest_id ?? null,
      location_dest: outbound.location_dest ?? null,
      department_id: outbound.department_id ?? null,
      department: outbound.department ?? "",
      reference: `[RTC] ${outbound.no}`,
      origin,
      invoice: outbound.invoice ?? null,
      mergedItems,
    });

    const result = {
      source: "rtc",
      rtc_no: number,
      outbound_id: outbound.id,
      outbound_no: outbound.no,
      mode: "inbound_upsert",
      data: inbound,
    };

    try {
      io.to(`outbound:${result.outbound_no}`).emit(
        "outbound:rtc_adjusted",
        result,
      );
      io.to(`outbound-id:${result.outbound_id}`).emit(
        "outbound:rtc_adjusted",
        result,
      );
      io.emit("outbound:rtc_adjusted", result);
    } catch {}

    return result;
  }

  /**
   * ==========================================
   * CASE 2: outbound.in_process === false
   * -> เช็ค pick ก่อน
   *    - goods_out_item.pick
   *    - outbound_lot_adjustment_line.pick
   * -> ถ้ามี pick ที่ไหน > 0 => rtc_check_only
   * -> ถ้า pick ทั้งหมด = 0 => process เดิม
   * ==========================================
   */
  const result = await prisma.$transaction(async (tx) => {
    const dbItems = await tx.goods_out_item.findMany({
      where: {
        outbound_id: outbound.id,
        deleted_at: null,
      },
      select: {
        id: true,
        outbound_id: true,
        product_id: true,
        lot_id: true,
        lot_serial: true,
        qty: true,
        pick: true,
        pack: true,
        code: true,
        name: true,
        updated_at: true,
        rtc_check: true as any,
      },
    });

    const itemMap = new Map<string, (typeof dbItems)[number]>();
    for (const row of dbItems) {
      const key = `${row.product_id ?? "null"}__${row.lot_id ?? "null"}`;
      if (!itemMap.has(key)) {
        itemMap.set(key, row);
      }
    }

    const adjustmentLines =
      await getOutboundLotAdjustmentLinesByGoodsOutItemIds(
        tx,
        dbItems.map((x) => x.id),
      );

    const adjustmentByItemId = new Map<number, typeof adjustmentLines>();
    for (const row of adjustmentLines as any[]) {
      const itemId = Number(row.goods_out_item_id ?? 0);
      const arr = adjustmentByItemId.get(itemId) ?? [];
      arr.push(row);
      adjustmentByItemId.set(itemId, arr);
    }

    const affected: Array<{
      rtc_no: string;
      outbound_no: string;
      goods_out_item_id: number;
      adjustment_line_id?: number | null;
      product_id: number | null;
      lot_id: number | null;
      lot_serial: string | null;
      exp?: string | null;
      old_qty: number;
      rtc_qty: number;
      new_qty: number;
      action:
        | "decrement"
        | "soft_delete"
        | "skip_picked"
        | "rtc_check_only"
        | "adjustment_soft_delete";
    }> = [];

    const ignored: Array<{
      product_id: number | null;
      lot_id: number | null;
      lot_serial: string | null;
      qty: number;
      reason: string;
    }> = [];

    for (const item of mergedItems) {
      const product_id = item.product_id ?? null;
      const lot_id = item.lot_id ?? null;
      const rtcQty = Math.max(0, Math.floor(Number(item.qty ?? 0)));
      const rtcExp = toExpDate(item.expire_date ?? null) ?? null;

      if (product_id == null) {
        ignored.push({
          product_id: null,
          lot_id,
          lot_serial: item.lot_serial ?? null,
          qty: rtcQty,
          reason: "missing_product_id",
        });
        continue;
      }

      if (rtcQty <= 0) {
        ignored.push({
          product_id,
          lot_id,
          lot_serial: item.lot_serial ?? null,
          qty: rtcQty,
          reason: "invalid_qty",
        });
        continue;
      }

      const key = `${product_id}__${lot_id ?? "null"}`;
      const match = itemMap.get(key);

      if (!match) {
        ignored.push({
          product_id,
          lot_id,
          lot_serial: item.lot_serial ?? null,
          qty: rtcQty,
          reason: "goods_out_item_not_found",
        });
        continue;
      }

      const currentPick = Math.max(0, Math.floor(Number(match.pick ?? 0)));
      const currentQty = Math.max(0, Math.floor(Number(match.qty ?? 0)));

      // หา adjustment line ที่ตรงละเอียด
      const candidateAdjustmentLines = adjustmentByItemId.get(match.id) ?? [];

      // IMPORTANT:
      // outbound_lot_adjustment_line ไม่มี exp ใน schema
      // จึงต้อง match โดยไม่ใช้ exp เพื่อไม่ให้กระทบ flow เดิม
      const rtcAdjKey = rtcAdjustmentMatchKey({
        product_id,
        lot_id,
        lot_serial: item.lot_serial ?? null,
        exp: null,
      });

      const matchedAdjustmentLine =
        candidateAdjustmentLines.find((adj: any) => {
          const adjKey = rtcAdjustmentMatchKey({
            product_id: match.product_id ?? null,
            lot_id: adj.lot_id ?? null,
            lot_serial: adj.lot_serial ?? null,
            exp: null,
          });
          return adjKey === rtcAdjKey;
        }) ?? null;

      const adjustmentPick = Math.max(
        0,
        Math.floor(Number(matchedAdjustmentLine?.pick ?? 0)),
      );

      /**
       * ✅ NEW RULE
       * ถ้ามี pick ฝั่ง item หรือ adjustment line > 0
       * -> set rtc_check = true อย่างเดียว
       */
      if (currentPick > 0 || adjustmentPick > 0) {
        await tx.goods_out_item.update({
          where: { id: match.id },
          data: {
            rtc_check: true,
            updated_at: new Date(),
          } as any,
        });

        affected.push({
          rtc_no: number,
          outbound_no: outbound.no,
          goods_out_item_id: match.id,
          adjustment_line_id: matchedAdjustmentLine?.id ?? null,
          product_id: match.product_id ?? null,
          lot_id: match.lot_id ?? null,
          lot_serial: item.lot_serial ?? match.lot_serial ?? null,
          exp: rtcExp ? rtcExp.toISOString() : null,
          old_qty: currentQty,
          rtc_qty: rtcQty,
          new_qty: currentQty,
          action: "rtc_check_only",
        });

        continue;
      }

      /**
       * ✅ OLD RULE
       * pick == 0 ทั้ง item และ adjustment
       */
      const nextQty = currentQty - rtcQty;

      if (nextQty <= 0) {
        await tx.goods_out_item.update({
          where: { id: match.id },
          data: {
            deleted_at: new Date(),
            updated_at: new Date(),
          },
        });

        affected.push({
          rtc_no: number,
          outbound_no: outbound.no,
          goods_out_item_id: match.id,
          adjustment_line_id: null,
          product_id: match.product_id ?? null,
          lot_id: match.lot_id ?? null,
          lot_serial: match.lot_serial ?? null,
          exp: null,
          old_qty: currentQty,
          rtc_qty: rtcQty,
          new_qty: currentQty,
          action: "soft_delete",
        });

        // ถ้ามี matched adjustment line ของ item นี้และตรงชุดเดียวกัน -> soft delete ด้วย
        if (matchedAdjustmentLine?.id) {
          await tx.outbound_lot_adjustment_line.update({
            where: { id: matchedAdjustmentLine.id },
            data: {
              deleted_at: new Date(),
              updated_at: new Date(),
            } as any,
          });

          affected.push({
            rtc_no: number,
            outbound_no: outbound.no,
            goods_out_item_id: match.id,
            adjustment_line_id: matchedAdjustmentLine.id,
            product_id: match.product_id ?? null,
            lot_id: matchedAdjustmentLine.lot_id ?? null,
            lot_serial: matchedAdjustmentLine.lot_serial ?? null,
            exp: rtcExp ? rtcExp.toISOString() : null,
            old_qty: 0,
            rtc_qty: rtcQty,
            new_qty: 0,
            action: "adjustment_soft_delete",
          });
        }

        continue;
      }

      await tx.goods_out_item.update({
        where: { id: match.id },
        data: {
          qty: nextQty,
          updated_at: new Date(),
        },
      });

      affected.push({
        rtc_no: number,
        outbound_no: outbound.no,
        goods_out_item_id: match.id,
        adjustment_line_id: null,
        product_id: match.product_id ?? null,
        lot_id: match.lot_id ?? null,
        lot_serial: match.lot_serial ?? null,
        exp: null,
        old_qty: currentQty,
        rtc_qty: rtcQty,
        new_qty: nextQty,
        action: "decrement",
      });

      // ถ้ามี matched adjustment line และ pick=0 อยู่แล้ว -> soft delete ได้เช่นกัน
      if (matchedAdjustmentLine?.id) {
        await tx.outbound_lot_adjustment_line.update({
          where: { id: matchedAdjustmentLine.id },
          data: {
            deleted_at: new Date(),
            updated_at: new Date(),
          } as any,
        });

        affected.push({
          rtc_no: number,
          outbound_no: outbound.no,
          goods_out_item_id: match.id,
          adjustment_line_id: matchedAdjustmentLine.id,
          product_id: match.product_id ?? null,
          lot_id: matchedAdjustmentLine.lot_id ?? null,
          lot_serial: matchedAdjustmentLine.lot_serial ?? null,
          exp: rtcExp ? rtcExp.toISOString() : null,
          old_qty: 0,
          rtc_qty: rtcQty,
          new_qty: 0,
          action: "adjustment_soft_delete",
        });
      }
    }

    await tx.outbound.update({
      where: { id: outbound.id },
      data: {
        updated_at: new Date(),
      },
    });

    const remainingActiveItems = await tx.goods_out_item.count({
      where: {
        outbound_id: outbound.id,
        deleted_at: null,
      },
    });

    let outbound_action: "keep" | "soft_delete" = "keep";

    if (remainingActiveItems === 0) {
      await tx.outbound.update({
        where: { id: outbound.id },
        data: {
          deleted_at: new Date(),
          updated_at: new Date(),
        },
      });

      outbound_action = "soft_delete";
    }

    return {
      source: "rtc",
      rtc_no: number,
      outbound_id: outbound.id,
      outbound_no: outbound.no,
      mode: "outbound_adjust",
      affected,
      ignored,
      remaining_active_items: remainingActiveItems,
      outbound_action,
    };
  });

  try {
    io.to(`outbound:${result.outbound_no}`).emit(
      "outbound:rtc_adjusted",
      result,
    );
    io.to(`outbound-id:${result.outbound_id}`).emit(
      "outbound:rtc_adjusted",
      result,
    );
    io.emit("outbound:rtc_adjusted", result);
  } catch {}

  return result;
}

async function getOutboundLotAdjustmentLinesByGoodsOutItemIds(
  tx: Prisma.TransactionClient,
  goodsOutItemIds: number[],
) {
  if (!goodsOutItemIds.length) return [];

  return tx.outbound_lot_adjustment_line.findMany({
    where: {
      goods_out_item_id: { in: goodsOutItemIds },
      deleted_at: null,
    },
    select: {
      id: true,
      adjustment_id: true,
      goods_out_item_id: true,
      lot_id: true,
      lot_serial: true,
      qty: true,
      pick: true,
      is_original_lot: true,
      deleted_at: true,
      adjustment: {
        select: {
          id: true,
          outbound_id: true,
          goods_out_item_id: true,
          original_lot_id: true,
          original_lot_serial: true,
          original_qty: true,
          status: true,
        },
      },
    },
    orderBy: [{ id: "asc" }],
  });
}

// PD auto-process
function isPDNumber(no: string | null | undefined): boolean {
  const s = String(no ?? "")
    .trim()
    .toUpperCase();

  return s.startsWith("PD") || s.includes("/PD");
}

async function handlePDAutoProcess(input: {
  picking_id: any;
  number: string;
  location_id: any;
  location: any;
  location_dest_id: any;
  location_dest: any;
  department_id: any;
  department: any;
  reference: any;
  origin: any;
  invoice: any;
  mergedItems: NormalizedInboundItem[];
}) {
  const {
    picking_id,
    number,
    location_id,
    location,
    location_dest_id,
    location_dest,
    department_id,
    department,
    reference,
    origin,
    invoice,
    mergedItems,
  } = input;

  const pdOrigin = String(origin ?? "").trim();

  if (!pdOrigin) {
    throw badRequest(
      `PD ${number} ไม่พบ origin สำหรับใช้เทียบกับ outbound.origin`,
    );
  }

  const outbound = await prisma.outbound.findFirst({
    where: {
      deleted_at: null,
      origin: {
        equals: pdOrigin,
        mode: "insensitive",
      },
    },
    select: {
      id: true,
      no: true,
      origin: true,
    },
  });

  if (!outbound) {
    throw badRequest(`PD ${number} ไม่พบ outbound จาก origin: ${pdOrigin}`);
  }

  const inbound = await handleInboundTransfer({
    picking_id,
    number,
    location_id,
    location,
    location_dest_id,
    location_dest,
    department_id,
    department,
    reference: reference || `[PD] ${outbound.no}`,
    origin,
    invoice,
    mergedItems,
  });

  if (!inbound || inbound.id == null) {
    throw badRequest(`PD ${number} สร้าง inbound ไม่สำเร็จ`);
  }

  const inboundId = Number(inbound.id);
  const inboundNo = String((inbound as any).no ?? number);

  const result = await prisma.$transaction(async (tx) => {
    await tx.inbound.update({
      where: { id: inboundId },
      data: {
        status: "completed",
        updated_at: new Date(),
      } as any,
    });

    await tx.goods_in.updateMany({
      where: {
        inbound_id: inboundId,
        deleted_at: null,
      },
      data: {
        quantity_count: 0,
        updated_at: new Date(),
      } as any,
    });

    const dbItems = await tx.goods_out_item.findMany({
      where: {
        outbound_id: outbound.id,
        deleted_at: null,
      },
      select: {
        id: true,
        product_id: true,
        lot_id: true,
        lot_serial: true,
        qty: true,
        pick: true,
        pack: true,
      },
    });

    const itemMap = new Map<string, (typeof dbItems)[number]>();

    for (const row of dbItems) {
      const key = `${row.product_id ?? "null"}__${row.lot_id ?? "null"}`;
      if (!itemMap.has(key)) itemMap.set(key, row);
    }

    const affected: any[] = [];
    const ignored: any[] = [];

    for (const item of mergedItems) {
      const product_id = item.product_id ?? null;
      const lot_id = item.lot_id ?? null;
      const pdQty = Math.max(0, Math.floor(Number(item.qty ?? 0)));

      if (product_id == null || pdQty <= 0) {
        ignored.push({
          product_id,
          lot_id,
          lot_serial: item.lot_serial ?? null,
          qty: pdQty,
          reason: product_id == null ? "missing_product_id" : "invalid_qty",
        });
        continue;
      }

      const key = `${product_id}__${lot_id ?? "null"}`;
      const match = itemMap.get(key);

      if (!match) {
        ignored.push({
          product_id,
          lot_id,
          lot_serial: item.lot_serial ?? null,
          qty: pdQty,
          reason: "goods_out_item_not_found",
        });
        continue;
      }

      const currentQty = Math.max(0, Math.floor(Number(match.qty ?? 0)));
      const currentPick = Math.max(0, Math.floor(Number(match.pick ?? 0)));

      if (currentPick > 0) {
        await tx.goods_out_item.update({
          where: { id: match.id },
          data: {
            rtc_check: true,
            updated_at: new Date(),
          } as any,
        });

        affected.push({
          pd_no: number,
          outbound_no: outbound.no,
          goods_out_item_id: match.id,
          product_id,
          lot_id,
          lot_serial: match.lot_serial ?? item.lot_serial ?? null,
          old_qty: currentQty,
          pd_qty: pdQty,
          new_qty: currentQty,
          action: "rtc_check_only",
        });

        continue;
      }

      const nextQty = currentQty - pdQty;

      if (nextQty <= 0) {
        await tx.goods_out_item.update({
          where: { id: match.id },
          data: {
            deleted_at: new Date(),
            updated_at: new Date(),
          },
        });

        affected.push({
          pd_no: number,
          outbound_no: outbound.no,
          goods_out_item_id: match.id,
          product_id,
          lot_id,
          lot_serial: match.lot_serial ?? item.lot_serial ?? null,
          old_qty: currentQty,
          pd_qty: pdQty,
          new_qty: 0,
          action: "soft_delete",
        });

        continue;
      }

      await tx.goods_out_item.update({
        where: { id: match.id },
        data: {
          qty: nextQty,
          updated_at: new Date(),
        },
      });

      affected.push({
        pd_no: number,
        outbound_no: outbound.no,
        goods_out_item_id: match.id,
        product_id,
        lot_id,
        lot_serial: match.lot_serial ?? item.lot_serial ?? null,
        old_qty: currentQty,
        pd_qty: pdQty,
        new_qty: nextQty,
        action: "decrement",
      });
    }

    const remainingActiveItems = await tx.goods_out_item.count({
      where: {
        outbound_id: outbound.id,
        deleted_at: null,
      },
    });

    let outbound_action: "keep" | "soft_delete" = "keep";

    if (remainingActiveItems === 0) {
      await tx.outbound.update({
        where: { id: outbound.id },
        data: {
          deleted_at: new Date(),
          updated_at: new Date(),
        },
      });

      outbound_action = "soft_delete";
    } else {
      await tx.outbound.update({
        where: { id: outbound.id },
        data: {
          updated_at: new Date(),
        },
      });
    }

    return {
      source: "pd",
      pd_no: number,
      outbound_id: outbound.id,
      outbound_no: outbound.no,
      outbound_origin: outbound.origin,
      inbound_id: inboundId,
      inbound_no: inboundNo,
      mode: "auto_process",
      status: "completed",
      matched_by_origin: pdOrigin,
      affected,
      ignored,
      remaining_active_items: remainingActiveItems,
      outbound_action,
      data: inbound,
    };
  });

  try {
    io.to(`outbound:${result.outbound_no}`).emit(
      "outbound:pd_adjusted",
      result,
    );
    io.to(`outbound-id:${result.outbound_id}`).emit(
      "outbound:pd_adjusted",
      result,
    );
    io.emit("outbound:pd_adjusted", result);
    io.emit("inbound:updated", result);
  } catch {}

  return result;
}

/**
 * ==============
 * 1) Receive from Odoo (NEW barcode_text policy)
 * ==============
 */
export const receiveFromOdoo = asyncHandler(
  async (
    req: Request<{}, {}, OdooInboundRequest | OdooInboundRequestParams>,
    res: Response,
  ) => {
    let logId: number | null = null;

    const getErrorStatus = (err: unknown) => {
      const anyErr = err as any;
      return anyErr?.statusCode ?? anyErr?.status ?? anyErr?.httpStatus ?? 500;
    };

    try {
      const requestLog = await prisma.odoo_request_log.create({
        data: {
          endpoint: "/api/Inbound",
          method: "POST",
          request_body: JSON.stringify(req.body),
          ip_address: req.ip || req.socket.remoteAddress || null,
          user_agent: req.headers["user-agent"] || null,
        },
      });

      logId = requestLog.id;

      const transfers =
        "params" in req.body && (req.body as any).params
          ? (req.body as any).params.transfers
          : "transfers" in req.body
            ? (req.body as any).transfers
            : null;

      if (!transfers) throw badRequest("ไม่พบข้อมูล 'transfers'");
      if (!Array.isArray(transfers)) {
        throw badRequest("'transfers' ต้องเป็น Array");
      }
      if (transfers.length === 0) {
        throw badRequest("'transfers' ต้องมีข้อมูลอย่างน้อย 1 รายการ");
      }

      const results: any[] = [];

      for (const transfer of transfers) {
        const picking_id = (transfer as any).picking_id;

        const number = String(
          (transfer as any).number ?? (transfer as any).no ?? "",
        ).trim();

        const location_id = (transfer as any).location_id;
        const location = (transfer as any).location;
        const location_dest_id = (transfer as any).location_dest_id;
        const location_dest = (transfer as any).location_dest;

        const location_dest_owner = (transfer as any).location_dest_owner;
        const location_dest_owner_display = (transfer as any)
          .location_dest_owner_display;

        const department_id = (transfer as any).department_id;
        const department = (transfer as any).department;
        const reference = (transfer as any).reference;
        const origin = (transfer as any).origin;
        const invoice = (transfer as any).invoice;
        const items = (transfer as any).items;

        if (!number) throw badRequest("ไม่พบเลข number/no ใน transfer");

        if (!items || !Array.isArray(items) || items.length === 0) {
          throw badRequest(`Transfer ${number} ไม่มี items`);
        }

        const mergedItems = mergeInboundItems(items);

        // ✅ BOR/BOS internal transfer -> swap / swap_item
        if (
          isBorrowStoreTransferLike({
            location,
            location_dest,
            location_dest_owner,
          })
        ) {
          const swap = await handleSwapTransfer({
            picking_id,
            number,
            location_id,
            location,
            location_dest_id,
            location_dest,
            location_dest_owner,
            location_dest_owner_display,
            department_id,
            department,
            reference,
            origin,
            mergedItems,
          });

          results.push(swap);
          continue;
        }

        // ✅ PD -> auto-process เหมือน RTC case ลด outbound
        if (isPDNumber(number)) {
          const pd = await handlePDAutoProcess({
            picking_id,
            number,
            location_id,
            location,
            location_dest_id,
            location_dest,
            department_id,
            department,
            reference,
            origin,
            invoice,
            mergedItems,
          });

          results.push(pd);
          continue;
        }

        // ✅ RTC -> logic เดิม
        if (isRTCNumber(number)) {
          const rtc = await handleRTCReturnTransfer({
            number,
            origin,
            mergedItems,
          });

          results.push(rtc);
          continue;
        }

        // ✅ TF -> transfer_doc / transfer_doc_item
        if (isTFNumber(number)) {
          const doc = await handleTFTransfer({
            picking_id,
            number,
            location_id,
            location,
            location_dest_id,
            location_dest,
            department_id,
            department,
            reference,
            origin,
            mergedItems,
          });

          results.push(doc);
          continue;
        }

        // ✅ BOR และ non-TF อื่น ๆ -> inbound / goods_in ปกติ
        const inbound = await handleInboundTransfer({
          picking_id,
          number,
          location_id,
          location,
          location_dest_id,
          location_dest,
          department_id,
          department,
          reference,
          origin,
          invoice,
          mergedItems,
        });

        results.push(inbound);
      }

      const responseBody = {
        success: true,
        message: `รับข้อมูลจาก Odoo สำเร็จ ${results.length} รายการ`,
        total_received: transfers.length,
        total_processed: results.length,
        data: results,
      };

      if (logId) {
        await prisma.odoo_request_log.update({
          where: { id: logId },
          data: {
            response_status: 200,
            response_body: JSON.stringify(responseBody),
            error_message: null,
          },
        });
      }

      return res.status(200).json(responseBody);
    } catch (err) {
      const status = getErrorStatus(err);
      const message =
        err instanceof Error
          ? err.message
          : "เกิดข้อผิดพลาดในการรับข้อมูลจาก Odoo";

      if (logId) {
        await prisma.odoo_request_log.update({
          where: { id: logId },
          data: {
            response_status: status,
            response_body: null,
            error_message: message,
          },
        });
      }

      throw err;
    }
  },
);

/**
 * ==============
 * 2) GET list (all inbounds)
 * ==============
 */
export const getOdooInbounds = asyncHandler(
  async (req: Request, res: Response) => {
    const inbounds = await prisma.inbound.findMany({
      where: {
        deleted_at: null,
        picking_id: { not: null },
      },
      include: {
        goods_ins: {
          where: {
            deleted_at: null,
            inbound_id: { not: null },
          },
          orderBy: { sequence: "asc" },
        },
      },
      orderBy: { created_at: "desc" },
    });

    // Lookup department short_name
    const departmentIds = [
      ...new Set(
        inbounds
          .map((ib) => ib.department_id)
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

    // ✅ barcode lookup by barcode_text
    const allGoods = inbounds.flatMap((ib) => ib.goods_ins || []);
    const { map: barcodeMap } = await attachBarcodeByText(allGoods as any);

    const formattedData = inbounds.map((inbound) => {
      const formatted = formatOdooInbound(inbound as any);
      const deptId = inbound.department_id
        ? parseInt(inbound.department_id, 10)
        : NaN;
      const shortName = !isNaN(deptId) ? deptMap.get(deptId) : undefined;

      return {
        ...formatted,
        invoice: (inbound as any).invoice ?? null,
        department: shortName ?? formatted.department,
        items: (inbound.goods_ins || []).map((gi) => {
          const t = (gi.barcode_text ?? "").trim();
          const b = t ? barcodeMap.get(t) : null;

          return {
            id: gi.id,
            inbound_id: gi.inbound_id,
            sequence: gi.sequence,
            product_id: gi.product_id,
            code: gi.code,
            name: gi.name,
            unit: gi.unit,
            tracking: gi.tracking,
            lot_id: gi.lot_id, // ✅ ยังคงส่ง
            lot_serial: gi.lot_serial,
            qty: gi.qty,
            quantity_receive: gi.quantity_receive,
            quantity_count: gi.quantity_count,
            lot: gi.lot,
            exp: gi.exp,
            print_check: Boolean(gi.print_check),

            barcode_text: gi.barcode_text ?? null,
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

            created_at: gi.created_at,
            updated_at: gi.updated_at,
          };
        }),
      };
    });

    return res.json({
      total: formattedData.length,
      data: formattedData,
    });
  },
);

/**
 * ==============
 * 3) GET by no (full)
 * ==============
 */
export const getOdooInboundByNo = asyncHandler(
  async (req: Request<{ no: string }>, res: Response) => {
    const rawNo = Array.isArray(req.params.no)
      ? req.params.no[0]
      : req.params.no;
    if (!rawNo) throw badRequest("กรุณาระบุเลข no");
    const no = decodeURIComponent(rawNo);

    const inbound = await prisma.inbound.findUnique({
      where: { no },
      include: {
        goods_ins: {
          where: { deleted_at: null },
          orderBy: { sequence: "asc" },
          include: {
            goods_in_location_confirms: {
              include: {
                location: {
                  select: {
                    id: true,
                    full_name: true,
                    lock_no: true,
                    ncr_check: true,
                  },
                },
              },
              orderBy: [{ updated_at: "desc" }, { id: "desc" }],
            },
          },
        },
      },
    });

    if (!inbound) throw notFound(`ไม่พบ Inbound no: ${no}`);
    if (inbound.deleted_at) throw badRequest("Inbound นี้ถูกลบไปแล้ว");

    let departmentShortName: string | undefined;
    if (inbound.department_id) {
      const deptId = parseInt(inbound.department_id, 10);
      if (!isNaN(deptId)) {
        const dept = await prisma.department.findFirst({
          where: { odoo_id: deptId },
          select: { short_name: true },
        });
        departmentShortName = dept?.short_name;
      }
    }

    const goodsList =
      inbound.goods_ins
        ?.filter((gi) => gi.product_id != null)
        .map((gi) => ({
          product_id: gi.product_id!,
          lot_id: gi.lot_id ?? null,
          lot_text: resolveLotText({
            lot_serial: gi.lot_serial,
            lot: gi.lot,
          }),
        })) || [];

    const inputNumberMap = await buildInputNumberMapByLotText(goodsList);

    const zoneTypeMap = await buildZoneTypeMapByProductId(
      (inbound.goods_ins || []).map((gi) => ({
        product_id: gi.product_id,
      })),
    );

    const { map: barcodeMap } = await attachBarcodeByText(
      inbound.goods_ins as any,
    );

    const formattedInbound = formatOdooInbound(inbound as any);

    return res.json({
      ...formattedInbound,
      invoice: (inbound as any).invoice ?? null,
      department: departmentShortName ?? formattedInbound.department,
      items: (inbound.goods_ins || []).map((gi: any) => {
        const input_number = resolveInputNumber(
          inputNumberMap,
          gi.product_id,
          gi.lot_serial,
          gi.lot,
          gi.lot_id ?? null,
        );

        const zone_type =
          gi.product_id != null
            ? (zoneTypeMap.get(gi.product_id) ?? null)
            : null;

        const t = (gi.barcode_text ?? "").trim();
        const b = t ? barcodeMap.get(t) : null;

        const receive_locations = (gi.goods_in_location_confirms || []).map(
          (cf: any) => ({
            id: cf.id,
            location_id: cf.location_id,
            confirmed_qty: cf.confirmed_qty ?? 0,
            created_at: cf.created_at,
            updated_at: cf.updated_at,
            location: cf.location
              ? {
                  id: cf.location.id,
                  full_name: cf.location.full_name,
                  lock_no: cf.location.lock_no ?? null,
                  ncr_check: Boolean(cf.location.ncr_check),
                }
              : null,
            location_name: cf.location?.full_name ?? null,
          }),
        );

        return {
          id: gi.id,
          inbound_id: gi.inbound_id,
          sequence: gi.sequence,
          product_id: gi.product_id,
          code: gi.code,
          name: gi.name,
          unit: gi.unit,
          tracking: gi.tracking,
          lot_id: gi.lot_id,
          lot_serial: gi.lot_serial,

          zone_type,
          user_ref: gi.user_ref ?? null,

          qty: gi.qty,
          quantity_receive: gi.quantity_receive,
          quantity_count: gi.quantity_count,
          lot: gi.lot,
          exp: gi.exp,

          receive_locations,
          location_confirms: receive_locations,

          odoo_line_key: gi.odoo_line_key,
          odoo_sequence: gi.odoo_sequence,
          input_number,
          print_check: Boolean(gi.print_check),

          barcode_text: gi.barcode_text ?? null,
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

          created_at: gi.created_at,
          updated_at: gi.updated_at,
        };
      }),
    });
  },
);

/**
 * ==============
 * 4) GET by no (Paginated)
 * ==============
 */
export const getOdooInboundByNoPaginated = asyncHandler(
  async (req: Request<{ no: string }>, res: Response) => {
    const rawNo = Array.isArray(req.params.no)
      ? req.params.no[0]
      : req.params.no;
    if (!rawNo) throw badRequest("กรุณาระบุเลข no");
    const no = decodeURIComponent(rawNo);

    // Pagination
    const page = Number(req.query.page) || 1;
    const limit =
      req.query.limit !== undefined ? Number(req.query.limit) || 10 : 10;
    if (isNaN(page) || page < 1)
      throw badRequest("page ต้องเป็นตัวเลขบวกที่มีค่ามากกว่า 0");
    const skip = (page - 1) * limit;

    // Search
    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

    // Inbound header
    const inbound = await prisma.inbound.findUnique({ where: { no } });
    if (!inbound) throw notFound(`ไม่พบ Inbound no: ${no}`);
    if (inbound.deleted_at) throw badRequest("Inbound นี้ถูกลบไปแล้ว");

    // Department short_name
    let departmentShortName: string | undefined;
    if (inbound.department_id) {
      const deptId = parseInt(inbound.department_id, 10);
      if (!isNaN(deptId)) {
        const dept = await prisma.department.findFirst({
          where: { odoo_id: deptId },
          select: { short_name: true },
        });
        departmentShortName = dept?.short_name;
      }
    }

    // WHERE goods_ins
    const baseWhere: Prisma.goods_inWhereInput = {
      inbound_id: inbound.id,
      deleted_at: null,
    };

    let where: Prisma.goods_inWhereInput = baseWhere;

    if (search) {
      const searchCondition: Prisma.goods_inWhereInput = {
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

    // Query items + count
    const [items, total] = await Promise.all([
      prisma.goods_in.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: "asc" },
      }),
      prisma.goods_in.count({ where }),
    ]);

    // ✅ goodsList สำหรับ map: product_id + lot_serial(lot_name) (ไม่เช็ค lot_id)
    const goodsList = items
      .filter((gi) => gi.product_id != null)
      .map((gi) => ({
        product_id: gi.product_id!,
        lot_id: gi.lot_id ?? null, // ✅ ใช้ query ได้ แต่ไม่ใช้เป็น key เช็ค
        lot_text: resolveLotText({ lot_serial: gi.lot_serial, lot: gi.lot }),
      }));

    const inputNumberMap = await buildInputNumberMapByLotText(goodsList);
    const zoneTypeMap = await buildZoneTypeMapByLotText(goodsList);

    // ✅ barcode lookup by barcode_text
    const { map: barcodeMap } = await attachBarcodeByText(items as any);

    return res.json({
      inbound: {
        id: inbound.id,
        picking_id: inbound.picking_id,
        no: inbound.no,
        lot: inbound.lot,
        location_id: inbound.location_id,
        location: inbound.location,
        location_dest_id: inbound.location_dest_id,
        location_dest: inbound.location_dest,
        department_id: inbound.department_id,
        department: departmentShortName ?? inbound.department,
        reference: inbound.reference,
        origin: inbound.origin,
        invoice: inbound.invoice ?? null,
        date: inbound.date,
        in_type: inbound.in_type,
        created_at: inbound.created_at,
        updated_at: inbound.updated_at,
      },
      data: items.map((gi) => {
        const input_number = resolveInputNumber(
          inputNumberMap,
          gi.product_id,
          gi.lot_serial,
          gi.lot,
          gi.lot_id ?? null,
        );

        const zone_type = resolveZoneType(
          zoneTypeMap,
          gi.product_id,
          gi.lot_serial,
          gi.lot,
          gi.lot_id ?? null,
        );

        const t = (gi.barcode_text ?? "").trim();
        const b = t ? barcodeMap.get(t) : null;

        return {
          id: gi.id,
          inbound_id: gi.inbound_id,
          sequence: gi.sequence,
          product_id: gi.product_id,
          code: gi.code,
          name: gi.name,
          unit: gi.unit,
          tracking: gi.tracking,
          lot_id: gi.lot_id, // ✅ ยังส่ง
          lot_serial: gi.lot_serial,

          zone_type,
          user_ref: (gi as any).user_ref ?? null,

          qty: gi.qty,
          quantity_receive: gi.quantity_receive,
          quantity_count: gi.quantity_count,
          lot: gi.lot,
          exp: gi.exp,

          odoo_line_key: gi.odoo_line_key,
          odoo_sequence: gi.odoo_sequence,
          input_number,
          print_check: Boolean(gi.print_check),

          barcode_text: gi.barcode_text ?? null,
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

          created_at: gi.created_at,
          updated_at: gi.updated_at,
        };
      }),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  },
);

export const updateOdooInbound = asyncHandler(
  async (req: Request<{ no: string }>, res: Response) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;
    const data = req.body;

    if (!no) throw badRequest("กรุณาระบุเลข no");

    const existing = await prisma.inbound.findUnique({
      where: { no },
      select: { id: true, deleted_at: true },
    });
    if (!existing) throw notFound(`ไม่พบ Inbound no: ${no}`);
    if (existing.deleted_at)
      throw badRequest("ไม่สามารถแก้ไข Inbound ที่ถูกลบแล้ว");

    // ✅ payload จริงส่งมา { lot: "..." }
    const lotText =
      data.lot !== undefined
        ? data.lot === null
          ? null
          : String(data.lot).trim() || null
        : undefined;

    const invoiceText =
      data.invoice !== undefined
        ? data.invoice === null
          ? null
          : String(data.invoice).trim() || null
        : undefined;

    const result = await prisma.$transaction(async (tx) => {
      // 1) update inbound header (ของเดิม)
      const inboundHeader = await tx.inbound.update({
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
          invoice: invoiceText !== undefined ? invoiceText : undefined,
          updated_at: new Date(),

          // ถ้ามี lot ที่ header ก็อัปเดตไปด้วย
          lot: lotText !== undefined ? lotText : undefined,
        },
        select: { id: true },
      });

      // 2) ✅ update goods_ins: lot + lot_serial
      let updatedGoodsIns = 0;

      if (lotText !== undefined) {
        const r = await tx.goods_in.updateMany({
          where: {
            inbound_id: inboundHeader.id,
            deleted_at: null,
          },
          data: {
            lot: lotText,
            lot_serial: lotText,
            updated_at: new Date(),
          },
        });
        updatedGoodsIns = r.count;
      }

      // 3) return full inbound
      const full = await tx.inbound.findUniqueOrThrow({
        where: { no },
        include: {
          goods_ins: {
            where: { deleted_at: null },
            orderBy: { sequence: "asc" },
          },
        },
      });

      return { full, updatedGoodsIns, lotText };
    });

    return res.json({
      message: "อัพเดท Inbound สำเร็จ",
      debug: {
        lotText: result.lotText,
        updatedGoodsIns: result.updatedGoodsIns,
      },
      data: formatOdooInbound(result.full),
    });
  },
);

export const deleteOdooInbound = asyncHandler(
  async (req: Request<{ no: string }>, res: Response) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;

    if (!no) throw badRequest("กรุณาระบุเลข no");

    const existing = await prisma.inbound.findUnique({
      where: { no },
      include: { goods_ins: true },
    });

    if (!existing) throw notFound(`ไม่พบ Inbound no: ${no}`);
    if (existing.deleted_at) throw badRequest("Inbound นี้ถูกลบไปแล้ว");

    await prisma.inbound.update({
      where: { no },
      data: {
        deleted_at: new Date(),
        updated_at: new Date(),
      },
    });

    if (existing.goods_ins.length > 0) {
      await prisma.goods_in.updateMany({
        where: {
          inbound_id: existing.id,
          deleted_at: null,
        },
        data: {
          deleted_at: new Date(),
          updated_at: new Date(),
        },
      });
    }

    return res.json({
      message: `ลบ Inbound ${no} และ ${existing.goods_ins.length} items สำเร็จ`,
    });
  },
);
