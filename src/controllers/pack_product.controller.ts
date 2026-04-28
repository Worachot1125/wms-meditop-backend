import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";
import { Prisma } from "@prisma/client";
import {
  resolveBarcodeScan,
  normalizeScanText,
} from "../utils/helper_scan/barcode";
import { formatPackProduct } from "../utils/formatters/pack_product.formatter";
import { io } from "../index";

function buildDayRangeFromSearch(search: string) {
  const maybeDate = new Date(search);
  if (Number.isNaN(maybeDate.getTime())) return null;

  const yyyy = maybeDate.getUTCFullYear();
  const mm = String(maybeDate.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(maybeDate.getUTCDate()).padStart(2, "0");

  return {
    gte: new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`),
    lt: new Date(`${yyyy}-${mm}-${dd}T23:59:59.999Z`),
  };
}

function toSearchNumber(search: string) {
  const n = Number(search);
  return Number.isFinite(n) ? n : null;
}

type ParsedPackBarcode = {
  raw: string;
  prefixRaw: string;
  prefixNormalized: string;
  docKeys: string[];
  boxNo: number;
  boxMax: number;
  boxLabel: string;
  fullBoxCode: string;
};

function normalizeSpaces(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizePrefixForCompare(value: string) {
  return normalizeSpaces(value).toUpperCase();
}

function normalizeText(v: unknown) {
  return String(v ?? "").trim();
}

function safeInt(v: unknown, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function parsePositiveInt(value: unknown, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function firstText(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function normalizeStatus(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

/**
 * รองรับ:
 * - 07/04/2026
 * - 07/04/2026, 13:22
 * - 07/04/2026 13:22
 * - 2026-04-07
 * - 2026-04-07 13:22
 */
function parseFlexibleDateSearch(search: string): {
  exact?: {
    gte: Date;
    lt: Date;
  };
  day?: {
    gte: Date;
    lt: Date;
  };
} | null {
  const raw = String(search ?? "").trim();
  if (!raw) return null;

  const normalized = raw
    .replace(/\s*,\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // dd/MM/yyyy [HH:mm[:ss]]
  const thaiLike = normalized.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  );

  if (thaiLike) {
    const dd = Number(thaiLike[1]);
    const mm = Number(thaiLike[2]);
    const yyyy = Number(thaiLike[3]);
    const hh = thaiLike[4] != null ? Number(thaiLike[4]) : null;
    const mi = thaiLike[5] != null ? Number(thaiLike[5]) : null;
    const ss = thaiLike[6] != null ? Number(thaiLike[6]) : 0;

    if (
      mm >= 1 &&
      mm <= 12 &&
      dd >= 1 &&
      dd <= 31 &&
      (hh == null || (hh >= 0 && hh <= 23)) &&
      (mi == null || (mi >= 0 && mi <= 59)) &&
      ss >= 0 &&
      ss <= 59
    ) {
      if (hh != null && mi != null) {
        const start = new Date(Date.UTC(yyyy, mm - 1, dd, hh, mi, ss, 0));
        const end = new Date(start.getTime() + 60 * 1000); // 1 minute window
        return { exact: { gte: start, lt: end } };
      }

      return {
        day: {
          gte: new Date(Date.UTC(yyyy, mm - 1, dd, 0, 0, 0, 0)),
          lt: new Date(Date.UTC(yyyy, mm - 1, dd, 23, 59, 59, 999)),
        },
      };
    }
  }

  // yyyy-MM-dd [HH:mm[:ss]]
  const isoLike = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  );

  if (isoLike) {
    const yyyy = Number(isoLike[1]);
    const mm = Number(isoLike[2]);
    const dd = Number(isoLike[3]);
    const hh = isoLike[4] != null ? Number(isoLike[4]) : null;
    const mi = isoLike[5] != null ? Number(isoLike[5]) : null;
    const ss = isoLike[6] != null ? Number(isoLike[6]) : 0;

    if (hh != null && mi != null) {
      const start = new Date(Date.UTC(yyyy, mm - 1, dd, hh, mi, ss, 0));
      const end = new Date(start.getTime() + 60 * 1000);
      return { exact: { gte: start, lt: end } };
    }

    return {
      day: {
        gte: new Date(Date.UTC(yyyy, mm - 1, dd, 0, 0, 0, 0)),
        lt: new Date(Date.UTC(yyyy, mm - 1, dd, 23, 59, 59, 999)),
      },
    };
  }

  // fallback เดิม
  const fallbackDay = buildDayRangeFromSearch(raw);
  if (fallbackDay) {
    return { day: fallbackDay };
  }

  return null;
}

function buildPackProductSearchWhere(
  search: string,
): Prisma.pack_productWhereInput {
  const trimmed = String(search ?? "").trim();

  if (!trimmed) {
    return { deleted_at: null };
  }

  const orConditions: Prisma.pack_productWhereInput[] = [];

  // search text หลัก
  orConditions.push(
    { name: { contains: trimmed, mode: "insensitive" } },
    { scan_prefix: { contains: trimmed, mode: "insensitive" } },
    { batch_name: { contains: trimmed, mode: "insensitive" } },
    { status: { contains: trimmed, mode: "insensitive" } },
    { remark: { contains: trimmed, mode: "insensitive" } },
  );

  // search เลข id / max_box
  const num = toSearchNumber(trimmed);
  if (num !== null) {
    orConditions.push({ id: num }, { max_box: num });
  }

  // search date/time
  const parsedDate = parseFlexibleDateSearch(trimmed);
  if (parsedDate?.exact) {
    orConditions.push(
      { created_at: { gte: parsedDate.exact.gte, lt: parsedDate.exact.lt } },
      { updated_at: { gte: parsedDate.exact.gte, lt: parsedDate.exact.lt } },
    );
  } else if (parsedDate?.day) {
    orConditions.push(
      { created_at: { gte: parsedDate.day.gte, lt: parsedDate.day.lt } },
      { updated_at: { gte: parsedDate.day.gte, lt: parsedDate.day.lt } },
    );
  }

  // search ข้างใน relation แบบให้ใกล้ outbound มากขึ้น
  orConditions.push(
    {
      outbounds: {
        some: {
          outbound: {
            is: {
              deleted_at: null,
              OR: [
                { no: { contains: trimmed, mode: "insensitive" } },
                { origin: { contains: trimmed, mode: "insensitive" } },
                { invoice: { contains: trimmed, mode: "insensitive" } },
                { department: { contains: trimmed, mode: "insensitive" } },
                { out_type: { contains: trimmed, mode: "insensitive" } },
                {
                  goods_outs: {
                    some: {
                      deleted_at: null,
                      OR: [
                        { code: { contains: trimmed, mode: "insensitive" } },
                        { name: { contains: trimmed, mode: "insensitive" } },
                        { sku: { contains: trimmed, mode: "insensitive" } },
                        {
                          lot_serial: {
                            contains: trimmed,
                            mode: "insensitive",
                          },
                        },
                        {
                          barcode_text: {
                            contains: trimmed,
                            mode: "insensitive",
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      },
    },
    {
      boxes: {
        some: {
          deleted_at: null,
          OR: [
            { box_code: { contains: trimmed, mode: "insensitive" } },
            { box_label: { contains: trimmed, mode: "insensitive" } },
            { status: { contains: trimmed, mode: "insensitive" } },
          ],
        },
      },
    },
  );

  return {
    deleted_at: null,
    OR: orConditions,
  };
}

function parsePackBarcode(rawInput: unknown): ParsedPackBarcode {
  const raw = String(rawInput ?? "").trim();
  if (!raw) throw badRequest("กรุณาส่ง barcode");

  const underscoreIndex = raw.lastIndexOf("_");
  if (underscoreIndex < 0) {
    throw badRequest(
      "barcode ไม่ถูกต้อง: ต้องมี _ เช่น BO26-02985, 1576665_ 1/28",
    );
  }

  const front = normalizeSpaces(raw.slice(0, underscoreIndex));
  const back = normalizeSpaces(raw.slice(underscoreIndex + 1));

  if (!front) {
    throw badRequest("barcode ไม่ถูกต้อง: prefix ก่อน _ ห้ามว่าง");
  }

  if (!back) {
    throw badRequest("barcode ไม่ถูกต้อง: ส่วนหลัง _ ห้ามว่าง");
  }

  const match = back.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!match) {
    throw badRequest("barcode ไม่ถูกต้อง: ส่วนหลังต้องเป็น x/xx เช่น 1/28");
  }

  const boxNo = Number(match[1]);
  const boxMax = Number(match[2]);

  if (!Number.isInteger(boxNo) || boxNo <= 0) {
    throw badRequest("box no ต้องเป็นจำนวนเต็มมากกว่า 0");
  }

  if (!Number.isInteger(boxMax) || boxMax <= 0) {
    throw badRequest("box max ต้องเป็นจำนวนเต็มมากกว่า 0");
  }

  if (boxNo > boxMax) {
    throw badRequest(`เลขกล่อง ${boxNo}/${boxMax} ไม่ถูกต้อง`);
  }

  const docKeys = front
    .split(",")
    .map((s) => normalizeSpaces(s))
    .filter(Boolean);

  if (docKeys.length === 0) {
    throw badRequest("ไม่พบ document key ก่อน _");
  }

  return {
    raw,
    prefixRaw: front,
    prefixNormalized: normalizePrefixForCompare(front),
    docKeys,
    boxNo,
    boxMax,
    boxLabel: `${boxNo}/${boxMax}`,
    fullBoxCode: `${front}_ ${boxNo}/${boxMax}`,
  };
}

function buildPackName(prefixRaw: string) {
  return `PACK_${prefixRaw}`;
}

function getPackProductRoom(packProductId: number) {
  return `pack-product:${packProductId}`;
}

function getPackProductBoxRoom(packProductId: number, boxId: number) {
  return `pack-product:${packProductId}:box:${boxId}`;
}

type OutboundWithBatch = {
  id: number;
  no: string;
  origin: string | null;
  invoice: string | null;
  batch_lock?: {
    id: number;
    name: string | null;
    status: string;
    outbound_id: number;
  } | null;
};

function validatePackBatchName(outbounds: OutboundWithBatch[]): {
  batch_name: string;
  batch_row_ids: number[];
  batch_statuses: string[];
} {
  if (!Array.isArray(outbounds) || outbounds.length === 0) {
    throw badRequest("ไม่พบ outbound สำหรับตรวจสอบ batch");
  }

  const missingBatch = outbounds.filter(
    (ob) => !ob.batch_lock || !String(ob.batch_lock.name ?? "").trim(),
  );

  if (missingBatch.length > 0) {
    throw badRequest(
      `มี outbound ที่ยังไม่ได้อยู่ใน batch pick หรือ batch ไม่มีชื่อ: ${missingBatch
        .map((x) => x.no)
        .join(", ")}`,
    );
  }

  const batchNames = Array.from(
    new Set(
      outbounds
        .map((ob) => String(ob.batch_lock?.name ?? "").trim())
        .filter(Boolean),
    ),
  );

  if (batchNames.length !== 1) {
    throw badRequest(
      `outbound ที่ scan มาอยู่คนละ batch pick กัน: ${batchNames.join(", ")}`,
    );
  }

  return {
    batch_name: batchNames[0],
    batch_row_ids: outbounds.map((ob) => Number(ob.batch_lock!.id)),
    batch_statuses: Array.from(
      new Set(
        outbounds.map((ob) => String(ob.batch_lock?.status ?? "").trim()),
      ),
    ),
  };
}

async function emitPackProductSocketUpdate(packProductId: number) {
  const full = await loadPackProductFull(packProductId);
  if (!full || full.deleted_at) return;

  const adjustedFull = applyReturnToPackProduct(full as any);

  const formatted = formatPackProduct(adjustedFull as any);
  const summary = buildPackProductSummary({ packProduct: adjustedFull });

  io.to(getPackProductRoom(packProductId)).emit("pack_product:updated", {
    pack_product_id: packProductId,
    data: formatted,
    summary,
    ts: new Date().toISOString(),
  });

  for (const box of full.boxes ?? []) {
    io.to(getPackProductBoxRoom(packProductId, Number(box.id))).emit(
      "pack_product:box_updated",
      {
        pack_product_id: packProductId,
        box_id: box.id,
        box: {
          id: box.id,
          box_no: box.box_no,
          box_max: box.box_max,
          box_label: box.box_label,
          box_code: box.box_code,
          status: box.status,
          created_at: box.created_at,
          updated_at: box.updated_at,
          items: (box.items ?? []).map((row: any) => ({
            id: row.id,
            goods_out_item_id: row.goods_out_item_id,
            quantity: row.quantity,
            goods_out_item: row.goods_out_item
              ? {
                  id: row.goods_out_item.id,
                  outbound_id: row.goods_out_item.outbound_id,
                  code: row.goods_out_item.code,
                  name: row.goods_out_item.name,
                  lot_serial: row.goods_out_item.lot_serial,
                  qty: row.goods_out_item.qty,
                  pack: row.goods_out_item.pack,
                  status: row.goods_out_item.status,
                }
              : null,
          })),
        },
        ts: new Date().toISOString(),
      },
    );
  }
}

async function relabelPackProductBoxesByMax(
  tx: any,
  input: {
    packProductId: number;
    newMaxBox: number;
    fallbackPrefixRaw: string;
  },
) {
  const { packProductId, newMaxBox, fallbackPrefixRaw } = input;

  const existingBoxes = await tx.pack_product_box.findMany({
    where: {
      pack_product_id: packProductId,
      deleted_at: null,
    },
    select: {
      id: true,
      box_no: true,
      box_code: true,
    },
    orderBy: [{ box_no: "asc" }, { id: "asc" }],
  });

  for (const existingBox of existingBoxes) {
    const prefixFromCode = normalizeSpaces(
      String(existingBox.box_code ?? "").split("_")[0] ?? "",
    );

    const prefixRaw = prefixFromCode || fallbackPrefixRaw;

    await tx.pack_product_box.update({
      where: { id: existingBox.id },
      data: {
        box_max: newMaxBox,
        box_label: `${existingBox.box_no}/${newMaxBox}`,
        box_code: `${prefixRaw}_ ${existingBox.box_no}/${newMaxBox}`,
        updated_at: new Date(),
      },
    });
  }
}

async function findOutboundsByDocKeys(docKeys: string[]) {
  const uniqueKeys = Array.from(
    new Set(docKeys.map((k) => normalizeSpaces(k)).filter(Boolean)),
  );

  if (uniqueKeys.length === 0) return [];

  return prisma.outbound.findMany({
    where: {
      deleted_at: null,
      OR: uniqueKeys.flatMap((key) => [
        { no: key },
        { origin: key },
        { invoice: key },
      ]),
    },
    include: {
      batch_lock: {
        select: {
          id: true,
          name: true,
          status: true,
          outbound_id: true,
        },
      },
      goods_outs: {
        where: { deleted_at: null },
        include: {
          barcode_ref: {
            where: { deleted_at: null },
          },
          boxes: {
            where: { deleted_at: null },
            include: { box: true },
          },
        },
        orderBy: [{ sequence: "asc" }, { id: "asc" }],
      },
    },
    orderBy: { created_at: "desc" },
  });
}

function buildMatchSummary(
  outbounds: Array<{
    id: number;
    no: string;
    origin: string | null;
    invoice: string | null;
  }>,
  docKeys: string[],
) {
  const normalizedKeys = new Set(
    docKeys.map((k) => normalizePrefixForCompare(k)),
  );

  return outbounds.map((ob) => {
    const matchedBy: string[] = [];

    if (normalizedKeys.has(normalizePrefixForCompare(ob.no))) {
      matchedBy.push("no");
    }
    if (ob.origin && normalizedKeys.has(normalizePrefixForCompare(ob.origin))) {
      matchedBy.push("origin");
    }
    if (
      ob.invoice &&
      normalizedKeys.has(normalizePrefixForCompare(ob.invoice))
    ) {
      matchedBy.push("invoice");
    }

    return {
      outbound_id: ob.id,
      no: ob.no,
      origin: ob.origin ?? null,
      invoice: ob.invoice ?? null,
      matched_by: matchedBy,
    };
  });
}

async function loadPackProductFull(packProductId: number) {
  return prisma.pack_product.findUnique({
    where: { id: packProductId },
    include: {
      outbounds: {
        include: {
          outbound: {
            include: {
              goods_outs: {
                where: { deleted_at: null },
                include: {
                  barcode_ref: {
                    where: { deleted_at: null },
                  },
                  boxes: {
                    where: { deleted_at: null },
                    include: { box: true },
                  },
                },
                orderBy: [{ sequence: "asc" }, { id: "asc" }],
              },
            },
          },
        },
        orderBy: { id: "asc" },
      },
      boxes: {
        where: { deleted_at: null },
        include: {
          items: {
            where: { deleted_at: null },
            include: {
              goods_out_item: true,
            },
          },
        },
        orderBy: [{ box_no: "asc" }, { id: "asc" }],
      },
    },
  });
}

function goodsOutItemBarcodeMatched(args: {
  rawBarcode: string;
  parsedBarcodeText: string;
  parsedLotSerial: string;
  item: {
    code?: string | null;
    barcode_text?: string | null;
    lot_serial?: string | null;
    barcode_ref?: { barcode?: string | null } | null;
  };
}) {
  const { rawBarcode, parsedBarcodeText, parsedLotSerial, item } = args;

  const rawNorm = normalizeScanText(rawBarcode);
  const parsedBarcodeNorm = normalizeScanText(parsedBarcodeText);
  const parsedLotNorm = normalizeScanText(parsedLotSerial);

  const itemCodeNorm = normalizeScanText(item.code ?? "");
  const itemBarcodeTextNorm = normalizeScanText(item.barcode_text ?? "");
  const itemBarcodeMasterNorm = normalizeScanText(
    item.barcode_ref?.barcode ?? "",
  );
  const itemLotNorm = normalizeScanText(item.lot_serial ?? "");

  const barcodeMatched =
    (!!itemBarcodeTextNorm && itemBarcodeTextNorm === parsedBarcodeNorm) ||
    (!!itemBarcodeMasterNorm && itemBarcodeMasterNorm === parsedBarcodeNorm) ||
    (!!itemCodeNorm && itemCodeNorm === parsedBarcodeNorm) ||
    (!!itemBarcodeTextNorm && itemBarcodeTextNorm === rawNorm) ||
    (!!itemBarcodeMasterNorm && itemBarcodeMasterNorm === rawNorm) ||
    (!!itemCodeNorm && itemCodeNorm === rawNorm);

  const lotMatched = !parsedLotNorm || parsedLotNorm === itemLotNorm;

  return barcodeMatched && lotMatched;
}

async function syncGoodsOutItemPackInPackProduct(
  tx: any,
  packProductId: number,
  goodsOutItemId: number,
  userRef: string | null,
) {
  const agg = await tx.pack_product_box_item.aggregate({
    where: {
      deleted_at: null,
      goods_out_item_id: goodsOutItemId,
      pack_box: {
        deleted_at: null,
        pack_product_id: packProductId,
      },
    },
    _sum: {
      quantity: true,
    },
  });

  const packedQty = Number(agg._sum.quantity ?? 0);

  const item = await tx.goods_out_item.findUnique({
    where: { id: goodsOutItemId },
    select: {
      id: true,
      qty: true,
      status: true,
    },
  });

  if (!item) return null;

  const itemQty = Number(item.qty ?? 0);
  let nextStatus = item.status ?? "DRAFT";

  if (itemQty > 0 && packedQty >= itemQty) {
    nextStatus = "PACKED";
  } else if (
    packedQty < itemQty &&
    String(item.status ?? "").toUpperCase() === "PACKED"
  ) {
    nextStatus = "PICKED";
  }

  return tx.goods_out_item.update({
    where: { id: goodsOutItemId },
    data: {
      pack: packedQty,
      user_pack: userRef,
      pack_time: new Date(),
      status: nextStatus,
      updated_at: new Date(),
    },
    select: {
      id: true,
      qty: true,
      pack: true,
      status: true,
      updated_at: true,
    },
  });
}

function buildPackProductSummary(input: { packProduct: any }) {
  const { packProduct } = input;

  const boxes = Array.isArray(packProduct.boxes) ? packProduct.boxes : [];
  const outbounds = Array.isArray(packProduct.outbounds)
    ? packProduct.outbounds
    : [];

  const allItems = outbounds.flatMap((row: any) =>
    (row.outbound?.goods_outs ?? []).map((item: any) => ({
      id: item.id,
      outbound_id: item.outbound_id,
      outbound_no: row.outbound?.no ?? null,
      code: item.code ?? null,
      name: item.name ?? null,
      lot_serial: item.lot_serial ?? null,
      qty: Number(item.qty ?? 0),
      pick: Number(item.pick ?? 0),
      pack: Number(item.pack ?? 0),
      status: item.status ?? null,
    })),
  );

  const maxBox = Number(packProduct.max_box ?? 0);

  const distinctBoxNos = (
    Array.from(
      new Set(
        boxes
          .map((b: any) => Number(b.box_no))
          .filter((n: number) => Number.isFinite(n) && n > 0),
      ),
    ) as number[]
  ).sort((a, b) => a - b);

  const openBoxes = boxes.filter(
    (b: any) => normalizeStatus(b.status) === "open",
  );

  const closedBoxes = boxes.filter(
    (b: any) => normalizeStatus(b.status) === "closed",
  );

  const missingBoxNos: number[] = [];
  for (let i = 1; i <= maxBox; i++) {
    if (!distinctBoxNos.includes(i)) missingBoxNos.push(i);
  }

  const completedItems = allItems.filter((item: any) => {
    const qty = Number(item.qty ?? 0);
    const pack = Number(item.pack ?? 0);
    return qty > 0 && pack >= qty;
  });

  const incompleteItems = allItems.filter((item: any) => {
    const qty = Number(item.qty ?? 0);
    const pack = Number(item.pack ?? 0);
    return qty > 0 && pack < qty;
  });

  const totalQty = allItems.reduce(
    (sum: number, x: any) => sum + Number(x.qty ?? 0),
    0,
  );
  const totalPack = allItems.reduce(
    (sum: number, x: any) => sum + Number(x.pack ?? 0),
    0,
  );

  const percent =
    totalQty > 0 ? Math.min(100, Math.round((totalPack / totalQty) * 100)) : 0;

  return {
    pack_product: {
      id: packProduct.id,
      name: packProduct.name,
      scan_prefix: packProduct.scan_prefix,
      max_box: packProduct.max_box,
      status: packProduct.status,
      batch_name: packProduct.batch_name ?? null,
      created_at: packProduct.created_at,
      updated_at: packProduct.updated_at,
    },
    totals: {
      total_outbounds: outbounds.length,
      total_items: allItems.length,
      completed_items: completedItems.length,
      incomplete_items: incompleteItems.length,
      total_qty: totalQty,
      total_pack: totalPack,
      progress_percent: percent,
    },
    boxes: {
      total_boxes: boxes.length,
      distinct_box_count: distinctBoxNos.length,
      max_box: maxBox,
      open_box_count: openBoxes.length,
      closed_box_count: closedBoxes.length,
      missing_box_nos: missingBoxNos,
    },
    can_finalize:
      openBoxes.length === 0 &&
      missingBoxNos.length === 0 &&
      incompleteItems.length === 0,
    incomplete_items: incompleteItems,
  };
}

async function loadPackBoxItems(boxId: number) {
  return prisma.pack_product_box_item.findMany({
    where: {
      pack_product_box_id: boxId,
      deleted_at: null,
    },
    include: {
      goods_out_item: true,
    },
    orderBy: [{ id: "asc" }],
  });
}

function pickSingleMatchedItem(
  allItems: any[],
  rawBarcode: string,
  parsedBarcodeText: string,
  parsedLotSerial: string,
) {
  const matchDebugRows = allItems.map((item: any) => {
    const rawNorm = normalizeScanText(rawBarcode);
    const parsedBarcodeNorm = normalizeScanText(parsedBarcodeText);
    const parsedLotNorm = normalizeScanText(parsedLotSerial);

    const itemCodeNorm = normalizeScanText(item.code ?? "");
    const itemBarcodeTextNorm = normalizeScanText(item.barcode_text ?? "");
    const itemBarcodeMasterNorm = normalizeScanText(
      item.barcode_ref?.barcode ?? "",
    );
    const itemLotNorm = normalizeScanText(item.lot_serial ?? "");

    const barcodeMatched =
      (!!itemBarcodeTextNorm && itemBarcodeTextNorm === parsedBarcodeNorm) ||
      (!!itemBarcodeMasterNorm &&
        itemBarcodeMasterNorm === parsedBarcodeNorm) ||
      (!!itemCodeNorm && itemCodeNorm === parsedBarcodeNorm) ||
      (!!itemBarcodeTextNorm && itemBarcodeTextNorm === rawNorm) ||
      (!!itemBarcodeMasterNorm && itemBarcodeMasterNorm === rawNorm) ||
      (!!itemCodeNorm && itemCodeNorm === rawNorm);

    const lotMatched = !parsedLotNorm || parsedLotNorm === itemLotNorm;

    return {
      id: item.id,
      outbound_no: item.outbound_no,
      code: item.code,
      barcode_text: item.barcode_text,
      barcode_ref: item.barcode_ref?.barcode ?? null,
      lot_serial: item.lot_serial,

      rawNorm,
      parsedBarcodeNorm,
      parsedLotNorm,
      itemCodeNorm,
      itemBarcodeTextNorm,
      itemBarcodeMasterNorm,
      itemLotNorm,

      barcodeMatched,
      lotMatched,
      finalMatched: barcodeMatched && lotMatched,

      original_qty: item.original_qty,
      return_qty: item.return_qty,
      qty_after_return: item.qty,
      pack: item.pack,
      remaining: Math.max(0, Number(item.qty ?? 0) - Number(item.pack ?? 0)),
    };
  });


  const matchedItems = allItems.filter((item: any) =>
    goodsOutItemBarcodeMatched({
      rawBarcode,
      parsedBarcodeText,
      parsedLotSerial,
      item,
    }),
  );
  
  if (matchedItems.length === 0) {
    throw notFound("ไม่พบสินค้าใน pack_product นี้ที่ตรงกับ barcode ที่สแกน");
  }

  if (matchedItems.length > 1) {
    const sameLotItems = matchedItems.filter(
      (item: any) =>
        normalizeScanText(item.lot_serial ?? "") ===
        normalizeScanText(parsedLotSerial ?? ""),
    );

    if (parsedLotSerial && sameLotItems.length === 1) {
      return sameLotItems[0];
    }
  }

  if (matchedItems.length > 1) {
    throw badRequest(
      "พบสินค้ามากกว่า 1 รายการจาก barcode นี้ กรุณาระบุ lot ให้ชัดเจน",
    );
  }

  return matchedItems[0];
}

function applyReturnToPackProduct(row: any) {
  const cloned = {
    ...row,
    outbounds: Array.isArray(row?.outbounds)
      ? row.outbounds.map((po: any) => ({
          ...po,
          outbound: po?.outbound
            ? {
                ...po.outbound,
                goods_outs: Array.isArray(po.outbound?.goods_outs)
                  ? po.outbound.goods_outs.map((item: any) => {
                      const returnQty = Math.max(0, Number(item.return ?? 0));

                      return {
                        ...item,

                        // ✅ แสดงยอดหลังหัก return
                        qty: Math.max(0, Number(item.qty ?? 0) - returnQty),
                        pick: Math.max(0, Number(item.pick ?? 0) - returnQty),

                        // ✅ เก็บค่าเดิมไว้ เผื่อ FE อยากใช้
                        original_qty: Number(item.qty ?? 0),
                        original_pick: Number(item.pick ?? 0),
                        return_qty: returnQty,
                      };
                    })
                  : po.outbound?.goods_outs,
              }
            : po?.outbound,
        }))
      : row?.outbounds,
  };

  return cloned;
}

/**
 * GET /api/outbounds/pack-products
 */
export const getPackProducts = asyncHandler(
  async (req: Request, res: Response) => {
    const page = parsePositiveInt(req.query.page, 1);
    const limit = Math.min(parsePositiveInt(req.query.limit, 20), 200);
    const skip = (page - 1) * limit;

    const search = firstText(req.query.search);
    const rawStatus = firstText(req.query.status)?.toLowerCase();

    const allowedStatuses = ["completed", "process"] as const;

    if (
      rawStatus &&
      !allowedStatuses.includes(rawStatus as (typeof allowedStatuses)[number])
    ) {
      throw badRequest("status ต้องเป็น completed หรือ process");
    }

    // 🔹 where สำหรับ list
    const where: Prisma.pack_productWhereInput =
      buildPackProductSearchWhere(search);

    if (rawStatus) {
      where.status = rawStatus;
    }

    // 🔹 where สำหรับ statusCounts (ห้ามติด status filter)
    const whereForCount: Prisma.pack_productWhereInput =
      buildPackProductSearchWhere(search);

    const [rows, total, processCount, completedCount] = await Promise.all([
      prisma.pack_product.findMany({
        where,
        include: {
          outbounds: {
            include: {
              outbound: {
                include: {
                  goods_outs: {
                    where: { deleted_at: null },
                    include: {
                      barcode_ref: {
                        where: { deleted_at: null },
                      },
                      boxes: {
                        where: { deleted_at: null },
                        include: { box: true },
                      },
                    },
                    orderBy: [{ sequence: "asc" }, { id: "asc" }],
                  },
                },
              },
            },
            orderBy: { id: "asc" },
          },
          boxes: {
            where: { deleted_at: null },
            include: {
              items: {
                where: { deleted_at: null },
                include: {
                  goods_out_item: true,
                },
              },
            },
            orderBy: [{ box_no: "asc" }, { id: "asc" }],
          },
        },
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
        skip,
        take: limit,
      }),

      prisma.pack_product.count({ where }),

      // 🔥 statusCounts
      prisma.pack_product.count({
        where: {
          ...whereForCount,
          status: "process",
        },
      }),
      prisma.pack_product.count({
        where: {
          ...whereForCount,
          status: "completed",
        },
      }),
    ]);

    return res.json({
      data: rows.map((row) =>
        formatPackProduct(applyReturnToPackProduct(row as any)),
      ),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        statusCounts: {
          process: processCount,
          completed: completedCount,
        },
      },
    });
  },
);

/**
 * GET /api/outbounds/pack-products/:id
 */
export const getPackProductById = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) throw badRequest("id ต้องเป็นตัวเลข");

    const row = await loadPackProductFull(id);

    if (!row || row.deleted_at) {
      throw notFound("ไม่พบ pack_product");
    }

    return res.json({
      data: formatPackProduct(applyReturnToPackProduct(row as any)),
    });
  },
);

/**
 * GET /api/outbounds/pack-products/by-prefix/:prefix
 */
export const getPackProductByPrefix = asyncHandler(
  async (req: Request<{ prefix: string }>, res: Response) => {
    const prefix = decodeURIComponent(String(req.params.prefix ?? "")).trim();
    if (!prefix) throw badRequest("กรุณาระบุ prefix");

    const row = await prisma.pack_product.findFirst({
      where: {
        scan_prefix: prefix,
        deleted_at: null,
      },
      include: {
        outbounds: {
          include: {
            outbound: {
              include: {
                goods_outs: {
                  where: { deleted_at: null },
                  include: {
                    barcode_ref: {
                      where: { deleted_at: null },
                    },
                    boxes: {
                      where: { deleted_at: null },
                      include: { box: true },
                    },
                  },
                  orderBy: [{ sequence: "asc" }, { id: "asc" }],
                },
              },
            },
          },
          orderBy: { id: "asc" },
        },
        boxes: {
          where: { deleted_at: null },
          include: {
            items: {
              where: { deleted_at: null },
              include: {
                goods_out_item: true,
              },
            },
          },
          orderBy: [{ box_no: "asc" }, { id: "asc" }],
        },
      },
    });

    if (!row) {
      throw notFound(`ไม่พบ pack_product ของ prefix: ${prefix}`);
    }

    return res.json({
      data: formatPackProduct(applyReturnToPackProduct(row as any)),
    });
  },
);

/**
 * GET /api/outbounds/pack-products/:packProductId/summary
 */
export const getPackProductSummary = asyncHandler(
  async (req: Request<{ packProductId: string }>, res: Response) => {
    const packProductId = Number(req.params.packProductId);
    if (!Number.isFinite(packProductId)) {
      throw badRequest("packProductId ต้องเป็นตัวเลข");
    }

    const packProduct = await prisma.pack_product.findUnique({
      where: { id: packProductId },
      include: {
        outbounds: {
          include: {
            outbound: {
              include: {
                goods_outs: {
                  where: { deleted_at: null },
                  orderBy: [{ sequence: "asc" }, { id: "asc" }],
                },
              },
            },
          },
          orderBy: { id: "asc" },
        },
        boxes: {
          where: { deleted_at: null },
          include: {
            items: {
              where: { deleted_at: null },
              select: {
                id: true,
                goods_out_item_id: true,
                quantity: true,
              },
            },
          },
          orderBy: [{ box_no: "asc" }, { id: "asc" }],
        },
      },
    });

    if (!packProduct || packProduct.deleted_at) {
      throw notFound("ไม่พบ pack_product");
    }

    const adjustedPackProduct = applyReturnToPackProduct(packProduct as any);

    const summary = buildPackProductSummary({
      packProduct: adjustedPackProduct,
    });

    return res.json({
      data: summary,
    });
  },
);

/**
 * POST /api/outbounds/pack-products/scan
 * body: { barcode: string, user_ref?: string }
 */
export const scanPackProductBarcode = asyncHandler(
  async (
    req: Request<{}, {}, { barcode: string; user_ref?: string | null }>,
    res: Response,
  ) => {
    const parsed = parsePackBarcode(req.body?.barcode);
    const userRef =
      req.body?.user_ref == null
        ? null
        : String(req.body.user_ref).trim() || null;

    const outbounds = await findOutboundsByDocKeys(parsed.docKeys);

    if (outbounds.length === 0) {
      throw notFound(
        `ไม่พบ outbound จาก prefix: ${parsed.prefixRaw} (ค้นจาก no/origin/invoice)`,
      );
    }

    // ต้องหาให้ครบทุก key ก่อน _
    const missingDocKeys = parsed.docKeys.filter((docKey) => {
      const normalized = normalizePrefixForCompare(docKey);

      return !outbounds.some((ob) => {
        const no = normalizePrefixForCompare(ob.no ?? "");
        const origin = normalizePrefixForCompare(ob.origin ?? "");
        const invoice = normalizePrefixForCompare(ob.invoice ?? "");

        return (
          normalized === no || normalized === origin || normalized === invoice
        );
      });
    });

    if (missingDocKeys.length > 0) {
      throw badRequest(
        `ไม่พบ outbound ครบทุกใบใน prefix นี้ ขาด: ${missingDocKeys.join(", ")}`,
      );
    }

    const batchInfo = validatePackBatchName(outbounds as OutboundWithBatch[]);

    const matchSummary = buildMatchSummary(
      outbounds.map((ob) => ({
        id: ob.id,
        no: ob.no,
        origin: ob.origin ?? null,
        invoice: ob.invoice ?? null,
      })),
      parsed.docKeys,
    );

    const txResult = await prisma.$transaction(async (tx) => {
      let packProduct = await tx.pack_product.findFirst({
        where: {
          deleted_at: null,
          scan_prefix: parsed.prefixRaw,
        },
        include: {
          outbounds: {
            include: {
              outbound: true,
            },
          },
          boxes: {
            where: { deleted_at: null },
            orderBy: [{ box_no: "asc" }, { id: "asc" }],
          },
        },
      });

      // =========================
      // VALIDATE PACK เดิมก่อน reuse
      // =========================
      if (packProduct) {
        if (String(packProduct.status ?? "").toLowerCase() !== "process") {
          throw badRequest(
            `งาน pack นี้ไม่ได้อยู่ในสถานะ process แล้ว (status: ${packProduct.status})`,
          );
        }

        if (
          String(packProduct.batch_name ?? "").trim() &&
          String(packProduct.batch_name ?? "").trim() !== batchInfo.batch_name
        ) {
          throw badRequest(
            `prefix นี้มี pack เดิมอยู่แล้ว แต่ batch pick ไม่ตรงกัน (pack batch: ${packProduct.batch_name}, scanned batch: ${batchInfo.batch_name})`,
          );
        }

        const existingOutboundRows = packProduct.outbounds ?? [];

        if (existingOutboundRows.length === 0) {
          throw badRequest(
            `พบ pack เดิมของ prefix นี้ แต่ไม่มี outbound ผูกอยู่ กรุณาตรวจสอบข้อมูล pack เดิม`,
          );
        }

        const existingMissingDocKeys = parsed.docKeys.filter((docKey) => {
          const normalized = normalizePrefixForCompare(docKey);

          return !existingOutboundRows.some((row: any) => {
            const ob = row.outbound;
            if (!ob) return false;

            const no = normalizePrefixForCompare(ob.no ?? "");
            const origin = normalizePrefixForCompare(ob.origin ?? "");
            const invoice = normalizePrefixForCompare(ob.invoice ?? "");

            return (
              normalized === no ||
              normalized === origin ||
              normalized === invoice
            );
          });
        });

        if (existingMissingDocKeys.length > 0) {
          throw badRequest(
            `prefix นี้มี pack เดิมอยู่แล้ว แต่เอกสารที่ scan ไม่ตรงกับงานเดิม ขาด: ${existingMissingDocKeys.join(", ")}`,
          );
        }

        const currentMaxBox = Number(packProduct.max_box ?? 0);

        if (parsed.boxMax < currentMaxBox) {
          throw badRequest(
            `barcode นี้ระบุจำนวนกล่องรวม (${parsed.boxMax}) น้อยกว่า max เดิมของงาน (${currentMaxBox})`,
          );
        }

        if (parsed.boxNo > parsed.boxMax) {
          throw badRequest(
            `เลขกล่อง ${parsed.boxNo}/${parsed.boxMax} ไม่ถูกต้อง`,
          );
        }

        if (!String(packProduct.batch_name ?? "").trim()) {
          packProduct = await tx.pack_product.update({
            where: { id: packProduct.id },
            data: {
              batch_name: batchInfo.batch_name,
              updated_at: new Date(),
            },
            include: {
              outbounds: {
                include: {
                  outbound: true,
                },
              },
              boxes: {
                where: { deleted_at: null },
                orderBy: [{ box_no: "asc" }, { id: "asc" }],
              },
            },
          });
        }
      }

      // =========================
      // CREATE PACK ใหม่
      // =========================
      if (!packProduct) {
        packProduct = await tx.pack_product.create({
          data: {
            name: buildPackName(parsed.prefixRaw),
            scan_prefix: parsed.prefixRaw,
            max_box: parsed.boxMax,
            status: "process",
            remark: userRef ? `created_by=${userRef}` : null,
            batch_name: batchInfo.batch_name,
          },
          include: {
            outbounds: {
              include: {
                outbound: true,
              },
            },
            boxes: {
              where: { deleted_at: null },
              orderBy: [{ box_no: "asc" }, { id: "asc" }],
            },
          },
        });
      }

      // =========================
      // SYNC outbound relations
      // =========================
      const existingOutboundIds = new Set(
        (packProduct.outbounds ?? []).map((row: any) =>
          Number(row.outbound_id),
        ),
      );

      for (const outbound of outbounds) {
        if (!existingOutboundIds.has(outbound.id)) {
          await tx.pack_product_outbound.create({
            data: {
              pack_product_id: packProduct.id,
              outbound_id: outbound.id,
            },
          });
        }
      }

      // =========================
      // UPDATE max_box ถ้าขยายขึ้น
      // =========================
      if (parsed.boxMax > Number(packProduct.max_box ?? 0)) {
        await tx.pack_product.update({
          where: { id: packProduct.id },
          data: {
            max_box: parsed.boxMax,
            updated_at: new Date(),
          },
        });

        await relabelPackProductBoxesByMax(tx, {
          packProductId: packProduct.id,
          newMaxBox: parsed.boxMax,
          fallbackPrefixRaw: parsed.prefixRaw,
        });

        packProduct.max_box = parsed.boxMax;
      }

      // =========================
      // BOX LOGIC
      // =========================
      const currentBox = await tx.pack_product_box.findFirst({
        where: {
          pack_product_id: packProduct.id,
          box_no: parsed.boxNo,
          deleted_at: null,
        },
        orderBy: { id: "desc" },
      });

      let boxAction: "created" | "opened" | "closed" | "reopened" = "opened";
      let activeBoxId: number;

      if (!currentBox) {
        const createdBox = await tx.pack_product_box.create({
          data: {
            pack_product_id: packProduct.id,
            box_no: parsed.boxNo,
            box_max: parsed.boxMax,
            box_label: `${parsed.boxNo}/${parsed.boxMax}`,
            box_code: parsed.fullBoxCode,
            status: "open",
          },
        });

        activeBoxId = createdBox.id;
        boxAction = "created";
      } else {
        if (String(currentBox.status ?? "").toLowerCase() === "open") {
          await tx.pack_product_box.update({
            where: { id: currentBox.id },
            data: {
              status: "closed",
              box_max: parsed.boxMax,
              box_label: `${parsed.boxNo}/${parsed.boxMax}`,
              box_code: parsed.fullBoxCode,
              updated_at: new Date(),
            },
          });

          activeBoxId = currentBox.id;
          boxAction = "closed";
        } else {
          await tx.pack_product_box.update({
            where: { id: currentBox.id },
            data: {
              status: "open",
              box_max: parsed.boxMax,
              box_label: `${parsed.boxNo}/${parsed.boxMax}`,
              box_code: parsed.fullBoxCode,
              updated_at: new Date(),
            },
          });

          activeBoxId = currentBox.id;
          boxAction = "reopened";
        }
      }

      return {
        packProductId: packProduct.id,
        activeBoxId,
        boxAction,
      };
    });

    const full = await loadPackProductFull(txResult.packProductId);
    if (!full) {
      throw notFound("ไม่พบ pack_product หลังจากบันทึกข้อมูล");
    }

    const currentBox =
      (full.boxes ?? []).find(
        (b: any) => Number(b.id) === Number(txResult.activeBoxId),
      ) ?? null;

    const adjustedFull = applyReturnToPackProduct(full as any);

    await emitPackProductSocketUpdate(txResult.packProductId);

    return res.json({
      message: "scan pack product สำเร็จ",
      data: {
        parsed: {
          raw: parsed.raw,
          prefix: parsed.prefixRaw,
          doc_keys: parsed.docKeys,
          box_no: parsed.boxNo,
          box_max: parsed.boxMax,
          box_label: parsed.boxLabel,
          box_code: parsed.fullBoxCode,
        },
        matches: matchSummary,
        batch_statuses: batchInfo.batch_statuses,
        box_action: txResult.boxAction,
        current_box: currentBox
          ? {
              id: currentBox.id,
              box_no: currentBox.box_no,
              box_max: currentBox.box_max,
              box_label: currentBox.box_label,
              box_code: currentBox.box_code,
              status: currentBox.status,
              created_at: currentBox.created_at,
              updated_at: currentBox.updated_at,
            }
          : null,
        ...formatPackProduct(adjustedFull as any),
      },
    });
  },
);


/**
 * POST /api/outbounds/pack-products/:packProductId/boxes/:boxId/scan-item
 */
export const scanPackProductItem = asyncHandler(
  async (
    req: Request<
      { packProductId: string; boxId: string },
      {},
      { barcode: string; qty_input?: number; user_ref?: string | null }
    >,
    res: Response,
  ) => {
    const packProductId = Number(req.params.packProductId);
    const boxId = Number(req.params.boxId);

    if (!Number.isFinite(packProductId)) {
      throw badRequest("packProductId ต้องเป็นตัวเลข");
    }
    if (!Number.isFinite(boxId)) {
      throw badRequest("boxId ต้องเป็นตัวเลข");
    }

    const rawBarcode = String(req.body?.barcode ?? "").trim();
    if (!rawBarcode) throw badRequest("กรุณาส่ง barcode");

    const qtyInput =
      req.body?.qty_input == null ? 1 : safeInt(req.body.qty_input, 1);

    if (!Number.isFinite(qtyInput) || qtyInput <= 0) {
      throw badRequest("qty_input ต้องมากกว่า 0");
    }

    const userRef =
      req.body?.user_ref == null
        ? null
        : String(req.body.user_ref).trim() || null;

    const packProduct = await prisma.pack_product.findUnique({
      where: { id: packProductId },
      include: {
        outbounds: {
          include: {
            outbound: {
              include: {
                goods_outs: {
                  where: { deleted_at: null },
                  include: {
                    barcode_ref: {
                      where: { deleted_at: null },
                    },
                  },
                  orderBy: [{ sequence: "asc" }, { id: "asc" }],
                },
              },
            },
          },
        },
      },
    });

    if (!packProduct || packProduct.deleted_at) {
      throw notFound("ไม่พบ pack_product");
    }

    const box = await prisma.pack_product_box.findFirst({
      where: {
        id: boxId,
        pack_product_id: packProductId,
        deleted_at: null,
      },
    });

    if (!box) throw notFound("ไม่พบ box ใน pack_product นี้");

    if (String(box.status ?? "").toLowerCase() !== "open") {
      throw badRequest("กล่องนี้ไม่ได้อยู่ในสถานะ open");
    }

    const parsed = await resolveBarcodeScan(rawBarcode);
    const parsedBarcodeText = normalizeText(parsed.barcode_text);
    const parsedLotSerial = normalizeText(parsed.lot_serial);

    const adjustedPackProduct = applyReturnToPackProduct(packProduct as any);

    const allItems = (adjustedPackProduct.outbounds ?? []).flatMap((row: any) =>
      (row.outbound?.goods_outs ?? []).map((item: any) => ({
        ...item,
        outbound_no: row.outbound?.no ?? null,
      })),
    );

    if (allItems.length === 0) {
      throw badRequest("pack_product นี้ไม่มี goods_out_item ให้ pack");
    }

    const matchedItems = allItems.filter((item: any) =>
      goodsOutItemBarcodeMatched({
        rawBarcode,
        parsedBarcodeText,
        parsedLotSerial,
        item,
      }),
    );

    if (matchedItems.length === 0) {
      throw notFound("ไม่พบสินค้าใน pack_product นี้ที่ตรงกับ barcode ที่สแกน");
    }

    const candidateItems = [...matchedItems]
      .map((item: any) => ({
        ...item,
        qty_num: Number(item.qty ?? 0),
        pack_num: Number(item.pack ?? 0),
        remaining: Math.max(0, Number(item.qty ?? 0) - Number(item.pack ?? 0)),
      }))
      .filter((item: any) => item.remaining > 0)
      .sort((a: any, b: any) => {
        const seqA = Number(a.sequence ?? 0);
        const seqB = Number(b.sequence ?? 0);
        if (seqA !== seqB) return seqA - seqB;
        return Number(a.id ?? 0) - Number(b.id ?? 0);
      });

    if (candidateItems.length === 0) {
      throw badRequest("สินค้านี้ pack ครบแล้ว");
    }

    const totalRemaining = candidateItems.reduce(
      (sum: number, item: any) => sum + Number(item.remaining ?? 0),
      0,
    );

    if (qtyInput > totalRemaining) {
      throw badRequest(
        `จำนวนที่จะ pack (${qtyInput}) มากกว่าจำนวนคงเหลือที่ pack ได้ (${totalRemaining})`,
      );
    }

    let qtyLeft = qtyInput;
    const allocations: Array<{
      item: any;
      qty: number;
    }> = [];

    for (const item of candidateItems) {
      if (qtyLeft <= 0) break;

      const remaining = Number(item.remaining ?? 0);
      if (remaining <= 0) continue;

      const allocateQty = Math.min(qtyLeft, remaining);
      if (allocateQty > 0) {
        allocations.push({
          item,
          qty: allocateQty,
        });
        qtyLeft -= allocateQty;
      }
    }

    if (allocations.length === 0 || qtyLeft > 0) {
      throw badRequest("ไม่สามารถกระจายจำนวน pack ไปยังรายการสินค้าได้");
    }

    const txResult = await prisma.$transaction(async (tx) => {
      const upsertedBoxItems: any[] = [];
      const syncedItems: any[] = [];

      for (const allocation of allocations) {
        const targetItem = allocation.item;
        const allocateQty = allocation.qty;

        const existingInThisBox = await tx.pack_product_box_item.findFirst({
          where: {
            pack_product_box_id: boxId,
            goods_out_item_id: targetItem.id,
            deleted_at: null,
          },
          select: {
            id: true,
            quantity: true,
          },
        });

        let packBoxItem;
        if (existingInThisBox) {
          packBoxItem = await tx.pack_product_box_item.update({
            where: { id: existingInThisBox.id },
            data: {
              quantity: {
                increment: allocateQty,
              },
              updated_at: new Date(),
            },
            select: {
              id: true,
              pack_product_box_id: true,
              goods_out_item_id: true,
              quantity: true,
              updated_at: true,
            },
          });
        } else {
          packBoxItem = await tx.pack_product_box_item.create({
            data: {
              pack_product_box_id: boxId,
              goods_out_item_id: targetItem.id,
              quantity: allocateQty,
            },
            select: {
              id: true,
              pack_product_box_id: true,
              goods_out_item_id: true,
              quantity: true,
              created_at: true,
              updated_at: true,
            },
          });
        }

        const syncedItem = await syncGoodsOutItemPackInPackProduct(
          tx,
          packProductId,
          targetItem.id,
          userRef,
        );

        upsertedBoxItems.push(packBoxItem);
        syncedItems.push({
          goods_out_item_id: targetItem.id,
          allocated_qty: allocateQty,
          synced: syncedItem,
          raw_item: targetItem,
        });
      }

      return {
        upsertedBoxItems,
        syncedItems,
      };
    });

    const currentBoxItems = await prisma.pack_product_box_item.findMany({
      where: {
        pack_product_box_id: boxId,
        deleted_at: null,
      },
      include: {
        goods_out_item: true,
      },
      orderBy: [{ id: "asc" }],
    });

    const firstMatched = allocations[0]?.item ?? matchedItems[0];

    const totalAllocated = txResult.syncedItems.reduce(
      (sum: number, row: any) => sum + Number(row.allocated_qty ?? 0),
      0,
    );

    const totalPackAfter = txResult.syncedItems.reduce(
      (sum: number, row: any) => sum + Number(row.synced?.pack ?? 0),
      0,
    );

    await emitPackProductSocketUpdate(packProductId);

    return res.json({
      message: "สแกนสินค้าเข้ากล่องสำเร็จ",
      data: {
        pack_product_id: packProductId,
        box: {
          id: box.id,
          box_no: box.box_no,
          box_max: box.box_max,
          box_label: box.box_label,
          box_code: box.box_code,
          status: box.status,
        },
        scan_result: {
          raw_input: parsed.raw_input,
          normalized_input: parsed.normalized_input,
          barcode_text: parsed.barcode_text,
          lot_serial: parsed.lot_serial,
          exp_text: parsed.exp_text,
          exp: parsed.exp ? parsed.exp.toISOString() : null,
          matched_by: parsed.matched_by,
        },
        matched_item: {
          id: firstMatched.id,
          outbound_id: firstMatched.outbound_id,
          outbound_no: firstMatched.outbound_no,
          sequence: firstMatched.sequence,
          product_id: firstMatched.product_id,
          code: firstMatched.code,
          name: firstMatched.name,
          unit: firstMatched.unit,
          lot_id: firstMatched.lot_id,
          lot_serial: firstMatched.lot_serial,
          qty: matchedItems.reduce(
            (sum: number, item: any) => sum + Number(item.qty ?? 0),
            0,
          ),
          pick: matchedItems.reduce(
            (sum: number, item: any) => sum + Number(item.pick ?? 0),
            0,
          ),
          pack_before: matchedItems.reduce(
            (sum: number, item: any) => sum + Number(item.pack ?? 0),
            0,
          ),
          pack_after: totalPackAfter,
          status_after:
            txResult.syncedItems.find(
              (x: any) =>
                String(x.raw_item?.status ?? "").toUpperCase() === "PACKED",
            )?.synced?.status ??
            txResult.syncedItems[0]?.synced?.status ??
            firstMatched.status,
        },
        allocations: txResult.syncedItems.map((row: any) => ({
          goods_out_item_id: row.goods_out_item_id,
          allocated_qty: row.allocated_qty,
          synced_item: row.synced,
          raw_item: {
            id: row.raw_item?.id,
            outbound_id: row.raw_item?.outbound_id,
            outbound_no: row.raw_item?.outbound_no,
            code: row.raw_item?.code,
            name: row.raw_item?.name,
            lot_serial: row.raw_item?.lot_serial,
            qty: row.raw_item?.qty,
            pick: row.raw_item?.pick,
            pack: row.raw_item?.pack,
            status: row.raw_item?.status,
          },
        })),
        total_allocated: totalAllocated,
        box_items: currentBoxItems.map((row) => ({
          id: row.id,
          goods_out_item_id: row.goods_out_item_id,
          quantity: row.quantity,
          goods_out_item: row.goods_out_item
            ? {
                id: row.goods_out_item.id,
                outbound_id: row.goods_out_item.outbound_id,
                code: row.goods_out_item.code,
                name: row.goods_out_item.name,
                lot_serial: row.goods_out_item.lot_serial,
                qty: row.goods_out_item.qty,
                pack: row.goods_out_item.pack,
                status: row.goods_out_item.status,
              }
            : null,
        })),
      },
    });
  },
);

/**
 * DELETE /api/outbounds/pack-products/:packProductId/boxes/:boxId/items/:packBoxItemId
 */
export const removePackProductBoxItem = asyncHandler(
  async (
    req: Request<
      {
        packProductId: string;
        boxId: string;
        packBoxItemId: string;
      },
      {},
      { quantity?: number; user_ref?: string | null }
    >,
    res: Response,
  ) => {
    const packProductId = Number(req.params.packProductId);
    const boxId = Number(req.params.boxId);
    const packBoxItemId = Number(req.params.packBoxItemId);

    if (!Number.isFinite(packProductId))
      throw badRequest("packProductId ต้องเป็นตัวเลข");
    if (!Number.isFinite(boxId)) throw badRequest("boxId ต้องเป็นตัวเลข");
    if (!Number.isFinite(packBoxItemId))
      throw badRequest("packBoxItemId ต้องเป็นตัวเลข");

    const qtyInput =
      req.body?.quantity == null ? null : safeInt(req.body.quantity, 0);

    if (qtyInput !== null && qtyInput <= 0) {
      throw badRequest("quantity ต้องมากกว่า 0");
    }

    const userRef =
      req.body?.user_ref == null
        ? null
        : String(req.body.user_ref).trim() || null;

    const box = await prisma.pack_product_box.findFirst({
      where: {
        id: boxId,
        pack_product_id: packProductId,
        deleted_at: null,
      },
      select: {
        id: true,
        pack_product_id: true,
        status: true,
        box_no: true,
        box_max: true,
        box_label: true,
        box_code: true,
      },
    });

    if (!box) throw notFound("ไม่พบ box ใน pack_product นี้");

    const existing = await prisma.pack_product_box_item.findFirst({
      where: {
        id: packBoxItemId,
        pack_product_box_id: boxId,
        deleted_at: null,
      },
      include: {
        goods_out_item: true,
      },
    });

    if (!existing) throw notFound("ไม่พบรายการสินค้าในกล่อง");

    const currentQty = Number(existing.quantity ?? 0);
    if (currentQty <= 0) throw badRequest("quantity ในกล่องเป็น 0 อยู่แล้ว");

    const removeQty = qtyInput == null ? currentQty : qtyInput;

    if (removeQty > currentQty) {
      throw badRequest(
        `จำนวนที่จะเอาออก (${removeQty}) มากกว่า quantity ในกล่อง (${currentQty})`,
      );
    }

    const txResult = await prisma.$transaction(async (tx) => {
      let updatedBoxItem: any = null;

      if (removeQty === currentQty) {
        await tx.pack_product_box_item.update({
          where: { id: existing.id },
          data: {
            deleted_at: new Date(),
            updated_at: new Date(),
          },
        });
      } else {
        updatedBoxItem = await tx.pack_product_box_item.update({
          where: { id: existing.id },
          data: {
            quantity: {
              decrement: removeQty,
            },
            updated_at: new Date(),
          },
          select: {
            id: true,
            pack_product_box_id: true,
            goods_out_item_id: true,
            quantity: true,
            updated_at: true,
          },
        });
      }

      const syncedItem = await syncGoodsOutItemPackInPackProduct(
        tx,
        packProductId,
        existing.goods_out_item_id,
        userRef,
      );

      return {
        removed_qty: removeQty,
        updatedBoxItem,
        syncedItem,
        goods_out_item_id: existing.goods_out_item_id,
      };
    });

    const boxItems = await loadPackBoxItems(boxId);

    await emitPackProductSocketUpdate(packProductId);

    return res.json({
      message: "เอาสินค้าออกจากกล่องสำเร็จ",
      data: {
        pack_product_id: packProductId,
        box: {
          id: box.id,
          box_no: box.box_no,
          box_max: box.box_max,
          box_label: box.box_label,
          box_code: box.box_code,
          status: box.status,
        },
        removed_qty: txResult.removed_qty,
        goods_out_item_id: txResult.goods_out_item_id,
        box_item: txResult.updatedBoxItem,
        synced_item: txResult.syncedItem,
        box_items: boxItems.map((row) => ({
          id: row.id,
          goods_out_item_id: row.goods_out_item_id,
          quantity: row.quantity,
          goods_out_item: row.goods_out_item
            ? {
                id: row.goods_out_item.id,
                outbound_id: row.goods_out_item.outbound_id,
                code: row.goods_out_item.code,
                name: row.goods_out_item.name,
                lot_serial: row.goods_out_item.lot_serial,
                qty: row.goods_out_item.qty,
                pack: row.goods_out_item.pack,
                status: row.goods_out_item.status,
              }
            : null,
        })),
      },
    });
  },
);

/**
 * POST /api/outbounds/pack-products/:packProductId/boxes/:boxId/scan-return
 */
export const scanPackProductItemReturn = asyncHandler(
  async (
    req: Request<
      { packProductId: string; boxId: string },
      {},
      { barcode: string; qty_input?: number; user_ref?: string | null }
    >,
    res: Response,
  ) => {
    const packProductId = Number(req.params.packProductId);
    const boxId = Number(req.params.boxId);

    if (!Number.isFinite(packProductId)) {
      throw badRequest("packProductId ต้องเป็นตัวเลข");
    }
    if (!Number.isFinite(boxId)) {
      throw badRequest("boxId ต้องเป็นตัวเลข");
    }

    const rawBarcode = String(req.body?.barcode ?? "").trim();
    if (!rawBarcode) throw badRequest("กรุณาส่ง barcode");

    const qtyInput =
      req.body?.qty_input == null ? 1 : safeInt(req.body.qty_input, 1);

    if (!Number.isFinite(qtyInput) || qtyInput <= 0) {
      throw badRequest("qty_input ต้องมากกว่า 0");
    }

    const userRef =
      req.body?.user_ref == null
        ? null
        : String(req.body.user_ref).trim() || null;

    const packProduct = await prisma.pack_product.findUnique({
      where: { id: packProductId },
      include: {
        outbounds: {
          include: {
            outbound: {
              include: {
                goods_outs: {
                  where: { deleted_at: null },
                  include: {
                    barcode_ref: {
                      where: { deleted_at: null },
                    },
                  },
                  orderBy: [{ sequence: "asc" }, { id: "asc" }],
                },
              },
            },
          },
        },
      },
    });

    if (!packProduct || packProduct.deleted_at) {
      throw notFound("ไม่พบ pack_product");
    }

    const box = await prisma.pack_product_box.findFirst({
      where: {
        id: boxId,
        pack_product_id: packProductId,
        deleted_at: null,
      },
      select: {
        id: true,
        status: true,
        box_no: true,
        box_max: true,
        box_label: true,
        box_code: true,
      },
    });

    if (!box) throw notFound("ไม่พบ box ใน pack_product นี้");

    const parsed = await resolveBarcodeScan(rawBarcode);
    const parsedBarcodeText = normalizeText(parsed.barcode_text);
    const parsedLotSerial = normalizeText(parsed.lot_serial);

    const allItems = (packProduct.outbounds ?? []).flatMap((row: any) =>
      (row.outbound?.goods_outs ?? []).map((item: any) => ({
        ...item,
        outbound_no: row.outbound?.no ?? null,
      })),
    );

    const targetItem = pickSingleMatchedItem(
      allItems,
      rawBarcode,
      parsedBarcodeText,
      parsedLotSerial,
    );

    const existingBoxItem = await prisma.pack_product_box_item.findFirst({
      where: {
        pack_product_box_id: boxId,
        goods_out_item_id: targetItem.id,
        deleted_at: null,
      },
      include: {
        goods_out_item: true,
      },
    });

    if (!existingBoxItem) {
      throw notFound("ไม่พบสินค้านี้ในกล่องปัจจุบัน");
    }

    const currentQty = Number(existingBoxItem.quantity ?? 0);
    if (qtyInput > currentQty) {
      throw badRequest(
        `จำนวนที่จะคืน (${qtyInput}) มากกว่า quantity ในกล่อง (${currentQty})`,
      );
    }

    const txResult = await prisma.$transaction(async (tx) => {
      let updatedBoxItem: any = null;

      if (qtyInput === currentQty) {
        await tx.pack_product_box_item.update({
          where: { id: existingBoxItem.id },
          data: {
            deleted_at: new Date(),
            updated_at: new Date(),
          },
        });
      } else {
        updatedBoxItem = await tx.pack_product_box_item.update({
          where: { id: existingBoxItem.id },
          data: {
            quantity: {
              decrement: qtyInput,
            },
            updated_at: new Date(),
          },
          select: {
            id: true,
            pack_product_box_id: true,
            goods_out_item_id: true,
            quantity: true,
            updated_at: true,
          },
        });
      }

      const syncedItem = await syncGoodsOutItemPackInPackProduct(
        tx,
        packProductId,
        targetItem.id,
        userRef,
      );

      return {
        removed_qty: qtyInput,
        updatedBoxItem,
        syncedItem,
      };
    });

    const boxItems = await loadPackBoxItems(boxId);

    await emitPackProductSocketUpdate(packProductId);

    return res.json({
      message: "scan return สำเร็จ",
      data: {
        pack_product_id: packProductId,
        box: {
          id: box.id,
          box_no: box.box_no,
          box_max: box.box_max,
          box_label: box.box_label,
          box_code: box.box_code,
          status: box.status,
        },
        scan_result: {
          raw_input: parsed.raw_input,
          normalized_input: parsed.normalized_input,
          barcode_text: parsed.barcode_text,
          lot_serial: parsed.lot_serial,
          exp_text: parsed.exp_text,
          exp: parsed.exp ? parsed.exp.toISOString() : null,
          matched_by: parsed.matched_by,
        },
        matched_item: {
          id: targetItem.id,
          outbound_id: targetItem.outbound_id,
          outbound_no: targetItem.outbound_no,
          sequence: targetItem.sequence,
          product_id: targetItem.product_id,
          code: targetItem.code,
          name: targetItem.name,
          unit: targetItem.unit,
          lot_id: targetItem.lot_id,
          lot_serial: targetItem.lot_serial,
          qty: targetItem.qty,
        },
        removed_qty: txResult.removed_qty,
        box_item: txResult.updatedBoxItem,
        synced_item: txResult.syncedItem,
        box_items: boxItems.map((row) => ({
          id: row.id,
          goods_out_item_id: row.goods_out_item_id,
          quantity: row.quantity,
          goods_out_item: row.goods_out_item
            ? {
                id: row.goods_out_item.id,
                outbound_id: row.goods_out_item.outbound_id,
                code: row.goods_out_item.code,
                name: row.goods_out_item.name,
                lot_serial: row.goods_out_item.lot_serial,
                qty: row.goods_out_item.qty,
                pack: row.goods_out_item.pack,
                status: row.goods_out_item.status,
              }
            : null,
        })),
      },
    });
  },
);

/**
 * POST /api/outbounds/pack-products/:packProductId/finalize
 */
export const finalizePackProduct = asyncHandler(
  async (
    req: Request<
      { packProductId: string },
      {},
      { user_ref?: string | null; force?: boolean }
    >,
    res: Response,
  ) => {
    const packProductId = Number(req.params.packProductId);
    if (!Number.isFinite(packProductId)) {
      throw badRequest("packProductId ต้องเป็นตัวเลข");
    }

    const userRef =
      req.body?.user_ref == null
        ? null
        : String(req.body.user_ref).trim() || null;
    const force = Boolean(req.body?.force);

    const packProduct = await prisma.pack_product.findUnique({
      where: { id: packProductId },
      include: {
        outbounds: {
          include: {
            outbound: {
              include: {
                goods_outs: {
                  where: { deleted_at: null },
                  orderBy: [{ sequence: "asc" }, { id: "asc" }],
                },
              },
            },
          },
        },
        boxes: {
          where: { deleted_at: null },
          include: {
            items: {
              where: { deleted_at: null },
            },
          },
          orderBy: [{ box_no: "asc" }, { id: "asc" }],
        },
      },
    });

    if (!packProduct || packProduct.deleted_at) {
      throw notFound("ไม่พบ pack_product");
    }

    if (String(packProduct.status ?? "").toLowerCase() === "completed") {
      return res.json({
        message: "pack_product นี้ถูก finalize แล้ว",
        data: {
          id: packProduct.id,
          name: packProduct.name,
          status: packProduct.status,
          already_completed: true,
        },
      });
    }
    const adjustedPackProduct = applyReturnToPackProduct(packProduct as any);
    const maxBox = Number(packProduct.max_box ?? 0);
    const boxes = Array.isArray(packProduct.boxes) ? packProduct.boxes : [];
    const uniqueBoxNos = (
      Array.from(
        new Set(
          boxes
            .map((b: any) => Number(b.box_no))
            .filter((n) => Number.isFinite(n) && n > 0),
        ),
      ) as number[]
    ).sort((a, b) => a - b);

    const openBoxes = boxes.filter(
      (b: any) => String(b.status ?? "").toLowerCase() === "open",
    );

    const missingBoxNos: number[] = [];
    for (let i = 1; i <= maxBox; i++) {
      if (!uniqueBoxNos.includes(i)) missingBoxNos.push(i);
    }

    const allItems = (adjustedPackProduct.outbounds ?? []).flatMap((row: any) =>
      (row.outbound?.goods_outs ?? []).map((item: any) => ({
        id: item.id,
        outbound_id: item.outbound_id,
        outbound_no: row.outbound?.no ?? null,
        code: item.code ?? null,
        name: item.name ?? null,
        lot_serial: item.lot_serial ?? null,
        qty: Number(item.qty ?? 0),
        pack: Number(item.pack ?? 0),
        status: item.status ?? null,
      })),
    );

    const incompleteItems = allItems.filter((item: any) => {
      const qty = Number(item.qty ?? 0);
      const pack = Number(item.pack ?? 0);
      return qty > 0 && pack < qty;
    });

    if (!force) {
      if (openBoxes.length > 0) {
        throw badRequest(
          `ยังมีกล่องที่เปิดอยู่ ${openBoxes
            .map((b: any) => b.box_label || `${b.box_no}/${b.box_max}`)
            .join(", ")}`,
        );
      }

      if (maxBox > 0 && missingBoxNos.length > 0) {
        throw badRequest(
          `จำนวนกล่องยังไม่ครบตาม max_box (${maxBox}) ขาดกล่อง: ${missingBoxNos.join(", ")}`,
        );
      }

      if (incompleteItems.length > 0) {
        throw badRequest(
          `ยังมีสินค้าที่ยัง pack ไม่ครบ ${incompleteItems.length} รายการ`,
        );
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      await tx.pack_product_box.updateMany({
        where: {
          pack_product_id: packProductId,
          deleted_at: null,
        },
        data: {
          status: "closed",
          updated_at: new Date(),
        },
      });

      for (const item of allItems) {
        const qty = Number(item.qty ?? 0);
        const pack = Number(item.pack ?? 0);

        const shouldComplete = force ? pack > 0 : qty > 0 && pack >= qty;
        if (!shouldComplete) continue;

        await tx.goods_out_item.update({
          where: { id: item.id },
          data: {
            status: "completed",
            user_pack: userRef,
            pack_time: new Date(),
            updated_at: new Date(),
          },
        });
      }

      const updatedPack = await tx.pack_product.update({
        where: { id: packProductId },
        data: {
          status: "completed",
          remark: userRef
            ? `finalized_by=${userRef}`
            : (packProduct.remark ?? null),
          updated_at: new Date(),
        },
        select: {
          id: true,
          name: true,
          scan_prefix: true,
          max_box: true,
          status: true,
          batch_name: true,
          created_at: true,
          updated_at: true,
        },
      });

      return updatedPack;
    });

    await emitPackProductSocketUpdate(packProductId);

    return res.json({
      message: "finalize pack_product สำเร็จ",
      data: {
        pack_product: result,
        summary: {
          total_boxes: boxes.length,
          distinct_box_count: uniqueBoxNos.length,
          max_box: maxBox,
          open_box_count: openBoxes.length,
          missing_box_nos: missingBoxNos,
          total_items: allItems.length,
          incomplete_items: incompleteItems,
          force,
        },
      },
    });
  },
);
