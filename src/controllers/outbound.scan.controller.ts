import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";
import { io } from "../index";

import {
  handleScanLocationCommon,
  resolveLocationByFullNameBasic,
} from "../utils/helper_scan/location";

import {
  normalizeScanText,
  normalizeBarcodeBaseForMatch,
  sameExpDateOnly,
  parseScannedBarcodeByBaseBarcode,
  parseScannedBarcodeByMasterMeta,
  findMasterBarcodeForScan,
  isNullLikeLot,
  isNullLikeExp,
} from "../utils/helper_scan/barcode";

import { sendQueuedOutboundLotAdjustmentsToOdoo } from "../utils/helper_scan/change_lot";

/**
 * =========================
 * Helpers
 * =========================
 */

function emitOutboundRealtime(
  no: string,
  event: string,
  payload: any,
  outboundId?: number | null,
) {
  try {
    const outboundNo = String(no ?? "").trim();
    if (outboundNo) {
      io.to(`outbound:${outboundNo}`).emit(event, payload);
    }

    const oid = Number(outboundId ?? NaN);
    if (Number.isFinite(oid) && oid > 0) {
      io.to(`outbound-id:${oid}`).emit(event, payload);
    }

    io.emit(event, payload);
  } catch {}
}

async function findStockExpByProductLot(
  product_id: number,
  lot_id: number | null,
) {
  const rows = await prisma.stock.findMany({
    where: {
      source: "wms",
      product_id,
      lot_id,
    },
    select: {
      id: true,
      expiration_date: true,
      updated_at: true,
      created_at: true,
    },
    orderBy: [{ updated_at: "desc" }, { created_at: "desc" }, { id: "desc" }],
  });

  return rows[0]?.expiration_date ?? null;
}

function lotMatchedNullable(
  itemLot: string | null | undefined,
  scannedLot: string | null | undefined,
) {
  const itemNull = isNullLikeLot(itemLot);
  const scanNull = isNullLikeLot(scannedLot);

  if (itemNull && scanNull) return true;
  if (itemNull !== scanNull) return false;

  return (
    normalizeScanText(itemLot ?? "") === normalizeScanText(scannedLot ?? "")
  );
}

function expMatchedNullable(
  stockExp: Date | string | null | undefined,
  scannedExp: Date | string | null | undefined,
  scannedExpText?: string | null,
) {
  const stockNull = !stockExp;
  const scanNull = !scannedExp || isNullLikeExp(scannedExpText);

  // กรณี stock ไม่มี exp และ scan ไม่มี exp (หรือ 999999) => match
  if (stockNull && scanNull) return true;

  // ถ้า stock มี exp แต่ scan exp เป็น null/999999 => ไม่ match
  if (!stockNull && scanNull) return false;

  // ถ้า stock ไม่มี exp แต่ scan มี exp จริง => ไม่ match
  if (stockNull && !scanNull) return false;

  // ทั้งคู่มี exp จริง เปรียบเทียบวันหมดอายุ
  return sameExpDateOnly(stockExp, scannedExp);
}
/**
 * หา goods_out_item candidate จาก barcode prefix ที่ยาวที่สุด
 * เช่น scan = DI111111M111111301231
 * goods_out_item.barcode_text = DI111111
 */

const goodsOutCandidateSelect = {
  id: true,
  outbound_id: true,
  product_id: true,
  lot_id: true,
  lot_serial: true,
  qty: true,
  pick: true,
  code: true,
  name: true,
  unit: true,
  barcode_text: true,
  sequence: true,
  confirmed_pick: true as any,
  in_process: true as any,
  created_at: true,
  updated_at: true,
};

async function findCandidateGoodsOutItemsByBarcodeBase(
  outboundId: number,
  barcodeBase: string,
) {
  const normalizedBase = normalizeBarcodeBaseForMatch(barcodeBase);
  if (!normalizedBase) return [];

  const rows = await prisma.goods_out_item.findMany({
    where: {
      outbound_id: outboundId,
      deleted_at: null,
      barcode_text: { not: null },
    },
    select: goodsOutCandidateSelect,
    orderBy: [{ sequence: "asc" }, { id: "asc" }],
  });

  const matched = rows.filter((x) => {
    const itemBase = normalizeBarcodeBaseForMatch(x.barcode_text ?? "");
    if (!itemBase) return false;

    return (
      normalizedBase === itemBase ||
      normalizedBase.startsWith(itemBase) ||
      itemBase.startsWith(normalizedBase)
    );
  });

  matched.sort((a, b) => {
    const al = normalizeBarcodeBaseForMatch(a.barcode_text ?? "").length;
    const bl = normalizeBarcodeBaseForMatch(b.barcode_text ?? "").length;
    return bl - al;
  });

  return matched;
}

async function findGoodsInExpByProductAndLot(
  product_id: number,
  lot_id: number | null,
) {
  if (!product_id || lot_id == null) return null;

  const row = await prisma.goods_in.findFirst({
    where: {
      product_id,
      lot_id,
      deleted_at: null,
    } as any,
    select: {
      exp: true,
      updated_at: true,
      created_at: true,
      id: true,
    },
    orderBy: [{ updated_at: "desc" }, { created_at: "desc" }, { id: "desc" }],
  });

  return row?.exp ?? null;
}

/**
 * ==============================
 * Expiration map helpers (stock.lot_name)
 * ==============================
 */

function normalizeLot(v: unknown) {
  return String(v ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

type ExpKey = string;
const expKeyOf = (
  product_id: number | null,
  lot_serial: string | null,
): ExpKey => `p:${product_id ?? 0}|lot:${normalizeLot(lot_serial)}`;

async function buildExpirationDateMapForGoodsOutItems(
  items: Array<{ product_id: number | null; lot_serial: string | null }>,
) {
  const map = new Map<ExpKey, Date | null>();

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
    if (!lotNorm || !lotNorms.includes(lotNorm)) continue;

    const k = `p:${pid ?? 0}|lot:${lotNorm}`;
    if (!map.has(k)) {
      map.set(k, (r.expiration_date ?? null) as Date | null);
    }
  }

  return map;
}

/**
 * ==============================
 * upsert goods_out_item_location_pick
 * ==============================
 */
async function upsertGoodsOutItemLocationPick(
  tx: Prisma.TransactionClient,
  input: {
    goods_out_item_id: number;
    location_id: number;
    qty_pick_delta: number;
  },
) {
  const delta = Math.max(0, Math.floor(Number(input.qty_pick_delta ?? 0)));
  if (delta <= 0) return;

  const existed = await tx.goods_out_item_location_pick.findFirst({
    where: {
      goods_out_item_id: input.goods_out_item_id,
      location_id: input.location_id,
    },
    select: {
      id: true,
      qty_pick: true,
    },
  });

  if (existed) {
    await tx.goods_out_item_location_pick.update({
      where: { id: existed.id },
      data: {
        qty_pick: Number(existed.qty_pick ?? 0) + delta,
        updated_at: new Date(),
      },
    });
  } else {
    await tx.goods_out_item_location_pick.create({
      data: {
        goods_out_item_id: input.goods_out_item_id,
        location_id: input.location_id,
        qty_pick: delta,
      },
    });
  }
}

/**
 * ==============================
 * buildOutboundDetail
 * ==============================
 */
export async function buildOutboundDetail(
  outboundId: number,
  outboundNo: string,
  currentLocationId?: number | null,
) {
  const rows = await prisma.goods_out_item.findMany({
    where: { outbound_id: outboundId, deleted_at: null },
    select: {
      id: true,
      sequence: true,
      product_id: true,
      code: true,
      name: true,
      unit: true,
      tracking: true,
      lot_id: true,
      lot_serial: true,
      qty: true,
      pick: true,
      pack: true,
      status: true,
      created_at: true,
      updated_at: true,
      confirmed_pick: true as any,
      user_pick: true as any,
      pick_time: true as any,
    },
    orderBy: [{ sequence: "asc" }, { created_at: "asc" }],
  });

  const expMap = await buildExpirationDateMapForGoodsOutItems(
    rows.map((x: any) => ({
      product_id: x.product_id ?? null,
      lot_serial: x.lot_serial ?? null,
    })),
  );

  const itemIds = rows
    .map((x: any) => Number(x.id))
    .filter((x: number) => Number.isFinite(x) && x > 0);

  const locationPickRows =
    itemIds.length > 0
      ? await prisma.goods_out_item_location_pick.findMany({
          where: {
            goods_out_item_id: { in: itemIds },
          },
          select: {
            goods_out_item_id: true,
            location_id: true,
            qty_pick: true,
            location: {
              select: {
                id: true,
                full_name: true,
              },
            },
          },
          orderBy: [{ goods_out_item_id: "asc" }, { location_id: "asc" }],
        })
      : [];

  const locationPickMap = new Map<
    number,
    Array<{
      location_id: number;
      location_name: string;
      qty_pick: number;
    }>
  >();

  for (const r of locationPickRows as any[]) {
    const itemId = Number(r.goods_out_item_id);
    const arr = locationPickMap.get(itemId) ?? [];

    arr.push({
      location_id: Number(r.location_id ?? 0),
      location_name: String(r.location?.full_name ?? ""),
      qty_pick: Number(r.qty_pick ?? 0),
    });

    locationPickMap.set(itemId, arr);
  }

  const lines = rows.map((x: any) => {
    const required = Number(x.qty ?? 0);
    const picked = Number(x.pick ?? 0);

    const exp =
      x.product_id != null
        ? (expMap.get(expKeyOf(x.product_id, x.lot_serial)) ?? null)
        : null;

    const allLocationPicks = locationPickMap.get(Number(x.id)) ?? [];

    const location_picks =
      currentLocationId != null
        ? allLocationPicks.filter(
            (r) => Number(r.location_id ?? 0) === Number(currentLocationId),
          )
        : allLocationPicks;

    return {
      ...x,
      exp: exp ? new Date(exp).toISOString() : null,
      qty_required: required,
      qty_pick: picked,
      remaining: Math.max(0, required - picked),
      completed: required > 0 ? picked >= required : true,
      location_picks,
      total_location_pick: location_picks.reduce(
        (sum, r) => sum + Number(r.qty_pick ?? 0),
        0,
      ),
    };
  });

  const completed = lines.every((l) => l.completed);

  return {
    outbound_no: outboundNo,
    total_items: lines.length,
    completed,
    lines,
  };
}

/**
 * =========================
 * 1) Scan Location
 * =========================
 */

export const scanOutboundLocation = asyncHandler(
  async (
    req: Request<{ no: string }, {}, { location_full_name: string }>,
    res: Response,
  ) => {
    const no = decodeURIComponent(req.params.no);

    const payload = await handleScanLocationCommon({
      docNo: no,
      locationFullName: req.body.location_full_name,
      loadDocument: () =>
        prisma.outbound.findUnique({
          where: { no },
          select: { id: true, no: true, deleted_at: true },
        }),
      resolveLocation: resolveLocationByFullNameBasic,
      buildDetail: ({ doc, location }) =>
        buildOutboundDetail(doc.id, doc.no, location.id),
      buildPayload: ({ location, detail }) => ({
        location: {
          location_id: location.id,
          location_name: location.full_name,
        },
        ...detail,
      }),
      emitRealtime: (payload, doc) => {
        emitOutboundRealtime(no, "outbound:scan_location", payload, doc.id);
      },
      notFoundMessage: `ไม่พบ outbound: ${no}`,
    });

    return res.json(payload);
  },
);

function shouldTreatAsLotAdjustment(
  itemLot: string | null | undefined,
  scannedLot: string | null | undefined,
) {
  // ถ้า no lot ทั้งคู่ => ไม่ใช่ lot adjustment
  if (isNullLikeLot(itemLot) && isNullLikeLot(scannedLot)) {
    return false;
  }

  // ใช้ logic nullable กลางที่มีอยู่แล้ว
  return !lotMatchedNullable(itemLot, scannedLot);
}

async function findCandidateGoodsOutItemsByScannedBarcode(
  outboundId: number,
  scannedBarcode: string,
) {
  const rows = await prisma.goods_out_item.findMany({
    where: {
      outbound_id: outboundId,
      deleted_at: null,
      barcode_text: { not: null },
    },
    select: goodsOutCandidateSelect,
    orderBy: [{ sequence: "asc" }, { id: "asc" }],
  });

  const raw = normalizeBarcodeBaseForMatch(scannedBarcode);

  const matched = rows.filter((x) => {
    const base = normalizeBarcodeBaseForMatch(x.barcode_text ?? "");
    return !!base && raw.startsWith(base);
  });

  matched.sort((a, b) => {
    const al = normalizeBarcodeBaseForMatch(a.barcode_text ?? "").length;
    const bl = normalizeBarcodeBaseForMatch(b.barcode_text ?? "").length;
    return bl - al;
  });

  return matched;
}

async function assertLocationHasStockForScan(args: {
  tx: Prisma.TransactionClient;
  location_id: number;
  location_full_name: string;
  product_id: number;
  lot_serial: string | null | undefined;
}) {
  const lotSerial = String(args.lot_serial ?? "").trim();
  if (!lotSerial) {
    throw badRequest("ไม่พบ lot_serial สำหรับตรวจ stock");
  }

  const stockRow = await args.tx.stock.findFirst({
    where: {
      location_id: args.location_id,
      product_id: args.product_id,
      lot_name: lotSerial,
      source: "wms",
      active: true,
    } as any,
    select: {
      id: true,
      quantity: true,
      location_name: true,
      lot_name: true,
      product_id: true,
    },
    orderBy: { id: "desc" },
  });

  if (!stockRow || Number(stockRow.quantity ?? 0) <= 0) {
    throw badRequest(
      `location ${args.location_full_name} ไม่มี stock ของสินค้า product_id=${args.product_id} lot=${lotSerial}`,
    );
  }

  return stockRow;
}

async function findMatchingStockAtLocation(args: {
  tx: Prisma.TransactionClient;
  location_id: number;
  product_id: number;
  lot_serial: string | null | undefined;
  exp: Date | string | null | undefined;
  exp_text?: string | null;
}) {
  const rows = await args.tx.stock.findMany({
    where: {
      source: "wms",
      active: true,
      location_id: args.location_id,
      product_id: args.product_id,
    } as any,
    select: {
      id: true,
      quantity: true,
      location_id: true,
      location_name: true,
      lot_id: true,
      lot_name: true,
      expiration_date: true,
    },
    orderBy: [{ id: "desc" }],
  });

  return (
    rows.find((row: any) => {
      const lotOk = lotMatchedNullable(row.lot_name, args.lot_serial);
      const expOk = expMatchedNullable(
        row.expiration_date,
        args.exp,
        args.exp_text,
      );
      return lotOk && expOk;
    }) ?? null
  );
}

async function assertLocationHasStockForScanByLotExp(args: {
  tx: Prisma.TransactionClient;
  location_id: number;
  location_full_name: string;
  product_id: number;
  lot_serial: string | null | undefined;
  exp: Date | string | null | undefined;
  exp_text?: string | null;
}) {
  const stockRow = await findMatchingStockAtLocation(args);

  if (!stockRow || Number(stockRow.quantity ?? 0) <= 0) {
    throw badRequest(
      `location ${args.location_full_name} ไม่มี stock ของสินค้า product_id=${args.product_id} lot=${args.lot_serial ?? "null"} exp=${args.exp ? new Date(args.exp).toISOString().slice(0, 10) : (args.exp_text ?? "null")}`,
    );
  }

  return stockRow;
}

/**
 * =========================
 * 2) Scan Pick (Preview from barcode, no DB update)
 * POST /api/outbounds/:no/scan/barcode
 * body: { barcode: string; location_full_name: string; qty_input?: number }
 * =========================
 */
export const scanOutboundPick = asyncHandler(
  async (
    req: Request<
      { no: string },
      {},
      { barcode: string; location_full_name: string; qty_input?: number }
    >,
    res: Response,
  ) => {
    const no = decodeURIComponent(req.params.no);
    const barcodeText = String(req.body.barcode ?? "").trim();
    const location_full_name = String(req.body.location_full_name ?? "").trim();

    if (!barcodeText) throw badRequest("กรุณาส่ง barcode");
    if (!location_full_name) {
      throw badRequest("กรุณาส่ง location_full_name");
    }

    const outbound = await prisma.outbound.findUnique({
      where: { no },
      select: { id: true, no: true, deleted_at: true },
    });
    if (!outbound || outbound.deleted_at) {
      throw notFound(`ไม่พบ outbound: ${no}`);
    }

    const loc = await resolveLocationByFullNameBasic(location_full_name);

    const masterBc = await findMasterBarcodeForScan(barcodeText);

    const masterBarcodeBase = masterBc
      ? normalizeBarcodeBaseForMatch(masterBc.barcode ?? "")
      : "";

    const scannedBarcodeBase = normalizeBarcodeBaseForMatch(barcodeText);

    let candidates = masterBarcodeBase
      ? await findCandidateGoodsOutItemsByBarcodeBase(
          outbound.id,
          masterBarcodeBase,
        )
      : [];

    if (!candidates.length) {
      candidates = await findCandidateGoodsOutItemsByScannedBarcode(
        outbound.id,
        scannedBarcodeBase,
      );
    }

    if (!candidates.length) {
      throw badRequest(`ไม่พบสินค้าใน outbound สำหรับ barcode: ${barcodeText}`);
    }

    let matchedItem: (typeof candidates)[number] | null = null;
    let parsedResult: any = null;

    for (const item of candidates) {
      if (item.product_id == null) continue;

      if (
        masterBc?.product_id != null &&
        Number(masterBc.product_id) !== Number(item.product_id)
      ) {
        continue;
      }

      const parsed = masterBc
        ? parseScannedBarcodeByMasterMeta({
            scannedBarcode: barcodeText,
            masterBarcode: String(masterBc.barcode ?? ""),
            lot_start: masterBc.lot_start,
            lot_stop: masterBc.lot_stop,
            exp_start: masterBc.exp_start,
            exp_stop: masterBc.exp_stop,
          })
        : parseScannedBarcodeByBaseBarcode(
            barcodeText,
            String(item.barcode_text ?? ""),
          );

      const isNewLotPlaceholder = normalizeScanText(
        item.lot_serial ?? "",
      ).startsWith("#");

      const lotMatched = isNewLotPlaceholder
        ? true
        : lotMatchedNullable(item.lot_serial, parsed.lot_serial);

      const matchedStock = await findMatchingStockAtLocation({
        tx: prisma,
        location_id: loc.id,
        product_id: item.product_id,
        lot_serial: parsed.lot_serial,
        exp: parsed.exp,
        exp_text: parsed.exp_text,
      });

      if (!lotMatched) continue;
      if (!matchedStock) continue;

      matchedItem = item;
      parsedResult = parsed;
      break;
    }

    if (!matchedItem || !parsedResult) {
      throw badRequest("barcode ไม่ตรงกับ item");
    }

    const isLotAdjustment = shouldTreatAsLotAdjustment(
      matchedItem.lot_serial,
      parsedResult.lot_serial,
    );

    const inputNumber = await resolveInputNumber(
      matchedItem.product_id!,
      matchedItem.lot_id ?? null,
    );

    let addQty = 1;
    if (inputNumber) {
      const q = req.body.qty_input;
      if (q == null || !Number.isFinite(q) || Number(q) <= 0) {
        throw badRequest("ต้องกรอก qty_input");
      }
      addQty = Math.floor(Number(q));
    }

    const saved = await prisma.$transaction(async (tx) => {
      const freshItem = await tx.goods_out_item.findUnique({
        where: { id: matchedItem!.id },
        select: {
          id: true,
          qty: true,
          pick: true,
          product_id: true,
          lot_id: true,
          lot_serial: true,
          code: true,
          name: true,
          unit: true,
          barcode_text: true,
          deleted_at: true,
        },
      });

      if (!freshItem || freshItem.deleted_at) {
        throw badRequest("item หาย");
      }

      if (freshItem.product_id == null) {
        throw badRequest("ไม่พบ product_id ของ item");
      }

      const effectiveLotSerial =
        parsedResult?.lot_serial ?? freshItem.lot_serial ?? null;

      // ✅ หา stock ที่ location นี้ + lot/exp ที่ scan จริง
      const stockRow = await findMatchingStockAtLocation({
        tx,
        location_id: loc.id,
        product_id: freshItem.product_id,
        lot_serial: effectiveLotSerial,
        exp: parsedResult?.exp ?? null,
        exp_text: parsedResult?.exp_text ?? null,
      });

      if (!stockRow || Number(stockRow.quantity ?? 0) <= 0) {
        throw badRequest(
          `location ${loc.full_name} ไม่มี stock ของสินค้า product_id=${freshItem.product_id} lot=${effectiveLotSerial ?? "null"}`,
        );
      }

      const stockQty = Math.max(0, Math.floor(Number(stockRow.quantity ?? 0)));
      const currentPick = Math.max(0, Math.floor(Number(freshItem.pick ?? 0)));

      // ✅ ห้าม scan เกิน stock เด็ดขาด
      if (currentPick >= stockQty) {
        throw badRequest(
          `สินค้าไม่พอสำหรับ scan เพิ่ม (stock=${stockQty}, pick แล้ว=${currentPick})`,
        );
      }

      // ===============================
      // 🔥 LOT ADJUSTMENT MODE
      // ===============================
      if (isLotAdjustment) {
        const adjLines = await tx.outbound_lot_adjustment_line.findMany({
          where: { goods_out_item_id: freshItem.id },
          select: { pick: true },
        });

        const totalAdjusted = adjLines.reduce(
          (sum, l) => sum + Number(l.pick ?? 0),
          0,
        );

        const currentPick = Number(freshItem.pick ?? 0);
        const remaining = Math.max(0, currentPick - totalAdjusted);

        if (remaining <= 0) {
          throw badRequest("ไม่มีจำนวน pick เหลือให้เปลี่ยน lot");
        }

        const stockRemaining = Math.max(0, stockQty - currentPick);
        const willUse = Math.min(addQty, remaining, stockRemaining);

        if (willUse <= 0) {
          throw badRequest(
            `สินค้าไม่พอสำหรับเปลี่ยน lot (stock=${stockQty}, pick แล้ว=${currentPick})`,
          );
        }

        const updatedAdjustmentLine = await upsertOutboundLotAdjustmentLinePick(
          tx,
          {
            outbound_id: outbound.id,
            goods_out_item_id: freshItem.id,
            location_id: loc.id,
            location_name: loc.full_name,
            product_id: freshItem.product_id,
            code: freshItem.code ?? null,
            name: freshItem.name ?? null,
            unit: freshItem.unit ?? null,
            lot_id: null,
            lot_serial: parsedResult.lot_serial ?? null,
            exp: parsedResult.exp ?? null,
            barcode_text: barcodeText,
            pick_delta: willUse,
          },
        );

        await upsertGoodsOutItemLocationPick(tx, {
          goods_out_item_id: freshItem.id,
          location_id: loc.id,
          qty_pick_delta: willUse,
        });

        return {
          updatedItem: freshItem,
          appliedQty: willUse,
          is_adjustment: true,
          adjustment_line: updatedAdjustmentLine,
        };
      }

      // ===============================
      // ✅ NORMAL PICK
      // ===============================
      const requiredQty = Number(freshItem.qty ?? 0);
      const remaining = Math.max(0, requiredQty - currentPick);

      if (requiredQty > 0 && remaining <= 0) {
        throw badRequest("pick ครบแล้ว");
      }

      const stockRemaining = Math.max(0, stockQty - currentPick);
      const willAdd =
        requiredQty > 0
          ? Math.min(addQty, remaining, stockRemaining)
          : Math.min(addQty, stockRemaining);

      if (willAdd <= 0) {
        throw badRequest(
          `สินค้าไม่พอสำหรับ pick เพิ่ม (stock=${stockQty}, pick แล้ว=${currentPick})`,
        );
      }

      const updatedItem = await incrementGoodsOutItemPick(tx, {
        goods_out_item_id: freshItem.id,
        add_qty: willAdd,
      });

      await upsertGoodsOutItemLocationPick(tx, {
        goods_out_item_id: freshItem.id,
        location_id: loc.id,
        qty_pick_delta: willAdd,
      });

      return {
        updatedItem,
        appliedQty: willAdd,
        is_adjustment: false,
      };
    });

    const detail = await buildOutboundDetail(outbound.id, no, loc.id);

    return res.json({
      ...detail,
      addQty: saved.appliedQty,
      is_adjustment: saved.is_adjustment,
    });
  },
);

export const scanOutboundReturn = asyncHandler(
  async (
    req: Request<
      { no: string },
      {},
      { barcode: string; location_full_name: string; qty_input?: number }
    >,
    res: Response,
  ) => {
    const no = decodeURIComponent(req.params.no);
    const barcodeText = String(req.body.barcode ?? "").trim();
    const location_full_name = String(req.body.location_full_name ?? "").trim();

    if (!barcodeText) throw badRequest("กรุณาส่ง barcode");
    if (!location_full_name) {
      throw badRequest("กรุณาส่ง location_full_name");
    }

    const outbound = await prisma.outbound.findUnique({
      where: { no },
      select: { id: true, no: true, deleted_at: true },
    });
    if (!outbound || outbound.deleted_at) {
      throw notFound(`ไม่พบ outbound: ${no}`);
    }

    const loc = await resolveLocationByFullNameBasic(location_full_name);

    // ใช้ flow เดียวกับ scanPick
    const masterBc = await findMasterBarcodeForScan(barcodeText);

    const masterBarcodeBase = masterBc
      ? normalizeBarcodeBaseForMatch(masterBc.barcode ?? "")
      : "";

    const scannedBarcodeBase = normalizeBarcodeBaseForMatch(barcodeText);

    let candidates = masterBarcodeBase
      ? await findCandidateGoodsOutItemsByBarcodeBase(
          outbound.id,
          masterBarcodeBase,
        )
      : [];

    if (!candidates.length) {
      candidates = await findCandidateGoodsOutItemsByScannedBarcode(
        outbound.id,
        scannedBarcodeBase,
      );
    }

    if (!candidates.length) {
      throw badRequest(`ไม่พบสินค้าใน outbound สำหรับ barcode: ${barcodeText}`);
    }

    let matchedItem: (typeof candidates)[number] | null = null;
    let parsedResult: {
      barcode_text: string;
      lot_serial: string | null;
      exp_text: string;
      exp: Date | null;
      normalized_scan?: string;
      matched_by?: string;
    } | null = null;

    for (const item of candidates) {
      if (item.product_id == null) continue;

      const parsed = masterBc
        ? parseScannedBarcodeByMasterMeta({
            scannedBarcode: barcodeText,
            masterBarcode: String(masterBc.barcode ?? ""),
            lot_start: masterBc.lot_start,
            lot_stop: masterBc.lot_stop,
            exp_start: masterBc.exp_start,
            exp_stop: masterBc.exp_stop,
          })
        : parseScannedBarcodeByBaseBarcode(
            barcodeText,
            String(item.barcode_text ?? ""),
          );

      const scannedLot = parsed.lot_serial;
      const scannedExp = parsed.exp;

      const lotMatched = lotMatchedNullable(item.lot_serial, scannedLot);

      const stockExp = await findStockExpByProductLot(
        item.product_id,
        item.lot_id ?? null,
      );

      const expMatched = expMatchedNullable(
        stockExp,
        scannedExp,
        parsed.exp_text,
      );

      if (!lotMatched) continue;
      if (!expMatched) continue;

      matchedItem = item;
      parsedResult = parsed;
      break;
    }

    if (!matchedItem || !parsedResult) {
      throw badRequest(
        `ไม่พบสินค้าใน outbound ที่ตรงกับ barcode_text + lot_serial + exp สำหรับ barcode: ${barcodeText}`,
      );
    }

    const bc =
      masterBc ??
      (await prisma.barcode.findFirst({
        where: {
          barcode: String(matchedItem.barcode_text ?? "").trim(),
          deleted_at: null,
        },
        select: {
          id: true,
          barcode: true,
          lot_start: true,
          lot_stop: true,
          exp_start: true,
          exp_stop: true,
          barcode_length: true,
        },
      }));

    if (matchedItem.product_id == null) {
      throw badRequest("goods_out_item.product_id เป็น null");
    }

    const inputNumber = await resolveInputNumber(
      matchedItem.product_id,
      matchedItem.lot_id ?? null,
    );

    let returnQty = 1;
    if (inputNumber) {
      const q = req.body.qty_input;
      if (q == null || !Number.isFinite(q) || Number(q) <= 0) {
        throw badRequest("สินค้านี้ต้องกรอก qty_input (มากกว่า 0)");
      }
      returnQty = Math.floor(Number(q));
    }

    const saved = await prisma.$transaction(async (tx) => {
      const freshItem = await tx.goods_out_item.findUnique({
        where: { id: matchedItem!.id },
        select: {
          id: true,
          qty: true,
          pick: true,
          product_id: true,
          lot_id: true,
          lot_serial: true,
          code: true,
          name: true,
          unit: true,
          barcode_text: true,
          deleted_at: true,
        },
      });

      if (!freshItem || freshItem.deleted_at) {
        throw badRequest("ไม่พบ goods_out_item ที่ต้องการอัปเดต");
      }

      const currentPick = Number(freshItem.pick ?? 0);
      if (currentPick <= 0) {
        throw badRequest("รายการนี้ยังไม่มี pick ให้คืน");
      }

      const locationPick = await tx.goods_out_item_location_pick.findUnique({
        where: {
          goods_out_item_id_location_id: {
            goods_out_item_id: freshItem.id,
            location_id: loc.id,
          },
        },
        select: {
          goods_out_item_id: true,
          location_id: true,
          qty_pick: true,
        },
      });

      const locationPickedQty = Number(locationPick?.qty_pick ?? 0);

      if (locationPickedQty <= 0) {
        const availablePicks = await tx.goods_out_item_location_pick.findMany({
          where: {
            goods_out_item_id: freshItem.id,
            qty_pick: { gt: 0 },
          },
          include: {
            location: {
              select: {
                id: true,
                full_name: true,
              },
            },
          },
        });

        throw badRequest(
          `location นี้ยังไม่มี pick ที่จะคืน: scanned=${loc.full_name}(${loc.id}), available=${availablePicks
            .map(
              (x) =>
                `${x.location?.full_name ?? "-"}(${x.location_id}) qty=${x.qty_pick}`,
            )
            .join(", ")}`,
        );
      }

      const willReturn = Math.min(returnQty, currentPick, locationPickedQty);

      if (willReturn <= 0) {
        throw badRequest("ไม่สามารถคืน pick ได้");
      }

      const updatedItem = await tx.goods_out_item.update({
        where: { id: freshItem.id },
        data: {
          pick: {
            decrement: willReturn,
          },
          updated_at: new Date(),
        },
      });

      const nextLocationQty = locationPickedQty - willReturn;

      if (nextLocationQty <= 0) {
        await tx.goods_out_item_location_pick.delete({
          where: {
            goods_out_item_id_location_id: {
              goods_out_item_id: freshItem.id,
              location_id: loc.id,
            },
          },
        });
      } else {
        await tx.goods_out_item_location_pick.update({
          where: {
            goods_out_item_id_location_id: {
              goods_out_item_id: freshItem.id,
              location_id: loc.id,
            },
          },
          data: {
            qty_pick: nextLocationQty,
          },
        });
      }

      return {
        updatedItem,
        appliedQty: willReturn,
      };
    });

    const detail = await buildOutboundDetail(outbound.id, no, loc.id);
    const matchedLine =
      detail.lines.find((l: any) => l.id === matchedItem.id) ?? null;

    const payload = {
      ...detail,
      scanned: {
        barcode: barcodeText,
        barcode_text: parsedResult.barcode_text,
        lot_serial: parsedResult.lot_serial,
        exp: parsedResult.exp ? parsedResult.exp.toISOString() : null,
        normalized_scan:
          parsedResult.normalized_scan ??
          `${parsedResult.barcode_text}${parsedResult.lot_serial ?? ""}${
            parsedResult.exp_text !== "999999" ? parsedResult.exp_text : ""
          }`,
        matched_by:
          parsedResult.matched_by ?? (masterBc ? "FIXED_META" : "BASE"),
      },
      location: {
        location_id: loc.id,
        location_name: loc.full_name,
      },
      barcode_meta: {
        lot_start: bc?.lot_start ?? null,
        lot_stop: bc?.lot_stop ?? null,
        exp_start: bc?.exp_start ?? null,
        exp_stop: bc?.exp_stop ?? null,
        barcode_length: bc?.barcode_length ?? null,
      },
      input_number: inputNumber,
      returnQty: saved.appliedQty,
      matchedLine,
    };

    emitOutboundRealtime(no, "outbound:scan_return", payload, outbound.id);

    return res.json(payload);
  },
);

/**
 * =========================
 * Scan Barcode (real pick)
 * =========================
 */

async function resolveInputNumber(product_id: number, lot_id: number | null) {
  const row = await prisma.wms_mdt_goods.findFirst({
    where: {
      product_id,
      ...(lot_id ? { lot_id } : {}),
    },
    select: { input_number: true },
    orderBy: { id: "desc" },
  });

  return row?.input_number ?? false;
}

async function upsertOutboundLotAdjustmentLinePick(
  tx: Prisma.TransactionClient,
  input: {
    outbound_id: number;
    goods_out_item_id: number;
    location_id: number | null;
    location_name: string | null;
    product_id: number | null;
    code: string | null;
    name: string | null;
    unit: string | null;
    lot_id: number | null;
    lot_serial: string | null;
    exp: Date | null;
    barcode_text: string | null;
    pick_delta: number;
  },
) {
  const delta = Math.max(0, Math.floor(Number(input.pick_delta ?? 0)));
  if (delta <= 0) return null;

  let header = await tx.outbound_lot_adjustment.findFirst({
    where: {
      outbound_id: input.outbound_id,
    },
    select: { id: true },
    orderBy: { id: "desc" },
  });

  if (!header) {
    header = await tx.outbound_lot_adjustment.create({
      data: {
        outbound_id: input.outbound_id,
      } as any,
      select: { id: true },
    });
  }

  const existing = await tx.outbound_lot_adjustment_line.findFirst({
    where: {
      outbound_lot_adjustment_id: header.id,
      goods_out_item_id: input.goods_out_item_id,
      product_id: input.product_id ?? null,
      lot_id: input.lot_id ?? null,
      lot_serial: input.lot_serial ?? null,
      exp: input.exp ?? null,
      location_id: input.location_id ?? null,
    } as any,
    select: {
      id: true,
      pick: true,
    },
    orderBy: { id: "desc" },
  });

  if (existing) {
    return tx.outbound_lot_adjustment_line.update({
      where: { id: existing.id },
      data: {
        pick: Number(existing.pick ?? 0) + delta,
        updated_at: new Date(),
      } as any,
    });
  }

  return tx.outbound_lot_adjustment_line.create({
    data: {
      outbound_lot_adjustment_id: header.id,
      goods_out_item_id: input.goods_out_item_id,
      location_id: input.location_id ?? null,
      location_name: input.location_name ?? null,
      product_id: input.product_id ?? null,
      code: input.code ?? null,
      name: input.name ?? null,
      unit: input.unit ?? null,
      lot_id: input.lot_id ?? null,
      lot_serial: input.lot_serial ?? null,
      exp: input.exp ?? null,
      barcode_text: input.barcode_text ?? null,
      pick: delta,
    } as any,
  });
}

async function incrementGoodsOutItemPick(
  tx: Prisma.TransactionClient,
  input: {
    goods_out_item_id: number;
    add_qty: number;
  },
) {
  const delta = Math.max(0, Math.floor(Number(input.add_qty ?? 0)));
  if (delta <= 0) return null;

  const row = await tx.goods_out_item.findUnique({
    where: { id: input.goods_out_item_id },
    select: {
      id: true,
      qty: true,
      pick: true,
    },
  });

  if (!row) throw badRequest("ไม่พบ goods_out_item");

  const required = Math.max(0, Math.floor(Number(row.qty ?? 0)));
  const currentPick = Math.max(0, Math.floor(Number(row.pick ?? 0)));
  const nextPick: number =
    required > 0
      ? Math.min(required, currentPick + delta)
      : currentPick + delta;

  return tx.goods_out_item.update({
    where: { id: row.id },
    data: {
      pick: nextPick,
      updated_at: new Date(),
    },
  });
}

/**
 * หา stock ด้วย location_name
 */
async function findStockRowByLocationName(
  tx: Prisma.TransactionClient,
  input: {
    product_id: number;
    lot_id: number | null;
    lot_name: string | null;
    location_name: string;
  },
) {
  if (input.lot_id != null) {
    const exact = await tx.stock.findFirst({
      where: {
        source: "wms",
        product_id: input.product_id,
        lot_id: input.lot_id,
        lot_name: input.lot_name ?? null,
        location_name: input.location_name,
      } as any,
      select: {
        id: true,
        quantity: true,
        location_id: true,
        location_name: true,
        lot_id: true,
        lot_name: true,
        expiration_date: true,
      },
      orderBy: { id: "desc" },
    });
    if (exact) return exact;
  }

  const row = await tx.stock.findFirst({
    where: {
      source: "wms",
      product_id: input.product_id,
      lot_name: input.lot_name ?? null,
      location_name: input.location_name,
    } as any,
    select: {
      id: true,
      quantity: true,
      location_id: true,
      location_name: true,
      lot_id: true,
      lot_name: true,
      expiration_date: true,
    },
    orderBy: { id: "desc" },
  });

  return row;
}

async function assertScannedLocationHasStock(args: {
  product_id: number | null | undefined;
  lot_serial: string | null | undefined;
  location_id: number | null | undefined;
  location_name?: string | null | undefined;
}) {
  const productId =
    typeof args.product_id === "number" ? args.product_id : null;
  const lotSerial = String(args.lot_serial ?? "").trim();
  const locationId =
    typeof args.location_id === "number" ? args.location_id : null;
  const locationName = String(args.location_name ?? "").trim();

  if (!productId) {
    throw badRequest("ไม่พบ product_id ของรายการนี้");
  }

  if (!lotSerial) {
    throw badRequest("ไม่พบ lot_serial ของรายการนี้");
  }

  if (!locationId) {
    throw badRequest("ไม่พบ location ที่กำลังสแกน");
  }

  const stockRow = await prisma.stock.findFirst({
    where: {
      product_id: productId,
      lot_name: lotSerial,
      location_id: locationId,
      source: "wms",
      active: true,
    } as any,
    select: {
      id: true,
      quantity: true,
      location_name: true,
      lot_name: true,
      product_id: true,
    },
    orderBy: { id: "desc" },
  });

  if (!stockRow || Number(stockRow.quantity ?? 0) <= 0) {
    throw badRequest(
      `location ${locationName || locationId} ไม่มี stock ของสินค้า product_id=${productId} lot=${lotSerial}`,
    );
  }

  return stockRow;
}

export const scanOutboundBarcode = asyncHandler(
  async (
    req: Request<
      { no: string },
      {},
      { barcode: string; location_full_name: string; qty_input?: number }
    >,
    res: Response,
  ) => {
    const no = decodeURIComponent(req.params.no);
    const barcodeText = (req.body.barcode || "").trim();
    const location_full_name = (req.body.location_full_name || "").trim();

    if (!barcodeText) throw badRequest("กรุณาส่ง barcode");
    if (!location_full_name) throw badRequest("กรุณาส่ง location_full_name");

    const outbound = await prisma.outbound.findUnique({
      where: { no },
      select: { id: true, no: true, deleted_at: true },
    });
    if (!outbound || outbound.deleted_at) {
      throw notFound(`ไม่พบ outbound: ${no}`);
    }

    const loc = await resolveLocationByFullNameBasic(location_full_name);

    const masterBc = await findMasterBarcodeForScan(barcodeText);

    const candidates = masterBc
      ? await findCandidateGoodsOutItemsByBarcodeBase(
          outbound.id,
          String(masterBc.barcode ?? ""),
        )
      : await findCandidateGoodsOutItemsByScannedBarcode(
          outbound.id,
          barcodeText,
        );

    if (!candidates.length) {
      throw badRequest(
        `ไม่พบ goods_out_item ที่ผูกกับ barcode นี้ใน outbound: ${no}`,
      );
    }

    let baseItem: (typeof candidates)[number] | null = null;
    let parsedResult: {
      barcode_text: string;
      lot_serial: string | null;
      exp_text: string;
      exp: Date | null;
    } | null = null;

    for (const item of candidates) {
      if (item.product_id == null) continue;

      const parsed = masterBc
        ? parseScannedBarcodeByMasterMeta({
            scannedBarcode: barcodeText,
            masterBarcode: String(masterBc.barcode ?? ""),
            lot_start: masterBc.lot_start,
            lot_stop: masterBc.lot_stop,
            exp_start: masterBc.exp_start,
            exp_stop: masterBc.exp_stop,
          })
        : parseScannedBarcodeByBaseBarcode(
            barcodeText,
            String(item.barcode_text ?? ""),
          );

      const lotMatched = lotMatchedNullable(item.lot_serial, parsed.lot_serial);

      const stockExp = await findStockExpByProductLot(
        item.product_id,
        item.lot_id ?? null,
      );

      const expMatched = expMatchedNullable(
        stockExp,
        parsed.exp ?? null,
        parsed.exp_text,
      );

      if (!lotMatched) continue;
      if (!expMatched) continue;

      baseItem = item;
      parsedResult = parsed;
      break;
    }

    if (!baseItem || !parsedResult) {
      throw badRequest(
        `ไม่พบสินค้าใน outbound ที่ตรงกับ barcode_text + lot_serial + exp`,
      );
    }

    const bc =
      masterBc ??
      (await prisma.barcode.findFirst({
        where: {
          barcode: String(baseItem.barcode_text ?? "").trim(),
          deleted_at: null,
        },
      }));

    if (!bc) {
      throw badRequest(`ไม่พบ barcode master`);
    }

    const productId = baseItem.product_id!;

    const inputNumber = await resolveInputNumber(
      productId,
      baseItem.lot_id ?? null,
    );

    let addQty = 1;
    if (inputNumber) {
      const q = req.body.qty_input;
      if (q == null || !Number.isFinite(q) || Number(q) <= 0) {
        throw badRequest("สินค้านี้ต้องกรอก qty_input (มากกว่า 0)");
      }
      addQty = Math.floor(Number(q));
    }

    const isLotAdjustment =
      normalizeScanText(baseItem.lot_serial ?? "") !==
      normalizeScanText(parsedResult.lot_serial ?? "");

    const saved = await prisma.$transaction(async (tx) => {
      const stockRow = await findStockRowByLocationName(tx, {
        product_id: productId,
        lot_id: isLotAdjustment ? null : (baseItem.lot_id ?? null),
        lot_name: parsedResult!.lot_serial ?? null,
        location_name: loc.full_name,
      });

      if (!stockRow) {
        throw badRequest("ไม่พบ stock สำหรับรายการนี้");
      }

      const stockQty = Number(stockRow.quantity ?? 0);
      if (stockQty <= 0) {
        throw badRequest("stock เหลือ 0 แล้ว");
      }

      const requiredQty = Number(baseItem.qty ?? 0);
      const currentPick = Number(baseItem.pick ?? 0);
      const remaining = Math.max(0, requiredQty - currentPick);

      const willAdd =
        !isLotAdjustment && requiredQty > 0
          ? Math.min(addQty, remaining)
          : addQty;

      if (willAdd <= 0) {
        throw badRequest("ไม่สามารถ pick เพิ่มได้");
      }

      if (stockQty < willAdd) {
        throw badRequest(`stock ไม่พอ`);
      }

      let updatedMainItem = null;
      let updatedAdjustmentLine = null;

      if (isLotAdjustment) {
        updatedAdjustmentLine = await upsertOutboundLotAdjustmentLinePick(tx, {
          outbound_id: outbound.id,
          goods_out_item_id: baseItem.id,
          location_id: loc.id,
          location_name: loc.full_name,
          product_id: productId,
          code: baseItem.code ?? null,
          name: baseItem.name ?? null,
          unit: baseItem.unit ?? null,
          lot_id: null,
          lot_serial: parsedResult.lot_serial ?? null,
          exp: parsedResult.exp ?? null,
          barcode_text: bc.barcode,
          pick_delta: willAdd,
        });
      } else {
        updatedMainItem = await incrementGoodsOutItemPick(tx, {
          goods_out_item_id: baseItem.id,
          add_qty: willAdd,
        });
      }

      await upsertGoodsOutItemLocationPick(tx, {
        goods_out_item_id: baseItem.id,
        location_id: loc.id,
        qty_pick_delta: willAdd,
      });

      return {
        updatedMainItem,
        updatedAdjustmentLine,
        appliedQty: willAdd,
        isLotAdjustment,
      };
    });

    const detail = await buildOutboundDetail(outbound.id, no, loc.id);
    const matchedLine =
      detail.lines.find((l: any) => l.id === baseItem!.id) ?? null;

    const payload = {
      ...detail,
      location: {
        location_id: loc.id,
        location_name: loc.full_name,
      },
      scanned: {
        barcode: barcodeText,
        barcode_text: parsedResult.barcode_text,
        lot_serial: parsedResult.lot_serial,
        exp: parsedResult.exp ? parsedResult.exp.toISOString() : null,
      },
      barcode_meta: {
        lot_start: bc.lot_start ?? null,
        lot_stop: bc.lot_stop ?? null,
        exp_start: bc.exp_start ?? null,
        exp_stop: bc.exp_stop ?? null,
      },
      input_number: inputNumber,
      addQty: saved.appliedQty,
      lot_adjustment: saved.isLotAdjustment,
      matchedLine,
    };

    emitOutboundRealtime(no, "outbound:scan_barcode", payload, outbound.id);

    return res.json(payload);
  },
);

type ParsedBarcodeResult = {
  product_id?: number | null;
  lot_serial?: string | null;
  exp?: Date | null;
  barcode_text?: string | null;
};

function normalizeDateOnlyKey(value: Date | string | null | undefined): string {
  if (!value) return "-";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toISOString().slice(0, 10);
}
/**
 * =========================
 * BO/INV/BS -> BOR/SER STOCK UPSERT
 * =========================
 */

const BOR_SER_TYPES = new Set(["BO", "INV", "BS"]);

function resolveOutTypeFromNo(no: string | null | undefined): string {
  const s = String(no ?? "").toUpperCase();
  if (!s) return "DO";

  const TYPES = [
    "BOA",
    "BOS",
    "CPD",
    "NCR",
    "EX",
    "SV",
    "GA",
    "TF",
    "INV",
    "BS",
    "BO",
    "DO",
  ];
  for (const t of TYPES) {
    if (s.includes(t)) return t;
  }
  return "DO";
}

function resolveBorSerTargetFromLocationDest(
  locationDest: string | null | undefined,
) {
  const s = String(locationDest ?? "").toUpperCase();
  if (s.includes("BOR")) return "BOR" as const;
  if (s.includes("SER")) return "SER" as const;
  return null;
}

async function upsertBorSerStockByDelta(
  tx: Prisma.TransactionClient,
  args: {
    target: "BOR" | "SER";
    no: string;
    product_id: number;
    product_code: string | null;
    product_name: string | null;
    unit: string | null;
    lot_id: number | null;
    lot_name: string | null;
    location_id: number | null;
    location_name: string | null;
    expiration_date?: Date | null;
    deltaQty: number;
    user_pick?: string | null;
    department_id?: string | null;
    department?: string | null;
  },
) {
  const now = new Date();
  const qty = Number(args.deltaQty ?? 0);
  if (!Number.isFinite(qty) || qty <= 0) return;

  const whereKey = {
    product_id: args.product_id,
    lot_name: args.lot_name ?? null,
    location_id: args.location_id ?? null,
    expiration_date: args.expiration_date ?? null,
  };

  const baseData = {
    snapshot_date: now,
    no: args.no,
    product_id: args.product_id,
    product_code: args.product_code ?? null,
    product_name: args.product_name ?? null,
    unit: args.unit ?? null,
    location_id: args.location_id ?? null,
    location_name: args.location_name ?? null,
    lot_id: args.lot_id ?? null,
    lot_name: args.lot_name ?? null,
    department_id: args.department_id ?? null,
    department_name: args.department ?? null,
    expiration_date: args.expiration_date ?? null,
    product_last_modified_date: now.toISOString(),
    source: "wms",
    active: true,
    user_pick: args.user_pick ?? null,
  };

  if (args.target === "SER") {
    const existed = await tx.ser_stock.findFirst({
      where: whereKey as any,
      select: { id: true },
      orderBy: { id: "desc" },
    });

    if (existed) {
      await tx.ser_stock.update({
        where: { id: existed.id },
        data: {
          ...baseData,
          quantity: { increment: new Prisma.Decimal(qty) },
        } as any,
      });
    } else {
      await tx.ser_stock.create({
        data: {
          ...baseData,
          quantity: new Prisma.Decimal(qty),
        } as any,
      });
    }
  } else {
    const existed = await tx.bor_stock.findFirst({
      where: whereKey as any,
      select: { id: true },
      orderBy: { id: "desc" },
    });

    if (existed) {
      await tx.bor_stock.update({
        where: { id: existed.id },
        data: {
          ...baseData,
          quantity: { increment: new Prisma.Decimal(qty) },
        } as any,
      });
    } else {
      await tx.bor_stock.create({
        data: {
          ...baseData,
          quantity: new Prisma.Decimal(qty),
        } as any,
      });
    }
  }
}

async function resolveFallbackLotExpForOutboundReturnTx(
  tx: Prisma.TransactionClient,
  args: {
    product_id: number;
    lot_id: number | null;
    lot_serial: string | null;
    exp: Date | null;
  },
) {
  let resolvedLotSerial = args.lot_serial ?? null;
  let resolvedExp = args.exp ?? null;

  if (!resolvedLotSerial || !resolvedExp) {
    const where: any = {
      product_id: args.product_id,
    };

    if (args.lot_id != null) {
      where.lot_id = args.lot_id;
    }

    if (resolvedLotSerial) {
      where.lot_name = resolvedLotSerial;
    }

    const fallbackGoods = await tx.wms_mdt_goods.findFirst({
      where,
      orderBy: { id: "desc" },
    });

    if (!resolvedLotSerial) {
      resolvedLotSerial = fallbackGoods?.lot_name ?? null;
    }

    if (!resolvedExp) {
      resolvedExp = fallbackGoods?.expiration_date ?? null;
    }
  }

  return {
    lot_serial: resolvedLotSerial,
    exp: resolvedExp,
  };
}

async function findStockRowForReturnTx(
  tx: Prisma.TransactionClient,
  args: {
    product_id: number;
    location_id: number;
    lot_serial: string | null;
    exp: Date | null;
  },
) {
  const rows = await tx.stock.findMany({
    where: {
      product_id: args.product_id,
      location_id: args.location_id,
      lot_name: args.lot_serial ?? null,
    } as any,
    orderBy: [{ id: "desc" }],
  });

  return (
    rows.find(
      (row: any) =>
        normalizeDateOnlyKey(row.expiration_date) ===
        normalizeDateOnlyKey(args.exp),
    ) ??
    rows[0] ??
    null
  );
}

async function increaseStockFromOutboundReturnTx(
  tx: Prisma.TransactionClient,
  args: {
    item: {
      product_id: number;
      code: string | null;
      name: string | null;
      unit: string | null;
      lot_id: number | null;
      lot_serial: string | null;
      exp: Date | null;
    };
    location: {
      id: number;
      full_name: string;
    };
    qty: number;
  },
) {
  const qty = Math.max(0, Math.floor(Number(args.qty ?? 0)));
  if (qty <= 0) return;

  const fallback = await resolveFallbackLotExpForOutboundReturnTx(tx, {
    product_id: args.item.product_id,
    lot_id: args.item.lot_id,
    lot_serial: args.item.lot_serial,
    exp: args.item.exp,
  });

  const existing = await findStockRowForReturnTx(tx, {
    product_id: args.item.product_id,
    location_id: args.location.id,
    lot_serial: fallback.lot_serial,
    exp: fallback.exp,
  });

  if (existing) {
    await tx.stock.update({
      where: { id: existing.id },
      data: {
        quantity: { increment: new Prisma.Decimal(qty) },
        updated_at: new Date(),
        lot_id: args.item.lot_id ?? existing.lot_id ?? null,
        lot_name: fallback.lot_serial ?? existing.lot_name ?? null,
        expiration_date: fallback.exp ?? existing.expiration_date ?? null,
      } as any,
    });
    return;
  }

  await tx.stock.create({
    data: {
      bucket_key: buildStockBucketKey({
        source: "wms",
        product_id: args.item.product_id,
        location_id: args.location.id,
        lot_id: args.item.lot_id ?? null,
        lot_name: fallback.lot_serial ?? null,
        expiration_date: fallback.exp ?? null,
      }),

      product_id: args.item.product_id,
      product_code: args.item.code ?? null,
      product_name: args.item.name ?? null,
      unit: args.item.unit ?? null,

      location_id: args.location.id,
      location_name: args.location.full_name,

      lot_id: args.item.lot_id ?? null,
      lot_name: fallback.lot_serial ?? null,
      expiration_date: fallback.exp ?? null,

      quantity: new Prisma.Decimal(qty),
      source: "wms",
      active: true,
    } as any,
  });
}

async function getPdQtyForGoodsOutItem(
  tx: any,
  outbound: {
    id?: number;
    no?: string | null;
    invoice?: string | null;
    origin?: string | null;
  },
  freshItem: any,
): Promise<number> {
  const refs = [outbound.invoice, outbound.origin]
    .map((x) => String(x ?? "").trim())
    .filter(Boolean);

  if (refs.length === 0) return 0;

  const pdInbounds = await tx.inbound.findMany({
    where: {
      in_type: "PD",
      deleted_at: null,
      origin: { in: refs },
    } as any,
    select: {
      id: true,
    },
  });

  const inboundIds = pdInbounds.map((x: any) => Number(x.id)).filter(Boolean);

  if (inboundIds.length === 0) return 0;

  const pdGoodsInRows = await tx.goods_in.findMany({
    where: {
      inbound_id: { in: inboundIds },
      product_id: Number(freshItem.product_id),
      lot_serial: freshItem.lot_serial,
      deleted_at: null,
    } as any,
    select: {
      qty: true,
    } as any,
  });

  return pdGoodsInRows.reduce((sum: number, item: any) => {
    return sum + Number(item.qty ?? 0);
  }, 0);
}

export const scanBarcodeOutboundReturn = asyncHandler(
  async (req: Request, res: Response) => {
    const no = String(req.params.no || "").trim();
    const barcode = String(req.body?.barcode || "").trim();
    const location_full_name = String(
      req.body?.location_full_name || "",
    ).trim();

    const qtyInputRaw = req.body?.qty_input;
    const qtyInput =
      qtyInputRaw == null || qtyInputRaw === "" ? 1 : Number(qtyInputRaw);

    if (!no) throw badRequest("no is required");
    if (!barcode) throw badRequest("barcode is required");
    if (!location_full_name) throw badRequest("location_full_name is required");

    if (!Number.isFinite(qtyInput) || qtyInput <= 0) {
      throw badRequest("qty_input ต้องเป็นตัวเลขมากกว่า 0");
    }

    const qty = Math.max(1, Math.floor(qtyInput));

    const returnMode = String(req.body?.return_mode ?? "")
      .trim()
      .toUpperCase();

    const isPdReturnMode = returnMode === "PD";

    const outbound = await prisma.outbound.findFirst({
      where: { no, deleted_at: null } as any,
      select: {
        id: true,
        no: true,
        invoice: true,
        origin: true,
      } as any,
    });

    if (!outbound) throw notFound("outbound not found");

    const location = await resolveLocationByFullNameBasic(location_full_name);

    const masterBc = await findMasterBarcodeForScan(barcode);

    const masterBarcodeBase = masterBc
      ? normalizeBarcodeBaseForMatch(masterBc.barcode ?? "")
      : "";

    const scannedBarcodeBase = normalizeBarcodeBaseForMatch(barcode);

    let candidates: any[] = [];

    if (masterBarcodeBase) {
      candidates = await findCandidateGoodsOutItemsByBarcodeBase(
        Number(outbound.id),
        masterBarcodeBase,
      );
    }

    if (!candidates.length) {
      candidates = await findCandidateGoodsOutItemsByScannedBarcode(
        Number(outbound.id),
        scannedBarcodeBase,
      );
    }

    if (!candidates.length) {
      throw badRequest(`ไม่พบสินค้าใน outbound สำหรับ barcode: ${barcode}`);
    }

    let matched: any = null;
    let parsedResult: any = null;

    for (const item of candidates) {
      if (item.product_id == null) continue;

      if (
        masterBc?.product_id != null &&
        Number(masterBc.product_id) !== Number(item.product_id)
      ) {
        continue;
      }

      const parsedRaw = masterBc
        ? parseScannedBarcodeByMasterMeta({
            scannedBarcode: barcode,
            masterBarcode: String(masterBc.barcode ?? ""),
            lot_start: masterBc.lot_start,
            lot_stop: masterBc.lot_stop,
            exp_start: masterBc.exp_start,
            exp_stop: masterBc.exp_stop,
          })
        : parseScannedBarcodeByBaseBarcode(
            barcode,
            String(item.barcode_text ?? ""),
          );

      const parsed: any = parsedRaw;

      const lotMatched = lotMatchedNullable(item.lot_serial, parsed.lot_serial);

      const stockExp = await findStockExpByProductLot(
        Number(item.product_id),
        item.lot_id ?? null,
      );

      const expMatched = expMatchedNullable(
        stockExp,
        parsed.exp ?? null,
        parsed.exp_text,
      );

      if (!lotMatched) continue;
      if (!expMatched) continue;

      const parsedBarcodeText =
        parsed.barcode_text ?? item.barcode_text ?? barcode;

      const parsedExpText = parsed.exp_text ?? "999999";

      const fallbackNormalizedScan = `${parsedBarcodeText}${
        parsed.lot_serial ?? ""
      }${parsedExpText !== "999999" ? parsedExpText : ""}`;

      matched = item;
      parsedResult = {
        barcode_text: parsedBarcodeText,
        lot_serial: parsed.lot_serial ?? null,
        exp_text: parsedExpText,
        exp: parsed.exp ?? null,
        normalized_scan: parsed.normalized_scan ?? fallbackNormalizedScan,
        matched_by: parsed.matched_by ?? (masterBc ? "FIXED_META" : "BASE"),
      };
      break;
    }

    if (!matched || !parsedResult) {
      throw badRequest(
        `ไม่พบสินค้าใน outbound ที่ตรงกับ barcode_text + lot_serial + exp สำหรับ barcode: ${barcode}`,
      );
    }

    const saved = await prisma.$transaction(async (tx) => {
      const freshItem = await tx.goods_out_item.findUnique({
        where: { id: Number(matched.id) },
        select: {
          id: true,
          outbound_id: true,
          product_id: true,
          lot_id: true,
          lot_serial: true,
          code: true,
          name: true,
          unit: true,
          qty: true,
          pick: true,
          confirmed_pick: true,
          return: true,
          return_check: true,
          barcode_text: true,
          deleted_at: true,
        } as any,
      });

      if (!freshItem || freshItem.deleted_at) {
        throw badRequest("ไม่พบ goods_out_item ที่ต้องการคืน");
      }

      let maxReturnable = 0;

      if (isPdReturnMode) {
        const baseQty = Number((freshItem as any).qty ?? 0);
        const pickQty = Number((freshItem as any).pick ?? 0);
        const currentReturn = Number((freshItem as any).return ?? 0);

        const pdQty = await getPdQtyForGoodsOutItem(tx, outbound, freshItem);

        const effectiveQty = Math.max(0, baseQty - pdQty);

        maxReturnable = Math.max(0, pickQty - effectiveQty - currentReturn);
      } else {
        maxReturnable = Math.max(
          0,
          Number((freshItem as any).confirmed_pick ?? 0) -
            Number((freshItem as any).return ?? 0),
        );
      }

      if (qty > maxReturnable) {
        throw badRequest(
          `จำนวนคืนเกินกว่าที่คืนได้ item=${freshItem.id}, return ได้สูงสุด ${maxReturnable}`,
        );
      }

      const updatedItem = await tx.goods_out_item.update({
        where: { id: Number(freshItem.id) },
        data: {
          return: {
            increment: qty,
          },
          return_check: false,
          updated_at: new Date(),
        } as any,
      });

      await (tx as any).goods_out_item_location_return.upsert({
        where: {
          uniq_goi_return_location: {
            goods_out_item_id: Number(freshItem.id),
            location_id: Number(location.id),
          },
        },
        update: {
          return: {
            increment: qty,
          },
          updated_at: new Date(),
        },
        create: {
          goods_out_item_id: Number(freshItem.id),
          location_id: Number(location.id),
          return: qty,
        },
      });

      return {
        updatedItem,
        appliedQty: qty,
      };
    });

    const detail = await buildOutboundDetail(
      Number(outbound.id),
      no,
      Number(location.id),
    );

    const matchedLine =
      detail.lines.find((l: any) => Number(l.id) === Number(matched.id)) ??
      null;

    const payload = {
      message: "scan return สำเร็จ",
      ...detail,
      scanned: {
        barcode,
        barcode_text: parsedResult.barcode_text,
        lot_serial: parsedResult.lot_serial,
        exp: parsedResult.exp ? new Date(parsedResult.exp).toISOString() : null,
        normalized_scan: parsedResult.normalized_scan,
        matched_by: parsedResult.matched_by,
      },
      location: {
        location_id: location.id,
        location_name: location.full_name,
      },
      returnQty: saved.appliedQty,
      matchedLine,
      data: {
        outbound_id: outbound.id,
        outbound_no: outbound.no,
        goods_out_item_id: matched.id,
        product_id: matched.product_id,
        code: matched.code,
        name: matched.name,
        lot_id: matched.lot_id,
        lot_serial: matched.lot_serial,
        qty_return_added: saved.appliedQty,
        location_id: location.id,
        location_full_name: location.full_name,
      },
    };

    emitOutboundRealtime(
      no,
      "outbound:scan_return",
      payload,
      Number(outbound.id),
    );

    return res.json(payload);
  },
);
/**
 * =========================
 * Confirm Pick -> Decrement Stock
 * =========================
 */

export type ConfirmOutboundPickBody = {
  location_full_name?: string;
  user_pick?: string | null;
  user_ref?: string | null;
  lines?: Array<{
    goods_out_item_id: number | string;
    location_full_name?: string;
    pick?: number | string; // รับไว้เผื่อ FE เก่า แต่ backend จะ ignore
  }>;
  locations?: Array<{
    location_full_name?: string;
    lines?: Array<{
      goods_out_item_id: number | string;
      location_full_name?: string;
      pick?: number | string; // รับไว้เผื่อ FE เก่า แต่ backend จะ ignore
    }>;
  }>;
};

type ReturnPickType = "RTC" | "BOR";

function getReturnPickType(raw: any): ReturnPickType {
  const type = String(raw || "RTC")
    .trim()
    .toUpperCase();

  if (type !== "RTC" && type !== "BOR") {
    throw badRequest("type ต้องเป็น RTC หรือ BOR");
  }

  return type as ReturnPickType;
}

function getReturnPickConfig(type: ReturnPickType) {
  if (type === "BOR") {
    return {
      type,
      source: "bor",
      qtyField: "bor",
      checkField: "bor_check",
      locationModel: "goods_out_item_location_bor",
      locationQtyField: "bor",
      uniqueKeyName: "uniq_goi_bor_location",
      scanEvent: "outbound:scan_bor_return_pick",
      confirmEvent: "outbound:confirm_bor_to_stock",
    };
  }

  return {
    type,
    source: "rtc",
    qtyField: "rtc",
    checkField: "rtc_check",
    locationModel: "goods_out_item_location_rtc",
    locationQtyField: "rtc",
    uniqueKeyName: "uniq_goi_rtc_location",
    scanEvent: "outbound:scan_rtc_return_pick",
    confirmEvent: "outbound:confirm_rtc_to_stock",
  };
}

export const scanOutboundRtcReturnPick = asyncHandler(
  async (req: Request, res: Response) => {
    const no = String(req.params.no || "").trim();
    const barcode = String(req.body?.barcode || "").trim();
    const location_full_name = String(
      req.body?.location_full_name || "",
    ).trim();

    const qtyInputRaw = req.body?.qty_input;

    const qtyInput =
      qtyInputRaw == null || qtyInputRaw === "" ? 1 : Number(qtyInputRaw);

    if (!no) throw badRequest("no is required");
    if (!barcode) throw badRequest("barcode is required");
    if (!location_full_name) {
      throw badRequest("location_full_name is required");
    }

    if (!Number.isFinite(qtyInput) || qtyInput <= 0) {
      throw badRequest("qty_input ต้องมากกว่า 0");
    }

    const qty = Math.max(1, Math.floor(qtyInput));

    const outbound = await prisma.outbound.findFirst({
      where: {
        no,
        deleted_at: null,
      } as any,
      select: {
        id: true,
        no: true,
      },
    });

    if (!outbound) {
      throw notFound("outbound not found");
    }

    const location = await resolveLocationByFullNameBasic(location_full_name);

    const masterBc = await findMasterBarcodeForScan(barcode);

    const masterBarcodeBase = masterBc
      ? normalizeBarcodeBaseForMatch(masterBc.barcode ?? "")
      : "";

    const scannedBarcodeBase = normalizeBarcodeBaseForMatch(barcode);

    let candidates: any[] = [];

    if (masterBarcodeBase) {
      candidates = await findCandidateGoodsOutItemsByBarcodeBase(
        Number(outbound.id),
        masterBarcodeBase,
      );
    }

    if (!candidates.length) {
      candidates = await findCandidateGoodsOutItemsByScannedBarcode(
        Number(outbound.id),
        scannedBarcodeBase,
      );
    }

    if (!candidates.length) {
      throw badRequest(`ไม่พบสินค้าใน outbound สำหรับ barcode: ${barcode}`);
    }

    let matched: any = null;
    let parsedResult: any = null;

    for (const item of candidates) {
      if (item.product_id == null) continue;

      const parsed = masterBc
        ? parseScannedBarcodeByMasterMeta({
            scannedBarcode: barcode,
            masterBarcode: String(masterBc.barcode ?? ""),
            lot_start: masterBc.lot_start,
            lot_stop: masterBc.lot_stop,
            exp_start: masterBc.exp_start,
            exp_stop: masterBc.exp_stop,
          })
        : parseScannedBarcodeByBaseBarcode(
            barcode,
            String(item.barcode_text ?? ""),
          );

      const lotMatched = lotMatchedNullable(item.lot_serial, parsed.lot_serial);

      const stockExp = await findStockExpByProductLot(
        item.product_id,
        item.lot_id ?? null,
      );

      const expMatched = expMatchedNullable(
        stockExp,
        parsed.exp ?? null,
        parsed.exp_text,
      );

      if (!lotMatched) continue;
      if (!expMatched) continue;

      matched = item;
      parsedResult = parsed;
      break;
    }

    if (!matched || !parsedResult) {
      throw badRequest(`ไม่พบสินค้าใน outbound ที่ตรงกับ barcode`);
    }

    const saved = await prisma.$transaction(async (tx) => {
      const freshItem = await tx.goods_out_item.findUnique({
        where: {
          id: Number(matched.id),
        },
      });

      if (!freshItem || freshItem.deleted_at) {
        throw badRequest("goods_out_item not found");
      }

      const targetRtcQty = Math.max(0, Number((freshItem as any).rtc ?? 0));

      const scannedRtcRows = await (
        tx as any
      ).goods_out_item_location_rtc.findMany({
        where: {
          goods_out_item_id: Number(freshItem.id),
        },
      });

      const alreadyScannedRtc = scannedRtcRows.reduce(
        (sum: number, row: any) => sum + Number(row.rtc ?? 0),
        0,
      );

      const maxRtc = Math.max(0, targetRtcQty - alreadyScannedRtc);

      if (qty > maxRtc) {
        throw badRequest(`rtc ได้สูงสุด ${maxRtc}`);
      }

      // ✅ ไม่ increment goods_out_item.rtc ซ้ำ
      // เพราะ RTC/BOR ถูกส่งมาแล้ว และ rtc คือจำนวนที่ต้อง return
      const updated = await tx.goods_out_item.update({
        where: {
          id: Number(freshItem.id),
        },
        data: {
          rtc_check: false,
          updated_at: new Date(),
        } as any,
      });

      await (tx as any).goods_out_item_location_rtc.upsert({
        where: {
          uniq_goi_rtc_location: {
            goods_out_item_id: Number(freshItem.id),
            location_id: Number(location.id),
          },
        },
        update: {
          rtc: {
            increment: qty,
          },
          updated_at: new Date(),
        },
        create: {
          goods_out_item_id: Number(freshItem.id),
          location_id: Number(location.id),
          rtc: qty,
        },
      });

      return updated;
    });

    emitOutboundRealtime(
      no,
      "outbound:scan_rtc_return_pick",
      {
        outbound_no: no,
        goods_out_item_id: matched.id,
        rtc_added: qty,
      },
      Number(outbound.id),
    );

    return res.json({
      success: true,
      message: "scan rtc return pick success",
      rtc_added: qty,
      goods_out_item_id: matched.id,
      data: saved,
    });
  },
);

const confirmKey = (goods_out_item_id: number, location_id: number) =>
  `goi:${goods_out_item_id}|loc:${location_id}`;

async function resolveBorSerVirtualLocation(
  tx: Prisma.TransactionClient,
  input: {
    location_dest_id?: number | null;
    location_dest?: string | null;
  },
) {
  if (typeof input.location_dest_id === "number") {
    const row = await tx.location.findUnique({
      where: { id: input.location_dest_id },
      select: {
        id: true,
        full_name: true,
        deleted_at: true,
      },
    });

    if (row && !row.deleted_at) {
      return {
        location_id: row.id,
        location_name: row.full_name,
      };
    }
  }

  const fallbackName = String(input.location_dest ?? "").trim();
  return {
    location_id: input.location_dest_id ?? null,
    location_name: fallbackName || null,
  };
}

export const confirmOutboundPickToStock = asyncHandler(
  async (req: Request<{ no: string }>, res: Response) => {
    const no = decodeURIComponent(String(req.params.no || "")).trim();

    if (!no) {
      throw badRequest("ไม่พบเลข Outbound");
    }

    const user_ref_raw = (req.body as any)?.user_ref;
    const user_ref =
      user_ref_raw == null ? null : String(user_ref_raw).trim() || null;

    const outbound = await prisma.outbound.findFirst({
      where: {
        no,
        deleted_at: null,
      },
      select: {
        id: true,
        no: true,
      },
    });

    if (!outbound) {
      throw badRequest("ไม่พบ Outbound");
    }

    const result = await prisma.$transaction(async (tx) => {
      const items = await tx.goods_out_item.findMany({
        where: {
          outbound_id: outbound.id,
          deleted_at: null,
        },
        select: {
          id: true,
          qty: true,
          pick: true,
          confirmed_pick: true,
        },
      });

      if (items.length === 0) {
        throw badRequest("ไม่พบรายการสินค้าใน Outbound");
      }

      let updatedItems = 0;

      for (const item of items) {
        const qty = Math.max(0, Math.floor(Number(item.qty ?? 0)));
        const pick = Math.max(0, Math.floor(Number(item.pick ?? 0)));
        const confirmedPick = Math.max(
          0,
          Math.floor(Number(item.confirmed_pick ?? 0)),
        );

        if (pick <= 0 || confirmedPick >= pick) {
          continue;
        }

        await tx.goods_out_item.update({
          where: { id: item.id },
          data: {
            confirmed_pick: pick,
            in_process: pick >= qty,
            status: pick >= qty ? "completed" : "process",
            user_pick: user_ref,
            pick_time: new Date(),
            updated_at: new Date(),
          } as any,
        });

        updatedItems++;
      }

      const notCompletedCount = await tx.goods_out_item.count({
        where: {
          outbound_id: outbound.id,
          deleted_at: null,
          OR: [
            { status: { not: "completed" } },
            { in_process: false },
          ],
        } as any,
      });

      const outboundCompleted = notCompletedCount === 0;

      await tx.outbound.update({
        where: { id: outbound.id },
        data: {
          in_process: outboundCompleted,
          updated_at: new Date(),
        } as any,
      });

      await tx.batch_outbound.updateMany({
        where: {
          outbound_id: outbound.id,
        },
        data: {
          status: outboundCompleted ? "completed" : "process",
          released_at: outboundCompleted ? new Date() : null,
          updated_at: new Date(),
        } as any,
      });

      return {
        updatedItems,
        outboundCompleted,
      };
    });

    // ✅ สำคัญ: ส่ง queue เปลี่ยน lot กลับ Odoo หลัง DB transaction สำเร็จ
    // helper นี้จะจัดการ outbound_lot_adjustment, adjust_lot_log, env Odoo ให้เอง
    const odooLotAdjustment =
      await sendQueuedOutboundLotAdjustmentsToOdoo({
        outbound: {
          id: outbound.id,
          no: outbound.no,
        },
        reqOriginalUrl: req.originalUrl,
      });

    emitOutboundRealtime(
      outbound.no,
      "outbound:confirm_pick",
      {
        message: "confirm pick สำเร็จ",
        outbound_no: outbound.no,
        user_ref,
        ...result,
        odoo_lot_adjustment: odooLotAdjustment,
      },
      outbound.id,
    );

    return res.json({
      success: true,
      message: "confirm pick สำเร็จ",
      outbound_no: outbound.no,
      user_ref,
      ...result,
      odoo_lot_adjustment: odooLotAdjustment,
    });
  },
);

function buildStockBucketKey(args: {
  source?: string | null;
  product_id: number;
  location_id?: number | null;
  lot_id?: number | null;
  lot_name?: string | null;
  expiration_date?: Date | string | null;
}) {
  const source = String(args.source ?? "wms")
    .trim()
    .toLowerCase();
  const productId = Number(args.product_id || 0);
  const locationId =
    args.location_id == null ? "null" : String(args.location_id);
  const lotId = args.lot_id == null ? "null" : String(args.lot_id);
  const lotName = String(args.lot_name ?? "")
    .trim()
    .toLowerCase();

  const exp = args.expiration_date
    ? new Date(args.expiration_date).toISOString().slice(0, 10)
    : "null";

  return [
    source,
    `p:${productId}`,
    `loc:${locationId}`,
    `lotid:${lotId}`,
    `lot:${lotName || "null"}`,
    `exp:${exp}`,
  ].join("|");
}

async function decreaseStockFromOutboundPickTx(
  tx: any,
  args: {
    item: {
      product_id: number;
      code?: string | null;
      name?: string | null;
      unit?: string | null;
      lot_id?: number | null;
      lot_serial?: string | null;
      exp?: Date | string | null;
    };
    location: {
      id: number;
      full_name: string;
    };
    qty: number;
  },
) {
  const qty = Number(args.qty || 0);
  if (qty <= 0) return;

  const stock = await tx.stock.findFirst({
    where: {
      product_id: args.item.product_id,
      location_id: args.location.id,
      lot_id: args.item.lot_id ?? null,
      lot_serial: args.item.lot_serial ?? null,
    } as any,
    orderBy: [{ id: "asc" }],
  });

  if (!stock) {
    throw badRequest(
      `ไม่พบ stock สำหรับ location=${args.location.full_name}, product_id=${args.item.product_id}`,
    );
  }

  const currentQty = Number(stock.quantity ?? 0);

  if (currentQty < qty) {
    throw badRequest(
      `stock ไม่พอสำหรับ confirm pick location=${args.location.full_name}, current=${currentQty}, need=${qty}`,
    );
  }

  await tx.stock.update({
    where: { id: stock.id },
    data: {
      quantity: {
        decrement: qty,
      },
      updated_at: new Date(),
    } as any,
  });
}

export const confirmOutboundReturn = asyncHandler(
  async (req: Request, res: Response) => {
    const no = String(req.params.no || "");

    if (!no) throw badRequest("no is required");

    const outbound = await prisma.outbound.findFirst({
      where: { no, deleted_at: null } as any,
    });

    if (!outbound) throw notFound("outbound not found");

    const items = await prisma.goods_out_item.findMany({
      where: {
        outbound_id: outbound.id,
        deleted_at: null,
        return: { gt: 0 },
        return_check: false,
      },
      orderBy: [{ id: "asc" }],
    });

    if (!items.length) {
      throw badRequest("ไม่พบรายการ return ที่รอ confirm");
    }

    let updatedPDInboundCount = 0;

    await prisma.$transaction(async (tx) => {
      for (const item of items) {
        const returnRows = await (
          tx as any
        ).goods_out_item_location_return.findMany({
          where: {
            goods_out_item_id: item.id,
            return: { gt: 0 },
          },
          orderBy: [{ id: "asc" }],
        });

        if (!returnRows.length) continue;

        const fallback = await resolveFallbackLotExpForOutboundReturnTx(tx, {
          product_id: Number(item.product_id || 0),
          lot_id: item.lot_id ?? null,
          lot_serial: item.lot_serial ?? null,
          exp: null,
        });

        for (const row of returnRows) {
          const returnQty = Number(row.return || 0);
          if (returnQty <= 0) continue;

          const location = await tx.location.findUnique({
            where: { id: row.location_id },
            select: { id: true, full_name: true },
          });

          if (!location) {
            throw badRequest(`ไม่พบ location id=${row.location_id}`);
          }

          await increaseStockFromOutboundReturnTx(tx, {
            item: {
              product_id: Number(item.product_id || 0),
              code: item.code ?? null,
              name: item.name ?? null,
              unit: item.unit ?? null,
              lot_id: item.lot_id ?? null,
              lot_serial: fallback.lot_serial,
              exp: fallback.exp,
            },
            location: {
              id: location.id,
              full_name: location.full_name,
            },
            qty: returnQty,
          });
        }

        await tx.goods_out_item.update({
          where: { id: item.id },
          data: {
            return_check: true,
            updated_at: new Date(),
          },
        });
      }

      // ✅ Complete related PD inbound
      const outboundOrigin = String((outbound as any).origin ?? "").trim();
      const outboundInvoice = String((outbound as any).invoice ?? "").trim();

      const refs = Array.from(
        new Set([outboundOrigin, outboundInvoice].filter(Boolean)),
      );

      if (refs.length > 0) {
        const updatedPD = await tx.inbound.updateMany({
          where: {
            deleted_at: null,
            in_type: "PD",
            status: { not: "completed" },
            OR: refs.map((ref) => ({
              origin: {
                equals: ref,
                mode: "insensitive",
              },
            })),
          },
          data: {
            status: "completed",
            updated_at: new Date(),
          },
        });

        updatedPDInboundCount = updatedPD.count;
      }
    });

    return res.json({
      success: true,
      message: "confirm return สำเร็จ",
      pd_inbound_completed_count: updatedPDInboundCount,
    });
  },
);

export const confirmRTCtoStock = asyncHandler(
  async (req: Request, res: Response) => {
    const no = String(req.params.no || "").trim();
    const returnType = getReturnPickType(req.body?.type);
    const config = getReturnPickConfig(returnType);

    if (!no) throw badRequest("no is required");

    const outbound = await prisma.outbound.findFirst({
      where: {
        no,
        deleted_at: null,
      } as any,
    });

    if (!outbound) throw notFound("outbound not found");

    const returnItems = await prisma.goods_out_item.findMany({
      where: {
        outbound_id: outbound.id,
        deleted_at: null,
        [config.qtyField]: { gt: 0 },
        [config.checkField]: false,
      } as any,
      orderBy: [{ id: "asc" }],
    });

    if (!returnItems.length) {
      throw badRequest(`ไม่พบ ${config.source} ที่รอ confirm`);
    }

    const result = await prisma.$transaction(async (tx) => {
      let stockDecreased = 0;
      let stockIncreased = 0;
      let deletedLocationPick = 0;
      let softDeletedGoodsOutItem = 0;
      let deletedBatchOutbound = 0;

      const allItemIds = (
        await tx.goods_out_item.findMany({
          where: {
            outbound_id: Number(outbound.id),
            deleted_at: null,
          } as any,
          select: { id: true },
        })
      ).map((x) => Number(x.id));

      for (const item of returnItems as any[]) {
        const returnQty = Math.max(
          0,
          Math.floor(Number(item?.[config.qtyField] ?? 0)),
        );

        if (returnQty <= 0) continue;

        const locationModel = (tx as any)[config.locationModel];

        if (!locationModel?.findMany) {
          throw badRequest(`ไม่พบ model สำหรับ ${config.locationModel}`);
        }

        const returnRows = await locationModel.findMany({
          where: {
            goods_out_item_id: Number(item.id),
            [config.locationQtyField]: { gt: 0 },
          },
          orderBy: [{ id: "asc" }],
        });

        if (!returnRows.length) {
          throw badRequest(
            `ไม่พบ location ${config.source.toUpperCase()} ของ item=${item.id}`,
          );
        }

        const pickRows = await (
          tx as any
        ).goods_out_item_location_pick.findMany({
          where: {
            goods_out_item_id: Number(item.id),
            qty_pick: { gt: 0 },
          },
          orderBy: [{ id: "asc" }],
        });

        if (!pickRows.length) {
          throw badRequest(`ไม่พบ location pick เดิมของ item=${item.id}`);
        }

        const totalReturn = returnRows.reduce(
          (sum: number, r: any) =>
            sum + Number(r?.[config.locationQtyField] ?? 0),
          0,
        );

        const totalPick = pickRows.reduce(
          (sum: number, r: any) => sum + Number(r.qty_pick ?? 0),
          0,
        );

        if (totalReturn > totalPick) {
          throw badRequest(
            `จำนวน ${config.source.toUpperCase()} มากกว่า pick เดิม item=${item.id}, return=${totalReturn}, pick=${totalPick}`,
          );
        }

        let remainingToDecrease = totalReturn;

        for (const pickRow of pickRows as any[]) {
          if (remainingToDecrease <= 0) break;

          const pickQty = Math.max(
            0,
            Math.floor(Number(pickRow.qty_pick ?? 0)),
          );
          const moveQty = Math.min(pickQty, remainingToDecrease);

          if (moveQty <= 0) continue;

          const oldStock = await tx.stock.findFirst({
            where: {
              source: "wms",
              active: true,
              product_id: Number(item.product_id || 0),
              location_id: Number(pickRow.location_id),
              lot_name: item.lot_serial ?? null,
            } as any,
            orderBy: [{ id: "desc" }],
          });

          if (!oldStock) {
            throw badRequest(
              `ไม่พบ stock location เดิม item=${item.id}, location_id=${pickRow.location_id}, lot=${item.lot_serial}`,
            );
          }

          const oldQty = Number(oldStock.quantity ?? 0);

          if (oldQty < moveQty) {
            throw badRequest(
              `stock location เดิมไม่พอ item=${item.id}, current=${oldQty}, need=${moveQty}`,
            );
          }

          await tx.stock.update({
            where: {
              id: Number(oldStock.id),
            },
            data: {
              quantity: {
                decrement: new Prisma.Decimal(moveQty),
              },
              updated_at: new Date(),
            } as any,
          });

          stockDecreased += moveQty;
          remainingToDecrease -= moveQty;
        }

        if (remainingToDecrease > 0) {
          throw badRequest(
            `ตัด stock location เดิมไม่ครบ item=${item.id}, remain=${remainingToDecrease}`,
          );
        }

        for (const row of returnRows as any[]) {
          const qty = Math.max(
            0,
            Math.floor(Number(row?.[config.locationQtyField] ?? 0)),
          );

          if (qty <= 0) continue;

          const location = await tx.location.findUnique({
            where: {
              id: Number(row.location_id),
            },
            select: {
              id: true,
              full_name: true,
            },
          });

          if (!location) {
            throw badRequest(
              `ไม่พบ location ${config.source.toUpperCase()} id=${row.location_id}`,
            );
          }

          await increaseStockFromOutboundReturnTx(tx, {
            item: {
              product_id: Number(item.product_id || 0),
              code: item.code ?? null,
              name: item.name ?? null,
              unit: item.unit ?? null,
              lot_id: item.lot_id ?? null,
              lot_serial: item.lot_serial ?? null,
              exp: null,
            },
            location: {
              id: Number(location.id),
              full_name: location.full_name,
            },
            qty,
          });

          stockIncreased += qty;
        }

        await tx.goods_out_item.update({
          where: {
            id: Number(item.id),
          },
          data: {
            [config.checkField]: true,
            deleted_at: new Date(),
            updated_at: new Date(),
          } as any,
        });

        softDeletedGoodsOutItem++;
      }

      if (allItemIds.length > 0) {
        const delPick = await (
          tx as any
        ).goods_out_item_location_pick.deleteMany({
          where: {
            goods_out_item_id: {
              in: allItemIds,
            },
          },
        });

        deletedLocationPick = Number(delPick.count ?? 0);

        const delItems = await tx.goods_out_item.updateMany({
          where: {
            id: {
              in: allItemIds,
            },
          },
          data: {
            deleted_at: new Date(),
            updated_at: new Date(),
          } as any,
        });

        softDeletedGoodsOutItem = Number(
          delItems.count ?? softDeletedGoodsOutItem,
        );
      }

      const delBatch = await tx.batch_outbound.deleteMany({
        where: {
          outbound_id: Number(outbound.id),
        },
      });

      deletedBatchOutbound = Number(delBatch.count ?? 0);

      await tx.pack_product_outbound.deleteMany({
        where: {
          outbound_id: Number(outbound.id),
        },
      });

      await tx.outbound.update({
        where: {
          id: Number(outbound.id),
        },
        data: {
          deleted_at: new Date(),
          updated_at: new Date(),
        } as any,
      });

      return {
        type: returnType,
        source: config.source,
        stockDecreased,
        stockIncreased,
        deletedLocationPick,
        softDeletedGoodsOutItem,
        deletedBatchOutbound,
      };
    });

    emitOutboundRealtime(
      no,
      config.confirmEvent,
      {
        outbound_no: no,
        ...result,
      },
      Number(outbound.id),
    );

    return res.json({
      success: true,
      message: `confirm ${config.source.toUpperCase()} to stock success`,
      outbound_no: no,
      ...result,
    });
  },
);
