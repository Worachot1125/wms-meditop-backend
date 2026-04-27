import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";
import { io } from "../index";

import {
  handleScanLocationCommon,
  resolveLocationByFullNameWithZone,
} from "../utils/helper_scan/location";

import {
  normalizeScanText,
  toDateOnlyKey,
  sameDateOnly,
  resolveBarcodeScan,
  findMasterBarcodeForScan,
} from "../utils/helper_scan/barcode";

async function resolveLocationByFullName(full_name: string) {
  const loc = await prisma.location.findFirst({
    where: { full_name, deleted_at: null },
    select: {
      id: true,
      full_name: true,
      ignore: true,
      zone: {
        select: {
          id: true,
          short_name: true,
          full_name: true,
          zone_type: {
            select: {
              id: true,
              short_name: true,
              full_name: true,
            },
          },
        },
      },
    },
  });

  if (!loc) throw badRequest(`ไม่พบ location full_name: ${full_name}`);
  return loc;
}

/**
 * =========================
 * ✅ Item matching policy (NEW)
 * ใช้เช็คด้วย: product_id + lot_serial(lot_name)
 * ไม่ใช้ lot_id แล้ว
 * =========================
 */
function normalizeLotName(v: any): string {
  return String(v ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function lotNameOf(input: { lot_serial?: any; lot_name?: any; lot?: any }) {
  const a = normalizeLotName(input.lot_serial);
  if (a) return a;
  const b = normalizeLotName(input.lot_name);
  if (b) return b;
  const c = normalizeLotName(input.lot);
  return c;
}

/**
 * ✅ resolve input_number แบบ "อิง ctl เก่า"
 * - ctl เก่าเช็ค product_id (+ lot_id ถ้ามี)
 * - requirement ใหม่: เอา lot_id ออกจากการเช็ค => เหลือเช็คแค่ product_id
 */
async function resolveInputNumberByLotName(
  product_id: number,
  _lot_name: string | null,
) {
  const row = await prisma.wms_mdt_goods.findFirst({
    where: {
      product_id,
    },
    select: { input_number: true },
    orderBy: { id: "desc" },
  });

  return row?.input_number ?? false;
}
function normalizeZoneTypeText(v: unknown): string {
  return String(v ?? "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
}

async function resolveGoodsZoneTypeByProductId(product_id: number) {
  const row = await prisma.wms_mdt_goods.findFirst({
    where: { product_id },
    select: {
      zone_type: true,
    },
    orderBy: { id: "desc" },
  });

  return row?.zone_type ?? null;
}

async function assertInboundScanZoneTypeAllowed(input: {
  product_id: number;
  location: {
    id: number;
    full_name: string;
    ignore?: boolean | null;
    zone?: {
      id: number;
      short_name?: string | null;
      full_name?: string | null;
      zone_type?: {
        id: number;
        short_name?: string | null;
        full_name?: string | null;
      } | null;
    } | null;
  };
}) {
  const { product_id, location } = input;

  // ✅ ignore = true => ข้ามเช็คทั้งหมด
  if (Boolean(location.ignore)) {
    return {
      allowed: true,
      reason: "LOCATION_IGNORE_TRUE",
      location_zone_type: null,
      goods_zone_type: null,
    };
  }

  const locationZoneTypeShortNameRaw =
    location?.zone?.zone_type?.short_name ?? null;

  const locationZoneTypeShortName = normalizeZoneTypeText(
    locationZoneTypeShortNameRaw,
  );

  if (!locationZoneTypeShortName) {
    throw badRequest(
      `Location "${location.full_name}" ไม่มี zone_type.short_name สำหรับใช้ตรวจสอบ`,
    );
  }

  const goodsZoneTypeRaw = await resolveGoodsZoneTypeByProductId(product_id);
  const goodsZoneType = normalizeZoneTypeText(goodsZoneTypeRaw);

  if (!goodsZoneType) {
    throw badRequest(
      `ไม่พบ zone_type ใน wms_mdt_goods สำหรับ product_id=${product_id}`,
    );
  }

  if (goodsZoneType !== locationZoneTypeShortName) {
    throw badRequest(
      `ไม่สามารถ scan ได้: zone_type ของ Location = ${locationZoneTypeShortNameRaw ?? "-"} แต่สินค้า product_id=${product_id} มี zone_type = ${goodsZoneTypeRaw ?? "-"}`,
    );
  }

  return {
    allowed: true,
    reason: "ZONE_TYPE_MATCHED",
    location_zone_type: locationZoneTypeShortNameRaw,
    goods_zone_type: goodsZoneTypeRaw,
  };
}


async function buildInboundDetail(inboundId: number, inboundNo: string) {
  const inboundHeader = await prisma.inbound.findUnique({
    where: { id: inboundId },
    select: {
      id: true,
      no: true,
      department: true,
      origin: true,
      reference: true,
      status: true,
      in_type: true,
      updated_at: true,
      created_at: true,
    },
  });

  const rows = await prisma.goods_in.findMany({
    where: { inbound_id: inboundId, deleted_at: null },
    select: {
      id: true,
      sequence: true,
      product_id: true,
      code: true,
      name: true,
      unit: true,
      lot_id: true,
      lot: true,
      lot_serial: true,
      quantity_receive: true,
      quantity_count: true,
      in_process: true,
      barcode_id: true,
      barcode_text: true,
      zone_type: true,
      tracking: true,
      location_dest: true,
      user_ref: true,
      exp: true,
      created_at: true,
      updated_at: true,
      barcode: {
        select: {
          id: true,
          barcode: true,
          barcode_id: true,
          product_id: true,
          product_code: true,
          product_name: true,
          tracking: true,
        },
      },
      goods_in_location_confirms: {
        select: {
          id: true,
          location_id: true,
          confirmed_qty: true,
          updated_at: true,
          created_at: true,
          location: {
            select: {
              id: true,
              full_name: true,
            },
          },
        },
        orderBy: [{ location_id: "asc" }],
      },
    },
    orderBy: [{ sequence: "asc" }, { created_at: "asc" }],
  });

  const lines = rows.map((x) => {
    const r = Number(x.quantity_receive ?? 0);
    const c = Number(x.quantity_count ?? 0);
    const isConfirmed = Boolean(x.in_process);

    return {
      ...x,
      qty_receive: r,
      qty_count: c,
      remaining: Math.max(0, r - c),
      completed: r > 0 ? c >= r && isConfirmed : isConfirmed,
    };
  });

  const completed = lines.length > 0 && lines.every((l) => l.completed);

  return {
    inbound_no: inboundNo,
    id: inboundHeader?.id ?? inboundId,
    no: inboundHeader?.no ?? inboundNo,
    department: inboundHeader?.department ?? null,
    origin: inboundHeader?.origin ?? null,
    reference: inboundHeader?.reference ?? null,
    status: inboundHeader?.status ?? null,
    in_type: inboundHeader?.in_type ?? null,
    created_at: inboundHeader?.created_at ?? null,
    updated_at: inboundHeader?.updated_at ?? null,
    total_items: lines.length,
    completed,
    lines,
    items: lines,
    goods_ins: lines,
  };
}

function parseYYMMDDToDate(v: string | null | undefined): Date | null {
  const s = String(v ?? "").trim();
  if (!/^\d{6}$/.test(s) || s === "999999") return null;

  const yy = Number(s.slice(0, 2));
  const mm = Number(s.slice(2, 4));
  const dd = Number(s.slice(4, 6));

  const yyyy = yy >= 70 ? 1900 + yy : 2000 + yy;
  const d = new Date(Date.UTC(yyyy, mm - 1, dd));
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseScannedBarcodeByBaseBarcode(
  scannedBarcode: string,
  baseBarcodeText: string,
) {
  const raw = normalizeScanText(scannedBarcode);
  const base = normalizeScanText(baseBarcodeText);

  if (!raw.startsWith(base)) {
    return {
      barcode_text: base,
      lot_serial: null,
      exp_text: "999999",
      exp: null,
    };
  }

  const remain = raw.slice(base.length);

  if (remain.length < 6) {
    return {
      barcode_text: base,
      lot_serial: remain || null,
      exp_text: "999999",
      exp: null,
    };
  }

  const exp_text = remain.slice(-6);
  const lot_serial = remain.slice(0, -6) || null;

  return {
    barcode_text: base,
    lot_serial,
    exp_text,
    exp: parseYYMMDDToDate(exp_text),
  };
}

function emitInboundRealtime(
  no: string,
  event: string,
  payload: any,
  inboundId?: number | null,
) {
  try {
    const inboundNo = String(no ?? "").trim();

    if (inboundNo) io.to(`inbound:${inboundNo}`).emit(event, payload);

    const iid = Number(inboundId ?? NaN);
    if (Number.isFinite(iid) && iid > 0) {
      io.to(`inbound-id:${iid}`).emit(event, payload);
    }
  } catch {}
}

async function findCandidateGoodsInsByScannedBarcode(
  inboundId: number,
  scannedBarcode: string,
) {
  const rows = await prisma.goods_in.findMany({
    where: {
      inbound_id: inboundId,
      deleted_at: null,
      barcode_text: { not: null },
    },
    select: {
      id: true,
      product_id: true,
      lot_id: true,
      lot_serial: true,
      exp: true,
      quantity_receive: true,
      quantity_count: true,
      code: true,
      name: true,
      unit: true,
      barcode_text: true,
    },
    orderBy: [{ sequence: "asc" }, { created_at: "asc" }],
  });

  const raw = normalizeScanText(scannedBarcode);

  const matched = rows.filter((x) => {
    const base = normalizeScanText(x.barcode_text ?? "");
    return !!base && raw.startsWith(base);
  });

  matched.sort((a, b) => {
    const al = normalizeScanText(a.barcode_text ?? "").length;
    const bl = normalizeScanText(b.barcode_text ?? "").length;
    return bl - al;
  });

  return matched;
}

function isPositiveIndex(v: unknown): v is number {
  return Number.isInteger(v) && Number(v) > 0;
}

function isZeroLikeIndex(v: unknown): boolean {
  return Number(v ?? 0) === 0;
}

function safeSliceByOneBased(
  input: string,
  start?: number | null,
  stop?: number | null,
) {
  if (!isPositiveIndex(start) || !isPositiveIndex(stop) || stop < start) {
    return null;
  }

  const zeroStart = start - 1;
  const zeroStopExclusive = stop;

  if (zeroStart >= input.length) return null;
  return input.slice(zeroStart, Math.min(zeroStopExclusive, input.length));
}

function hasFixedLotExpMeta(
  meta?: {
    lot_start?: number | null;
    lot_stop?: number | null;
    exp_start?: number | null;
    exp_stop?: number | null;
  } | null,
) {
  if (!meta) return false;

  const lotZero =
    isZeroLikeIndex(meta.lot_start) && isZeroLikeIndex(meta.lot_stop);
  const expZero =
    isZeroLikeIndex(meta.exp_start) && isZeroLikeIndex(meta.exp_stop);

  if (lotZero && expZero) return false;

  return (
    isPositiveIndex(meta.lot_start) &&
    isPositiveIndex(meta.lot_stop) &&
    isPositiveIndex(meta.exp_start) &&
    isPositiveIndex(meta.exp_stop)
  );
}

function parseScannedBarcodeByMasterMeta(input: {
  scannedBarcode: string;
  masterBarcode: string;
  lot_start?: number | null;
  lot_stop?: number | null;
  exp_start?: number | null;
  exp_stop?: number | null;
}) {
  const raw = normalizeScanText(input.scannedBarcode);
  const master = normalizeScanText(input.masterBarcode);

  const useFixedMeta = hasFixedLotExpMeta({
    lot_start: input.lot_start,
    lot_stop: input.lot_stop,
    exp_start: input.exp_start,
    exp_stop: input.exp_stop,
  });

  // fallback logic เดิม
  if (!useFixedMeta) {
    return parseScannedBarcodeByBaseBarcode(raw, master);
  }

  // requirement: barcode พวกนี้ขึ้นต้นด้วย 01
  // และ barcode_text ที่จะเอาไปใช้คือค่าหลัง 01
  if (!raw.startsWith("01")) {
    return parseScannedBarcodeByBaseBarcode(raw, master);
  }

  const barcodeTextPart = raw.slice(2, master.length + 2);

  if (barcodeTextPart !== master) {
    return {
      barcode_text: master,
      lot_serial: null,
      exp_text: "999999",
      exp: null,
      normalized_scan: raw,
      matched_by: "FIXED_META",
    };
  }

  const lot_serial =
    safeSliceByOneBased(raw, input.lot_start ?? null, input.lot_stop ?? null) ??
    null;

  const exp_text =
    safeSliceByOneBased(raw, input.exp_start ?? null, input.exp_stop ?? null) ??
    "999999";

  return {
    barcode_text: barcodeTextPart,
    lot_serial,
    exp_text,
    exp: parseYYMMDDToDate(exp_text),
    normalized_scan: `${barcodeTextPart}${lot_serial ?? ""}${exp_text === "999999" ? "" : exp_text}`,
    matched_by: "FIXED_META",
  };
}


async function findCandidateGoodsInsByResolvedMasterBarcode(
  inboundId: number,
  masterBarcodeText: string,
) {
  const base = normalizeScanText(masterBarcodeText);

  const rows = await prisma.goods_in.findMany({
    where: {
      inbound_id: inboundId,
      deleted_at: null,
      barcode_text: { not: null },
    },
    select: {
      id: true,
      product_id: true,
      lot_id: true,
      lot_serial: true,
      exp: true,
      quantity_receive: true,
      quantity_count: true,
      code: true,
      name: true,
      unit: true,
      barcode_text: true,
    },
    orderBy: [{ sequence: "asc" }, { created_at: "asc" }],
  });

  return rows.filter((x) => normalizeScanText(x.barcode_text ?? "") === base);
}

async function createGoodsInScanHistoryTx(
  tx: Prisma.TransactionClient,
  input: {
    goods_in_id: string;
    inbound_id: number;
    location_id: number | null;
    location_full_name: string | null;
    action_type: "SCAN" | "EDIT_SET" | "CLEAR" | "UNDO";
    qty_delta: number;
    qty_before: number;
    qty_after: number;
    loc_qty_before: number;
    loc_qty_after: number;
    user_ref?: string | null;
    note?: string | null;
    undo_ref_history_id?: number | null;
  },
) {
  return tx.goods_in_scan_history.create({
    data: {
      goods_in_id: input.goods_in_id,
      inbound_id: input.inbound_id,
      location_id: input.location_id,
      location_full_name: input.location_full_name,
      action_type: input.action_type,
      qty_delta: input.qty_delta,
      qty_before: input.qty_before,
      qty_after: input.qty_after,
      loc_qty_before: input.loc_qty_before,
      loc_qty_after: input.loc_qty_after,
      user_ref: input.user_ref ?? null,
      note: input.note ?? null,
    },
    select: {
      id: true,
    },
  });
}

export const scanInboundLocation = asyncHandler(
  async (
    req: Request<{ no: string }, {}, { location_full_name: string }>,
    res: Response,
  ) => {
    const no = decodeURIComponent(req.params.no);

    const payload = await handleScanLocationCommon({
      docNo: no,
      locationFullName: req.body.location_full_name,
      loadDocument: () =>
        prisma.inbound.findUnique({
          where: { no },
          select: { id: true, no: true, deleted_at: true },
        }),
      resolveLocation: resolveLocationByFullNameWithZone,
      beforeBuildDetail: async ({ doc, location }) => {
        await prisma.$transaction(async (tx) => {
          await tx.inbound.update({
            where: { id: doc.id },
            data: {
              updated_at: new Date(),
            },
          });

          const goodsIns = await tx.goods_in.findMany({
            where: {
              inbound_id: doc.id,
              deleted_at: null,
            },
            select: { id: true },
          });

          for (const gi of goodsIns) {
            await tx.goods_in_location_confirm.upsert({
              where: {
                uniq_goodsin_location: {
                  goods_in_id: gi.id,
                  location_id: location.id,
                },
              },
              update: {},
              create: {
                goods_in_id: gi.id,
                location_id: location.id,
                confirmed_qty: 0,
              },
            });
          }
        });
      },
      buildDetail: ({ doc }) => buildInboundDetail(doc.id, doc.no),
      buildPayload: ({ location, detail }) => ({
        location: {
          location_id: location.id,
          location_name: location.full_name,
          ignore: Boolean(location.ignore),
          zone_short_name: location.zone?.short_name ?? null,
          zone_type_short_name: location.zone?.zone_type?.short_name ?? null,
        },
        ...detail,
      }),
      emitRealtime: (payload, doc) => {
        emitInboundRealtime(no, "inbound:scan_location", payload, doc.id);
      },
      notFoundMessage: `ไม่พบ inbound: ${no}`,
    });

    return res.json(payload);
  },
);

export const scanInboundBarcode = asyncHandler(
  async (
    req: Request<
      { no: string },
      {},
      {
        barcode: string;
        location_full_name: string;
        qty_input?: number;
        user_ref?: string;
      }
    >,
    res: Response,
  ) => {
    const no = decodeURIComponent(req.params.no);
    const barcodeText = String(req.body.barcode ?? "").trim();
    const location_full_name = String(req.body.location_full_name ?? "").trim();
    const user_ref = String(req.body.user_ref ?? "").trim() || null;

    if (!barcodeText) throw badRequest("กรุณาส่ง barcode");
    if (!location_full_name) throw badRequest("กรุณาส่ง location_full_name");

    const inbound = await prisma.inbound.findUnique({
      where: { no },
      select: { id: true, no: true, deleted_at: true },
    });
    if (!inbound || inbound.deleted_at) {
      throw notFound(`ไม่พบ inbound: ${no}`);
    }

    const loc = await resolveLocationByFullNameWithZone(location_full_name);

    const parsed = await resolveBarcodeScan(barcodeText);

    const masterBc = parsed.barcode_text
      ? await findMasterBarcodeForScan(parsed.barcode_text)
      : null;

    const candidates = parsed.barcode_text
      ? await findCandidateGoodsInsByResolvedMasterBarcode(
          inbound.id,
          String(parsed.barcode_text),
        )
      : await findCandidateGoodsInsByScannedBarcode(inbound.id, barcodeText);

    if (!candidates.length) {
      throw badRequest(`ไม่พบสินค้าใน inbound สำหรับ barcode: ${barcodeText}`);
    }

    const parsedLot = normalizeScanText(parsed.lot_serial ?? "");
    const parsedExpKey = toDateOnlyKey(parsed.exp ?? null);

    const scoreCandidate = (item: (typeof candidates)[number]) => {
      if (item.product_id == null) return -1;
      

      const itemLot = normalizeScanText(item.lot_serial ?? "");
      const itemExpKey = toDateOnlyKey(item.exp ?? null);

      let score = 0;

      // barcode candidate มาแล้ว ถือว่า base ตรงอยู่แล้ว
      score += 10;

      // lot
      if (parsedLot) {
        if (itemLot === parsedLot) {
          score += 100;
        } else {
          return -1;
        }
      } else {
        score += 1;
      }

      // exp
      if (parsedExpKey) {
        if (itemExpKey === parsedExpKey) {
          score += 50;
        } else {
          return -1;
        }
      } else {
        score += 1;
      }

      return score;
    };

    const ranked = candidates
      .map((item) => ({
        item,
        score: scoreCandidate(item),
      }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score);

    let matchedItem: (typeof candidates)[number] | null = null;

    if (ranked.length === 1) {
      matchedItem = ranked[0].item;
    } else if (ranked.length > 1) {
      const topScore = ranked[0].score;
      const topItems = ranked.filter((x) => x.score === topScore);

      if (topItems.length === 1) {
        matchedItem = topItems[0].item;
      } else {
        // tie-break: เลือกตัวที่ยังนับไม่ครบก่อน
        const incomplete = topItems.find((x) => {
          const receive = Number(x.item.quantity_receive ?? 0);
          const counted = Number(x.item.quantity_count ?? 0);
          return counted < receive;
        });

        if (incomplete) {
          matchedItem = incomplete.item;
        }
      }
    }

    if (!matchedItem) {
      throw badRequest(
        `ไม่พบสินค้าใน inbound ที่ตรงกับ barcode_text + lot_serial + exp สำหรับ barcode: ${barcodeText} (matched_by=${parsed.matched_by}, parsed_barcode=${parsed.barcode_text ?? "null"}, parsed_lot=${parsed.lot_serial ?? "null"}, parsed_exp=${parsedExpKey ?? "null"})`,
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
          barcode: true,
          lot_start: true,
          lot_stop: true,
          exp_start: true,
          exp_stop: true,
          barcode_length: true,
        },
      }));

    if (!matchedItem.product_id) {
      throw badRequest("goods_in.product_id เป็น null");
    }

    await assertInboundScanZoneTypeAllowed({
      product_id: matchedItem.product_id,
      location: loc,
    });

    const inputNumber = await resolveInputNumberByLotName(
      matchedItem.product_id,
      matchedItem.lot_serial ?? null,
    );

    let addQty = 1;

    if (inputNumber) {
      const rawQty = req.body.qty_input as unknown;

      if (rawQty == null) {
        addQty = 1;
      } else {
        const q = Number(rawQty);

        if (!Number.isFinite(q) || q <= 0) {
          throw badRequest("qty_input ต้องมากกว่า 0");
        }

        addQty = Math.floor(q);
      }
    }

    await prisma.$transaction(async (tx) => {
      const fresh = await tx.goods_in.findUnique({
        where: { id: matchedItem!.id },
        select: {
          id: true,
          quantity_receive: true,
          quantity_count: true,
          in_process: true,
        },
      });

      if (!fresh) {
        throw badRequest("ไม่พบ goods_in ที่ต้องการอัปเดต");
      }

      const receiveQty = Number(fresh.quantity_receive ?? 0);
      const currentCount = Number(fresh.quantity_count ?? 0);

      if (currentCount >= receiveQty) {
        throw badRequest("สินค้านี้สแกนครบจำนวนแล้ว");
      }

      const nextCount = currentCount + addQty;

      if (nextCount > receiveQty) {
        throw badRequest(
          `จำนวนสแกนเกิน quantity_receive (receive=${receiveQty}, current=${currentCount}, add=${addQty})`,
        );
      }

      const existingConfirm = await tx.goods_in_location_confirm.findUnique({
        where: {
          uniq_goodsin_location: {
            goods_in_id: fresh.id,
            location_id: loc.id,
          },
        },
        select: {
          confirmed_qty: true,
        },
      });

      const beforeLoc = Number(existingConfirm?.confirmed_qty ?? 0);
      const afterLoc = beforeLoc + addQty;

      await tx.goods_in.update({
        where: { id: fresh.id },
        data: {
          quantity_count: nextCount,
          in_process: nextCount < receiveQty,
          updated_at: new Date(),
          ...(user_ref ? { user_ref } : {}),
        },
      });

      await tx.goods_in_location_confirm.upsert({
        where: {
          uniq_goodsin_location: {
            goods_in_id: fresh.id,
            location_id: loc.id,
          },
        },
        update: {
          confirmed_qty: {
            increment: addQty,
          },
          updated_at: new Date(),
        },
        create: {
          goods_in_id: fresh.id,
          location_id: loc.id,
          confirmed_qty: addQty,
        },
      });

      await createGoodsInScanHistoryTx(tx, {
        goods_in_id: fresh.id,
        inbound_id: inbound.id,
        location_id: loc.id,
        location_full_name: loc.full_name,
        action_type: "SCAN",
        qty_delta: addQty,
        qty_before: currentCount,
        qty_after: nextCount,
        loc_qty_before: beforeLoc,
        loc_qty_after: afterLoc,
        user_ref,
        note: inputNumber
          ? `scan with qty_input (${parsed.matched_by})`
          : `scan barcode (${parsed.matched_by})`,
      });

      await tx.inbound.update({
        where: { id: inbound.id },
        data: {
          updated_at: new Date(),
        },
      });
    });

    const detail = await buildInboundDetail(inbound.id, no);

    const matchedLine =
      detail?.goods_ins?.find?.(
        (x: any) => String(x.id) === String(matchedItem!.id),
      ) ?? null;

    const payload = {
      ...detail,
      location: {
        location_id: loc.id,
        location_name: loc.full_name,
        ignore: Boolean(loc.ignore),
        zone_short_name: loc.zone?.short_name ?? null,
        zone_type_short_name: loc.zone?.zone_type?.short_name ?? null,
      },
      scanned: {
        barcode: parsed.raw_input,
        normalized_input: parsed.normalized_input,
        barcode_text: parsed.barcode_text,
        lot_serial: parsed.lot_serial,
        exp: parsed.exp ? parsed.exp.toISOString() : null,
        matched_by: parsed.matched_by,
      },
      barcode_meta: {
        lot_start: bc?.lot_start ?? null,
        lot_stop: bc?.lot_stop ?? null,
        exp_start: bc?.exp_start ?? null,
        exp_stop: bc?.exp_stop ?? null,
        barcode_length: bc?.barcode_length ?? null,
      },
      input_number: inputNumber,
      addQty:
        Number(matchedLine?.qty_count ?? matchedLine?.quantity_count ?? 0) -
        Number(matchedItem.quantity_count ?? 0),
      matchedLine,
    };

    emitInboundRealtime(no, "inbound:scan_barcode", payload, inbound.id);

    return res.json(payload);
  },
);

function parseUndoTargetHistoryId(
  note: string | null | undefined,
): number | null {
  const s = String(note ?? "").trim();
  if (!s) return null;

  const m = s.match(/undo history id=(\d+)/i);
  if (!m) return null;

  const id = Number(m[1]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

export const undoScanInboundBarcode = asyncHandler(
  async (
    req: Request<
      { no: string },
      {},
      { goods_in_id: string; location_full_name: string }
    >,
    res: Response,
  ) => {
    const no = decodeURIComponent(req.params.no);
    const goods_in_id = String(req.body.goods_in_id ?? "").trim();
    const location_full_name = String(req.body.location_full_name ?? "").trim();

    if (!goods_in_id) throw badRequest("กรุณาส่ง goods_in_id");
    if (!location_full_name) throw badRequest("กรุณาส่ง location_full_name");

    const inbound = await prisma.inbound.findUnique({
      where: { no },
      select: { id: true },
    });
    if (!inbound) throw notFound(`ไม่พบ inbound: ${no}`);

    const loc = await resolveLocationByFullNameWithZone(location_full_name);

    let beforeGoodsIn = 0;
    let afterGoodsIn = 0;
    let beforeLoc = 0;
    let afterLoc = 0;
    let undoneHistoryId: number | null = null;
    let undoActionType: string | null = null;

    await prisma.$transaction(async (tx) => {
      const goodsIn = await tx.goods_in.findFirst({
        where: {
          id: goods_in_id,
          inbound_id: inbound.id,
          deleted_at: null,
        },
        select: {
          id: true,
          quantity_count: true,
          quantity_receive: true,
        },
      });

      if (!goodsIn) throw badRequest("ไม่พบ goods_in");

      const confirmRow = await tx.goods_in_location_confirm.findUnique({
        where: {
          uniq_goodsin_location: {
            goods_in_id: goodsIn.id,
            location_id: loc.id,
          },
        },
        select: {
          confirmed_qty: true,
        },
      });

      const histories = await tx.goods_in_scan_history.findMany({
        where: {
          goods_in_id: goodsIn.id,
          inbound_id: inbound.id,
          location_id: loc.id,
        },
        orderBy: [{ id: "desc" }],
        select: {
          id: true,
          action_type: true,
          qty_before: true,
          qty_after: true,
          loc_qty_before: true,
          loc_qty_after: true,
          note: true,
          created_at: true,
        },
      });

      if (histories.length === 0) {
        throw badRequest("ไม่พบประวัติสำหรับ undo");
      }

      // หา action ที่เคยถูก undo ไปแล้วจาก note ของแถว UNDO
      const undoneTargetIds = new Set<number>();
      for (const h of histories) {
        if (String(h.action_type).toUpperCase() !== "UNDO") continue;
        const targetId = parseUndoTargetHistoryId(h.note);
        if (targetId) undoneTargetIds.add(targetId);
      }

      const latestHistory =
        histories.find((h) => {
          const t = String(h.action_type).toUpperCase();
          if (!["SCAN", "EDIT_SET", "CLEAR"].includes(t)) return false;
          return !undoneTargetIds.has(Number(h.id));
        }) ?? null;

      if (!latestHistory) {
        throw badRequest("ไม่พบประวัติที่ undo ได้แล้ว");
      }

      beforeGoodsIn = Number(goodsIn.quantity_count ?? 0);
      beforeLoc = Number(confirmRow?.confirmed_qty ?? 0);

      const targetGoodsIn = Number(latestHistory.qty_before ?? 0);
      const targetLoc = Number(latestHistory.loc_qty_before ?? 0);

      if (targetGoodsIn < 0 || targetLoc < 0) {
        throw badRequest("history สำหรับ undo ไม่ถูกต้อง");
      }

      afterGoodsIn = targetGoodsIn;
      afterLoc = targetLoc;
      undoneHistoryId = Number(latestHistory.id);
      undoActionType = String(latestHistory.action_type);

      await tx.goods_in.update({
        where: { id: goodsIn.id },
        data: {
          quantity_count: afterGoodsIn,
          in_process: afterGoodsIn < Number(goodsIn.quantity_receive ?? 0),
          updated_at: new Date(),
        },
      });

      if (afterLoc <= 0) {
        await tx.goods_in_location_confirm.deleteMany({
          where: {
            goods_in_id: goodsIn.id,
            location_id: loc.id,
          },
        });
      } else {
        await tx.goods_in_location_confirm.upsert({
          where: {
            uniq_goodsin_location: {
              goods_in_id: goodsIn.id,
              location_id: loc.id,
            },
          },
          update: {
            confirmed_qty: afterLoc,
            updated_at: new Date(),
          },
          create: {
            goods_in_id: goodsIn.id,
            location_id: loc.id,
            confirmed_qty: afterLoc,
          },
        });
      }

      await createGoodsInScanHistoryTx(tx, {
        goods_in_id: goodsIn.id,
        inbound_id: inbound.id,
        location_id: loc.id,
        location_full_name: loc.full_name,
        action_type: "UNDO",
        qty_delta: afterGoodsIn - beforeGoodsIn,
        qty_before: beforeGoodsIn,
        qty_after: afterGoodsIn,
        loc_qty_before: beforeLoc,
        loc_qty_after: afterLoc,
        note: `undo history id=${latestHistory.id} action=${latestHistory.action_type}`,
      });

      await tx.inbound.update({
        where: { id: inbound.id },
        data: {
          updated_at: new Date(),
        },
      });
    });

    const detail = await buildInboundDetail(inbound.id, no);

    const matchedLine =
      detail?.goods_ins?.find(
        (x: any) => String(x.id) === String(goods_in_id),
      ) ?? null;

    const payload = {
      ...detail,
      location: {
        location_id: loc.id,
        location_name: loc.full_name,
      },
      undo: {
        goods_in_id,
        history_id: undoneHistoryId,
        history_action_type: undoActionType,
        before_goods_in: beforeGoodsIn,
        after_goods_in: afterGoodsIn,
        before_location: beforeLoc,
        after_location: afterLoc,
      },
      matchedLine,
    };

    emitInboundRealtime(no, "inbound:scan_barcode", payload, inbound.id);

    return res.json(payload);
  },
);

function buildStockBucketKey(input: {
  source: string;
  product_id: number;
  product_code: string | null;
  lot_id: number | null;
  lot_name: string | null;
  location_id: number | null;
  expiration_date: Date | null;
}) {
  const exp = input.expiration_date
    ? input.expiration_date.toISOString().slice(0, 10)
    : "";

  const lotNameKey = lotNameOf({ lot_serial: input.lot_name });

  return [
    input.source,
    `p:${input.product_id}`,
    `code:${input.product_code ?? ""}`,
    `lotName:${lotNameKey}`,
    `loc:${input.location_id ?? 0}`,
    `exp:${exp}`,
  ].join("|");
}

/**
 * ✅ NEW Confirm payload (multi locations)
 */
export type ConfirmBody = {
  user_ref?: string | null;
  locations: Array<{
    location_full_name: string;
    lines: Array<{
      goods_in_id: string;
      quantity_count: number;
    }>;
  }>;
};

type ConfirmGoodsInRow = {
  id: string;
  product_id: number | null;
  lot_id: number | null;
  lot_serial: string | null;
  code: string | null;
  name: string;
  unit: string;
  exp: Date | null;
  quantity_receive: number | null;
  quantity_count: number | null;
  in_process: boolean | null;
  location_dest: string | null;
};

export const confirmInboundToStock = asyncHandler(
  async (req: Request<{ no: string }, {}, ConfirmBody>, res: Response) => {
    const no = decodeURIComponent(req.params.no);

    const user_ref_raw = req.body.user_ref;
    const user_ref =
      user_ref_raw == null ? null : String(user_ref_raw).trim() || null;

    const locations = Array.isArray(req.body.locations)
      ? req.body.locations
      : [];

    if (locations.length === 0) {
      throw badRequest("กรุณาส่ง locations อย่างน้อย 1 location");
    }

    for (const g of locations) {
      if (!Array.isArray(g.lines) || g.lines.length === 0) {
        throw badRequest("locations[].lines ต้องมีอย่างน้อย 1 รายการ");
      }
    }

    const inbound = await prisma.inbound.findUnique({
      where: { no },
      select: { id: true, deleted_at: true, in_type: true },
    });

    if (!inbound || inbound.deleted_at) {
      throw notFound(`ไม่พบ inbound: ${no}`);
    }

    const isAdj = String(inbound.in_type ?? "").toUpperCase() === "ADJ";

    const normalizeAdjDest = (v: any) =>
      String(v ?? "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");

    const adjSignByDest = (dest: any): 1 | -1 => {
      const s = normalizeAdjDest(dest);
      if (s === "mdt") return 1;
      if (s === "inventory adjustment") return -1;
      return 1;
    };

    const toDateOnlyKey = (v: any): string | null => {
      if (!v) return null;
      const d = v instanceof Date ? v : new Date(v);
      if (Number.isNaN(d.getTime())) return null;

      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd}`;
    };

    const sameExpDate = (a: any, b: any): boolean => {
      return toDateOnlyKey(a) === toDateOnlyKey(b);
    };

    const makeConfirmStockBucketKey = (input: {
      source: string;
      product_id: number;
      product_code?: string | null;
      lot_id?: number | null;
      lot_name?: string | null;
      location_id?: number | null;
      expiration_date?: Date | null;
    }) => {
      const baseKey = buildStockBucketKey({
        source: input.source,
        product_id: input.product_id,
        product_code: input.product_code ?? null,
        lot_id: input.lot_id ?? null,
        lot_name: input.lot_name ?? null,
        location_id: input.location_id ?? null,
        expiration_date: input.expiration_date ?? null,
      });

      const expKey = toDateOnlyKey(input.expiration_date) ?? "noexp";
      return `${baseKey}|exp:${expKey}`;
    };

    const result = await prisma.$transaction(async (tx) => {
      const goodsIns = (await tx.goods_in.findMany({
        where: { inbound_id: inbound.id, deleted_at: null },
        select: {
          id: true,
          product_id: true,
          lot_id: true,
          lot_serial: true,
          code: true,
          name: true,
          unit: true,
          exp: true,
          quantity_receive: true,
          quantity_count: true,
          in_process: true,
          location_dest: true,
        },
      })) as ConfirmGoodsInRow[];

      const giMap = new Map<string, ConfirmGoodsInRow>(
        goodsIns.map((x) => [x.id, x]),
      );

      const inboundGoodsInIds = goodsIns.map((x) => x.id);

      if (inboundGoodsInIds.length > 0) {
        await tx.goods_in_location_confirm.deleteMany({
          where: {
            goods_in_id: { in: inboundGoodsInIds },
            confirmed_qty: { lte: 0 },
          },
        });
      }

      const findStrictStockRow = async (input: {
        bucket_key: string;
        legacy_bucket_key: string;
        location_id: number;
        product_id: number;
        lot_name: string | null;
        exp: Date | null | undefined;
      }) => {
        const byNewBucket = await tx.stock.findFirst({
          where: { bucket_key: input.bucket_key },
          select: {
            id: true,
            bucket_key: true,
            quantity: true,
            location_id: true,
            product_id: true,
            lot_name: true,
            expiration_date: true,
          },
        });

        if (
          byNewBucket &&
          Number(byNewBucket.location_id ?? 0) === Number(input.location_id) &&
          Number(byNewBucket.product_id ?? 0) === Number(input.product_id) &&
          String(byNewBucket.lot_name ?? "") === String(input.lot_name ?? "") &&
          sameExpDate(byNewBucket.expiration_date, input.exp)
        ) {
          return byNewBucket;
        }

        const byLegacyBucket = await tx.stock.findFirst({
          where: { bucket_key: input.legacy_bucket_key },
          select: {
            id: true,
            bucket_key: true,
            quantity: true,
            location_id: true,
            product_id: true,
            lot_name: true,
            expiration_date: true,
          },
        });

        if (
          byLegacyBucket &&
          Number(byLegacyBucket.location_id ?? 0) ===
            Number(input.location_id) &&
          Number(byLegacyBucket.product_id ?? 0) === Number(input.product_id) &&
          String(byLegacyBucket.lot_name ?? "") ===
            String(input.lot_name ?? "") &&
          sameExpDate(byLegacyBucket.expiration_date, input.exp)
        ) {
          return byLegacyBucket;
        }

        const candidates = await tx.stock.findMany({
          where: {
            location_id: input.location_id,
            product_id: input.product_id,
            lot_name: input.lot_name ?? null,
          } as any,
          select: {
            id: true,
            bucket_key: true,
            quantity: true,
            location_id: true,
            product_id: true,
            lot_name: true,
            expiration_date: true,
          },
          orderBy: { id: "asc" },
        });

        return (
          candidates.find((row) =>
            sameExpDate(row.expiration_date, input.exp),
          ) ?? null
        );
      };

      const requestedGoodsInIds = Array.from(
        new Set(
          locations.flatMap((g) =>
            (Array.isArray(g.lines) ? g.lines : [])
              .map((l) => String(l?.goods_in_id ?? "").trim())
              .filter(Boolean),
          ),
        ),
      );

      if (requestedGoodsInIds.length === 0) {
        throw badRequest("ไม่พบ goods_in_id ใน payload");
      }

      const draftConfirmRows = await tx.goods_in_location_confirm.findMany({
        where: {
          goods_in_id: { in: requestedGoodsInIds },
          confirmed_qty: { gt: 0 },
        },
        select: {
          goods_in_id: true,
          location_id: true,
          confirmed_qty: true,
          stock_committed_qty: true,
          location: {
            select: {
              id: true,
              full_name: true,
            },
          },
        },
        orderBy: [{ location_id: "asc" }],
      });

      const committedQtyMap = new Map<string, number>();

      for (const row of draftConfirmRows) {
        committedQtyMap.set(
          `${row.goods_in_id}|${row.location_id}`,
          Number(row.stock_committed_qty ?? 0),
        );
      }

      if (draftConfirmRows.length === 0) {
        throw badRequest(
          "ไม่พบ location/qty ที่สแกนไว้ใน goods_in_location_confirm",
        );
      }

      const draftRowMap = new Map<
        string,
        {
          goods_in_id: string;
          location_id: number;
          confirmed_qty: number;
          location: { id: number; full_name: string };
        }
      >();

      for (const row of draftConfirmRows) {
        draftRowMap.set(`${row.goods_in_id}|${row.location_id}`, {
          goods_in_id: String(row.goods_in_id),
          location_id: Number(row.location_id),
          confirmed_qty: Number(row.confirmed_qty ?? 0),
          location: {
            id: Number(row.location.id),
            full_name: String(row.location.full_name),
          },
        });
      }

      const locCountMap: Record<string, Record<string, number>> = {};
      const locMetaMap = new Map<string, { id: number; full_name: string }>();
      let ignoredLines = 0;

      for (const g of locations) {
        const payloadLocName = String(g?.location_full_name ?? "").trim();
        const lines = Array.isArray(g?.lines) ? g.lines : [];

        if (payloadLocName) {
          const resolvedLoc = await resolveLocationByFullName(payloadLocName);
          const locKey = String(resolvedLoc.id);

          locMetaMap.set(locKey, {
            id: resolvedLoc.id,
            full_name: resolvedLoc.full_name,
          });

          if (!locCountMap[locKey]) locCountMap[locKey] = {};

          for (const l of lines) {
            const goods_in_id = String(l?.goods_in_id ?? "").trim();
            if (!goods_in_id) {
              ignoredLines++;
              continue;
            }

            const gi = giMap.get(goods_in_id);
            if (!gi) {
              ignoredLines++;
              continue;
            }

            const draft = draftRowMap.get(`${goods_in_id}|${resolvedLoc.id}`);
            if (!draft || Number(draft.confirmed_qty ?? 0) <= 0) {
              ignoredLines++;
              continue;
            }

            locCountMap[locKey][goods_in_id] = Number(draft.confirmed_qty ?? 0);
          }

          continue;
        }

        for (const l of lines) {
          const goods_in_id = String(l?.goods_in_id ?? "").trim();
          if (!goods_in_id) {
            ignoredLines++;
            continue;
          }

          const gi = giMap.get(goods_in_id);
          if (!gi) {
            ignoredLines++;
            continue;
          }

          const matchedDrafts = draftConfirmRows.filter(
            (r) => String(r.goods_in_id) === goods_in_id,
          );

          if (matchedDrafts.length === 0) {
            ignoredLines++;
            continue;
          }

          for (const draft of matchedDrafts) {
            const locKey = String(draft.location_id);

            locMetaMap.set(locKey, {
              id: Number(draft.location.id),
              full_name: String(draft.location.full_name),
            });

            if (!locCountMap[locKey]) locCountMap[locKey] = {};
            locCountMap[locKey][goods_in_id] = Number(draft.confirmed_qty ?? 0);
          }
        }
      }

      const locs = Array.from(locMetaMap.entries()).map(([key, meta]) => ({
        key,
        id: meta.id,
        full_name: meta.full_name,
      }));

      const totalCountByGi: Record<string, number> = {};
      for (const m of Object.values(locCountMap)) {
        for (const [giId, qty] of Object.entries(m)) {
          totalCountByGi[giId] =
            Number(totalCountByGi[giId] ?? 0) + Number(qty ?? 0);
        }
      }

      const cappedLocCountMap: Record<string, Record<string, number>> = {};
      for (const loc of locs) {
        cappedLocCountMap[String(loc.id)] = {};
      }

      for (const gi of goodsIns) {
        const giId = gi.id;
        const receiveQty = Number(gi.quantity_receive ?? 0);
        const requestedTotal = Number(totalCountByGi[giId] ?? 0);

        const totalAllowed =
          receiveQty > 0
            ? Math.min(receiveQty, requestedTotal)
            : requestedTotal;

        let remaining = totalAllowed;

        for (const loc of locs) {
          const locKey = String(loc.id);
          const reqQty = Number(locCountMap[locKey]?.[giId] ?? 0);

          if (reqQty <= 0 || remaining <= 0) continue;

          const allow = Math.min(reqQty, remaining);
          cappedLocCountMap[locKey][giId] = allow;
          remaining -= allow;
        }
      }

      for (const loc of locs) {
        const locKey = String(loc.id);
        locCountMap[locKey] = cappedLocCountMap[locKey] || {};
      }

      for (const k of Object.keys(totalCountByGi)) {
        delete totalCountByGi[k];
      }

      for (const m of Object.values(locCountMap)) {
        for (const [giId, qty] of Object.entries(m)) {
          totalCountByGi[giId] =
            Number(totalCountByGi[giId] ?? 0) + Number(qty ?? 0);
        }
      }

      let updatedGoodsIn = 0;

      for (const [giId, totalRaw] of Object.entries(totalCountByGi)) {
        const row = giMap.get(giId);
        if (!row) continue;

        const total = Math.max(0, Math.floor(Number(totalRaw ?? 0)));
        const receiveQty = Number(row.quantity_receive ?? 0);
        const finalTotal = receiveQty > 0 ? Math.min(receiveQty, total) : total;
        const current = Number(row.quantity_count ?? 0);

        const shouldMarkInProcess =
          receiveQty > 0 ? finalTotal >= receiveQty : finalTotal > 0;

        const needUpdateCount = current !== finalTotal;
        const needUpdateProcess =
          Boolean(row.in_process) !== shouldMarkInProcess;

        if (!needUpdateCount && !needUpdateProcess) continue;

        await tx.goods_in.update({
          where: { id: giId },
          data: {
            ...(needUpdateCount ? { quantity_count: finalTotal } : {}),
            ...(needUpdateProcess ? { in_process: shouldMarkInProcess } : {}),
            updated_at: new Date(),
            ...(user_ref ? { user_ref } : {}),
          },
        });

        updatedGoodsIn++;
        row.quantity_count = finalTotal;
        row.in_process = shouldMarkInProcess;
      }

      const STATUS_PENDING = "pending";
      const STATUS_IN_PROCESS = "in-process";
      const STATUS_COMPLETED = "completed";

      const allLines = goodsIns;

      const anyCounted = allLines.some((x) => {
        const current = giMap.get(x.id);
        return Number(current?.quantity_count ?? x.quantity_count ?? 0) > 0;
      });

      const allCompletedByQty = allLines.every((x) => {
        const current = giMap.get(x.id);
        const receive = Number(x.quantity_receive ?? 0);
        const count = Number(current?.quantity_count ?? x.quantity_count ?? 0);
        return receive > 0 ? count >= receive : true;
      });

      const allInProcessTrue = allLines.every((x) => {
        const current = giMap.get(x.id);
        return Boolean(current?.in_process ?? x.in_process);
      });

      let nextInboundStatus = STATUS_PENDING;
      if (anyCounted && !(allCompletedByQty && allInProcessTrue)) {
        nextInboundStatus = STATUS_PENDING;
      } else if (allCompletedByQty && allInProcessTrue) {
        nextInboundStatus = STATUS_COMPLETED;
      }

      const inboundRow = await tx.inbound.findUnique({
        where: { id: inbound.id },
        select: { id: true, status: true },
      });

      if (inboundRow && String(inboundRow.status ?? "") !== nextInboundStatus) {
        await tx.inbound.update({
          where: { id: inbound.id },
          data: {
            status: nextInboundStatus,
            updated_at: new Date(),
          },
        });
      }

      let upserted = 0;
      let skipped = 0;

      for (const loc of locs) {
        const locKey = String(loc.id);
        const m = locCountMap[locKey] || {};

        for (const [giId, locQtyRaw] of Object.entries(m)) {
          const gi = giMap.get(giId);

          if (!gi || !gi.product_id) {
            skipped++;
            continue;
          }

          const receiveQty = Number(gi.quantity_receive ?? 0);
          const locQty = Math.max(0, Math.floor(Number(locQtyRaw ?? 0)));
          const finalLocQty =
            receiveQty > 0 ? Math.min(receiveQty, locQty) : locQty;

          if (finalLocQty <= 0) {
            skipped++;
            continue;
          }

          // ✅ rollback ให้กลับมาเข้า stock ได้ก่อน
          const alreadyCommitted = Number(
            committedQtyMap.get(`${giId}|${loc.id}`) ?? 0,
          );

          if (finalLocQty < alreadyCommitted) {
            throw badRequest(
              `จำนวน confirm น้อยกว่าจำนวนที่เข้า stock ไปแล้ว ` +
                `(goods_in_id=${giId}, location=${loc.full_name}, confirmed=${finalLocQty}, committed=${alreadyCommitted})`,
            );
          }

          /**
           * ✅ เข้า stock เฉพาะส่วนต่างที่ยังไม่เคย commit
           *
           * รอบแรก scan 10 -> committed 0 -> baseDelta 10
           * รอบสอง scan เพิ่มเป็น 15 -> committed 10 -> baseDelta 5
           */
          const baseDelta = finalLocQty - alreadyCommitted;

          if (baseDelta <= 0) {
            skipped++;
            continue;
          }

          const bucket_key = makeConfirmStockBucketKey({
            source: "wms",
            product_id: gi.product_id,
            product_code: gi.code ?? null,
            lot_id: gi.lot_id ?? null,
            lot_name: gi.lot_serial ?? null,
            location_id: loc.id,
            expiration_date: gi.exp ?? null,
          });

          const legacy_bucket_key = buildStockBucketKey({
            source: "wms",
            product_id: gi.product_id,
            product_code: gi.code ?? null,
            lot_id: gi.lot_id ?? null,
            lot_name: gi.lot_serial ?? null,
            location_id: loc.id,
            expiration_date: gi.exp ?? null,
          });

          if (isAdj) {
            const sign = adjSignByDest(gi.location_dest);
            const signedDelta = baseDelta * sign;

            const existing = await findStrictStockRow({
              bucket_key,
              legacy_bucket_key,
              location_id: loc.id,
              product_id: gi.product_id,
              lot_name: gi.lot_serial ?? null,
              exp: gi.exp ?? null,
            });

            if (!existing) {
              throw badRequest(
                `ADJ: ไม่พบ stock ที่ exp ตรงกันเพื่อปรับ (location=${loc.full_name}, product=${gi.code ?? gi.product_id}, lot=${gi.lot_serial ?? "-"}, exp=${toDateOnlyKey(gi.exp) ?? "-"})`,
              );
            }

            const curQty = Number(existing.quantity ?? 0);
            const nextQty = curQty + signedDelta;

            if (nextQty < 0) {
              throw badRequest(
                `ADJ: stock ไม่พอสำหรับลบ (มี ${curQty}, ต้องลบ ${Math.abs(
                  signedDelta,
                )}) location=${loc.full_name}, product=${gi.code ?? gi.product_id}, lot=${gi.lot_serial ?? "-"}, exp=${toDateOnlyKey(gi.exp) ?? "-"}`,
              );
            }

            if (signedDelta > 0) {
              await tx.stock.update({
                where: { id: existing.id },
                data: {
                  location_id: loc.id,
                  location_name: loc.full_name,
                  quantity: { increment: new Prisma.Decimal(signedDelta) },
                  updated_at: new Date(),
                } as any,
              });
            } else if (signedDelta < 0) {
              await tx.stock.update({
                where: { id: existing.id },
                data: {
                  location_id: loc.id,
                  location_name: loc.full_name,
                  quantity: {
                    decrement: new Prisma.Decimal(Math.abs(signedDelta)),
                  },
                  updated_at: new Date(),
                } as any,
              });
            } else {
              skipped++;
              continue;
            }

            await tx.goods_in_location_confirm.upsert({
              where: {
                uniq_goodsin_location: {
                  goods_in_id: giId,
                  location_id: loc.id,
                },
              },
              update: {
                confirmed_qty: finalLocQty,
                stock_committed_qty: finalLocQty,
                updated_at: new Date(),
              },
              create: {
                goods_in_id: giId,
                location_id: loc.id,
                confirmed_qty: finalLocQty,
                stock_committed_qty: finalLocQty,
              },
            });

            upserted++;
            continue;
          }

          const existing = await findStrictStockRow({
            bucket_key,
            legacy_bucket_key,
            location_id: loc.id,
            product_id: gi.product_id,
            lot_name: gi.lot_serial ?? null,
            exp: gi.exp ?? null,
          });

          if (existing) {
            await tx.stock.update({
              where: { id: existing.id },
              data: {
                location_id: loc.id,
                location_name: loc.full_name,
                quantity: { increment: new Prisma.Decimal(baseDelta) },
                updated_at: new Date(),
              } as any,
            });
          } else {
            await tx.stock.create({
              data: {
                bucket_key,
                product_id: gi.product_id,
                product_code: gi.code ?? undefined,
                product_name: gi.name ?? undefined,
                unit: gi.unit ?? undefined,
                location_id: loc.id,
                location_name: loc.full_name,
                lot_id: gi.lot_id ?? undefined,
                lot_name: gi.lot_serial ?? undefined,
                expiration_date: gi.exp ?? undefined,
                source: "wms",
                quantity: new Prisma.Decimal(baseDelta),
                count: 0,
              } as any,
            });
          }

          await tx.goods_in_location_confirm.upsert({
            where: {
              uniq_goodsin_location: {
                goods_in_id: giId,
                location_id: loc.id,
              },
            },
            update: {
              confirmed_qty: finalLocQty,
              stock_committed_qty: finalLocQty,
              updated_at: new Date(),
            },
            create: {
              goods_in_id: giId,
              location_id: loc.id,
              confirmed_qty: finalLocQty,
              stock_committed_qty: finalLocQty,
            },
          });

          upserted++;
        }
      }

      return {
        updatedGoodsIn,
        ignoredLines: 0,
        upserted,
        skipped,
        isAdj,
        inbound_status: nextInboundStatus,
      };
    });

    return res.json({
      message: isAdj
        ? "confirm(ADJ) -> commit goods_in(total) + update stock(+/-) สำเร็จ"
        : "confirm -> commit goods_in(total) + upsert stock(from goods_in_location_confirm) สำเร็จ",
      inbound_no: no,
      ...result,
    });
  },
);
