import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";
import {
  resolveBarcodeScan,
  normalizeScanText,
  normalizeBarcodeBaseForMatch,
  findMasterBarcodeForScan,
} from "../utils/helper_scan/barcode";
import { io } from "../index";

/**
 * =========================
 * Socket Helpers
 * =========================
 */

type TransferDocSocketPayload = {
  transfer_doc_no: string;
  transfer_doc_id: number;
  event: string;
  data: any;
};

function emitTransferDocSocket(payload: TransferDocSocketPayload) {
  try {
    io.to(`transfer_doc:${payload.transfer_doc_no}`).emit(
      payload.event,
      payload,
    );
    io.to(`transfer_doc-id:${payload.transfer_doc_id}`).emit(
      payload.event,
      payload,
    );

    io.to(`transfer_doc:${payload.transfer_doc_no}`).emit(
      "transfer_doc:update",
      payload,
    );
    io.to(`transfer_doc-id:${payload.transfer_doc_id}`).emit(
      "transfer_doc:update",
      payload,
    );
  } catch (error) {
    console.error("emitTransferDocSocket error:", error);
  }
}

/**
 * =========================
 * Helpers
 * =========================
 */

async function resolveLocationByFullName(full_name: string) {
  const loc = await prisma.location.findFirst({
    where: { full_name, deleted_at: null },
    select: { id: true, full_name: true, ncr_check: true },
  });
  if (!loc) throw badRequest(`ไม่พบ location full_name: ${full_name}`);
  return loc;
}

// ใช้ quantity_count เป็น "pick" ของ transfer_doc_item
function getPickedFromItem(it: any): number {
  const v = it.quantity_count ?? 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function getRequiredFromItem(it: any): number {
  const v = it.qty ?? 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

type TransferPickLocationRow = {
  location_id: number;
  location_name: string;
  confirmed_qty: number;
};

type TransferPutLocationRow = {
  location_id: number;
  location_name: string;
  confirmed_put: number;
};

function normalizeLocationNameListFromBody(body: any): string[] {
  const names: string[] = [];

  const single = String(body?.location_full_name ?? "").trim();
  if (single) names.push(single);

  if (Array.isArray(body?.locations)) {
    for (const loc of body.locations) {
      const name = String(loc?.location_full_name ?? "").trim();
      if (name) names.push(name);
    }
  }

  return Array.from(new Set(names));
}

async function resolveLocationsByFullNames(fullNames: string[]) {
  const normalized = Array.from(
    new Set(fullNames.map((x) => String(x ?? "").trim()).filter(Boolean)),
  );

  if (normalized.length === 0) {
    throw badRequest(
      "กรุณาส่ง location_full_name หรือ locations[].location_full_name",
    );
  }

  const rows = await prisma.location.findMany({
    where: {
      deleted_at: null,
      full_name: { in: normalized },
    },
    select: {
      id: true,
      full_name: true,
      ncr_check: true,
    },
  });

  const byName = new Map(rows.map((x) => [x.full_name, x]));

  for (const name of normalized) {
    if (!byName.has(name)) {
      throw badRequest(`ไม่พบ location full_name: ${name}`);
    }
  }

  return normalized.map((name) => byName.get(name)!);
}

async function seedTransferDocLocationDraftRowsTx(
  tx: Prisma.TransactionClient,
  input: {
    transfer_doc_id: number;
    location_ids: number[];
  },
) {
  const itemRows = await tx.transfer_doc_item.findMany({
    where: {
      transfer_doc_id: input.transfer_doc_id,
      deleted_at: null,
    },
    select: {
      id: true,
    },
  });

  if (itemRows.length === 0 || input.location_ids.length === 0) return;

  for (const item of itemRows) {
    for (const location_id of input.location_ids) {
      await tx.transfer_doc_item_location_confirm.upsert({
        where: {
          uniq_tf_location: {
            transfer_doc_item_id: item.id,
            location_id,
          },
        },
        update: {},
        create: {
          transfer_doc_item_id: item.id,
          location_id,
          confirmed_qty: 0,
        },
      });

      await tx.transfer_doc_item_location_put_confirm.upsert({
        where: {
          uniq_tf_put_location: {
            transfer_doc_item_id: item.id,
            location_id,
          },
        },
        update: {},
        create: {
          transfer_doc_item_id: item.id,
          location_id,
          confirmed_put: 0,
        },
      });
    }
  }
}

async function buildTransferDocDetail(docId: number, docNo: string) {
  const rows = await prisma.transfer_doc_item.findMany({
    where: { transfer_doc_id: docId, deleted_at: null },
    select: {
      id: true,
      sequence: true,
      product_id: true,
      code: true,
      name: true,
      unit: true,
      tracking: true,
      lot_id: true,
      lot: true,
      lot_serial: true,
      exp: true,

      qty: true,
      quantity_receive: true,
      quantity_count: true,
      quantity_put: true as any,
      barcode_id: true,
      barcode_text: true as any,

      created_at: true,
      updated_at: true,
      user_ref: true as any,
      in_process: true as any,
    },
    orderBy: [{ sequence: "asc" }, { created_at: "asc" }],
  });

  const itemIds = rows.map((x: any) => String(x.id));

  const pickConfirmRows =
    itemIds.length > 0
      ? await prisma.transfer_doc_item_location_confirm.findMany({
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
        })
      : [];

  const putConfirmRows =
    itemIds.length > 0
      ? await prisma.transfer_doc_item_location_put_confirm.findMany({
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
        })
      : [];

  const pickMap = new Map<string, TransferPickLocationRow[]>();
  for (const row of pickConfirmRows as any[]) {
    const key = String(row.transfer_doc_item_id);
    const arr = pickMap.get(key) ?? [];
    arr.push({
      location_id: Number(row.location_id),
      location_name: String(row.location?.full_name ?? ""),
      confirmed_qty: Number(row.confirmed_qty ?? 0),
    });
    pickMap.set(key, arr);
  }

  const putMap = new Map<string, TransferPutLocationRow[]>();
  for (const row of putConfirmRows as any[]) {
    const key = String(row.transfer_doc_item_id);
    const arr = putMap.get(key) ?? [];
    arr.push({
      location_id: Number(row.location_id),
      location_name: String(row.location?.full_name ?? ""),
      confirmed_put: Number(row.confirmed_put ?? 0),
    });
    putMap.set(key, arr);
  }

  const lines = rows.map((x: any) => {
    const required = getRequiredFromItem(x);
    const picked = getPickedFromItem(x);
    const putQty = Number(x.quantity_put ?? 0);

    return {
      ...x,
      pick_locations: pickMap.get(String(x.id)) ?? [],
      put_locations: putMap.get(String(x.id)) ?? [],
      qty_required: required,
      qty_pick: picked,
      qty_put: putQty,
      remaining: Math.max(0, required - picked),
      remaining_put: Math.max(0, required - putQty),
      completed: required > 0 ? picked >= required : true,
      put_completed: required > 0 ? putQty >= required : true,
    };
  });

  const completed = lines.every((l) => l.completed);
  const put_completed = lines.every((l) => l.put_completed);

  return {
    no: docNo,
    total_items: lines.length,
    completed,
    put_completed,
    lines,
  };
}

/**
 * =========================
 * 1) Scan Location (TransferDoc)
 * POST /api/transfer_docs/:no/scan/location
 * body: { location_full_name }
 * =========================
 */
export const scanTransferDocLocation = asyncHandler(
  async (
    req: Request<{ no: string }, {}, { location_full_name: string }>,
    res: Response,
  ) => {
    const no = decodeURIComponent(req.params.no);
    const location_full_name = String(req.body.location_full_name ?? "").trim();
    if (!location_full_name) throw badRequest("กรุณาส่ง location_full_name");

    const doc = await prisma.transfer_doc.findUnique({
      where: { no },
      select: {
        id: true,
        no: true,
        deleted_at: true,
        location_dest: true, // 👈 เพิ่มตรงนี้
      },
    });

    if (!doc) throw notFound(`ไม่พบ transfer_doc: ${no}`);
    if (doc.deleted_at) throw badRequest("TransferDoc นี้ถูกลบไปแล้ว");

    const loc = await resolveLocationByFullName(location_full_name);

    // ✅ เงื่อนไขสำคัญ
    if (String(doc.location_dest ?? "").trim() === "WH/MDT") {
      if (!loc.ncr_check) {
        throw badRequest(
          "ปลายทางเป็น WH/MDT ต้อง scan ได้เฉพาะ location ประเภท EXP/NCR เท่านั้น",
        );
      }
    }

    const detail = await buildTransferDocDetail(doc.id, no);

    const responseData = {
      location: {
        location_id: loc.id,
        location_name: loc.full_name,
        ncr_check: loc.ncr_check,
      },
      ...detail,
    };

    emitTransferDocSocket({
      transfer_doc_no: no,
      transfer_doc_id: doc.id,
      event: "transfer_doc:scan_location",
      data: responseData,
    });

    return res.json(responseData);
  },
);

/**
 * =========================
 * 1B) Scan NCR Location (TransferDoc)
 * POST /api/transfer_docs/:no/scan/location/ncr
 * body: { location_full_name }
 * ✅ allow only ncr_check = true
 * =========================
 */
export const scanTransferDocNcrLocation = asyncHandler(
  async (
    req: Request<
      { no: string },
      {},
      {
        location_full_name?: string;
        locations?: Array<{ location_full_name: string }>;
      }
    >,
    res: Response,
  ) => {
    const no = decodeURIComponent(req.params.no);

    const doc = await prisma.transfer_doc.findUnique({
      where: { no },
      select: {
        id: true,
        no: true,
        deleted_at: true,
        location_dest: true,
      },
    });

    if (!doc) throw notFound(`ไม่พบ transfer_doc: ${no}`);
    if (doc.deleted_at) throw badRequest("TransferDoc นี้ถูกลบไปแล้ว");

    const requestedNames = normalizeLocationNameListFromBody(req.body);
    const locations = await resolveLocationsByFullNames(requestedNames);

    const destName = String(doc.location_dest ?? "").trim();
    const destUpper = destName.toUpperCase();

    const isMdtDest = destUpper === "WH/MDT";

    for (const loc of locations) {
      /**
       * ถ้าปลายทางเป็น WH/MDT
       * ต้องเหมือน scanTransferDocLocation:
       * ห้าม scan Location ที่เป็น NCR / EXP NCR
       */
      if (isMdtDest && loc.ncr_check) {
        throw badRequest(
          `ปลายทางเป็น ${destName} ไม่อนุญาตให้สแกน Location NCR/EXP NCR: ${loc.full_name}`,
        );
      }

      /**
       * ถ้าไม่ใช่ WH/MDT เช่น WH/M_EXP&NCR
       * ให้ใช้ behavior เดิมของฟังก์ชันนี้:
       * ต้อง scan ได้เฉพาะ NCR เท่านั้น
       */
      if (!isMdtDest && !loc.ncr_check) {
        throw badRequest(
          `Location นี้ไม่ใช่ NCR (ncr_check=false) ไม่อนุญาตให้สแกน: ${loc.full_name}`,
        );
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.transfer_doc.update({
        where: { id: doc.id },
        data: {
          updated_at: new Date(),
        },
      });

      await seedTransferDocLocationDraftRowsTx(tx, {
        transfer_doc_id: doc.id,
        location_ids: locations.map((x) => x.id),
      });
    });

    const detail = await buildTransferDocDetail(doc.id, no);

    const responseData = {
      location:
        locations.length > 0
          ? {
              location_id: locations[0].id,
              location_name: locations[0].full_name,
              ncr_check: locations[0].ncr_check,
            }
          : null,
      locations: locations.map((loc) => ({
        location_id: loc.id,
        location_name: loc.full_name,
        ncr_check: loc.ncr_check,
      })),
      ...detail,
    };

    emitTransferDocSocket({
      transfer_doc_no: no,
      transfer_doc_id: doc.id,
      event: "transfer_doc:scan_location_ncr",
      data: responseData,
    });

    return res.json(responseData);
  },
);

/**
 * =========================
 * 2) Scan Pick (TransferDoc) (Preview)
 * POST /api/transfer_docs/:no/scan/pick
 * body: { item_id: string; location_full_name: string; qty_input?: number }
 * =========================
 */
export const scanTransferDocPick = asyncHandler(
  async (
    req: Request<
      { no: string },
      {},
      { item_id: string; location_full_name: string; qty_input?: number }
    >,
    res: Response,
  ) => {
    const no = decodeURIComponent(req.params.no);
    const location_full_name = (req.body.location_full_name || "").trim();
    const itemId = String(req.body.item_id ?? "").trim();

    if (!location_full_name) throw badRequest("กรุณาส่ง location_full_name");
    if (!itemId) throw badRequest("กรุณาส่ง item_id");

    const doc = await prisma.transfer_doc.findUnique({
      where: { no },
      select: { id: true, deleted_at: true },
    });
    if (!doc) throw notFound(`ไม่พบ transfer_doc: ${no}`);
    if (doc.deleted_at) throw badRequest("TransferDoc นี้ถูกลบไปแล้ว");

    const loc = await resolveLocationByFullName(location_full_name);

    const item = await prisma.transfer_doc_item.findFirst({
      where: { id: itemId, transfer_doc_id: doc.id, deleted_at: null },
      select: {
        id: true,
        product_id: true,
        lot_id: true,
        qty: true,
        quantity_count: true,
        code: true,
        name: true,
      },
    });
    if (!item) throw notFound(`ไม่พบ item: ${itemId}`);

    const required = getRequiredFromItem(item);
    const currentPick = getPickedFromItem(item);

    const addQty =
      req.body.qty_input != null
        ? Math.max(1, Math.floor(Number(req.body.qty_input)))
        : 1;

    const nextPickPreview =
      required > 0
        ? Math.min(required, currentPick + addQty)
        : currentPick + addQty;

    const detail = await buildTransferDocDetail(doc.id, no);
    const matchedLine = detail.lines.find((l: any) => l.id === item.id) ?? null;

    const responseData = {
      location: { location_id: loc.id, location_name: loc.full_name },
      addQty,
      nextPickPreview,
      matchedLine,
      ...detail,
    };

    emitTransferDocSocket({
      transfer_doc_no: no,
      transfer_doc_id: doc.id,
      event: "transfer_doc:scan_pick_preview",
      data: responseData,
    });

    return res.json(responseData);
  },
);

/**
 * =========================
 * TransferDoc: Scan Barcode (Preview pick)
 * POST /api/transfer_docs/:no/scan/barcode
 * body: { barcode: string; location_full_name: string; qty_input?: number }
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

async function findWmsGoodsExpByProductLot(
  product_id: number,
  lot_id: number | null,
) {
  if (!product_id) return null;

  const row = await prisma.wms_mdt_goods.findFirst({
    where: {
      product_id,
      ...(lot_id != null ? { lot_id } : {}),
    },
    select: {
      expiration_date: true,
      id: true,
    },
    orderBy: [{ id: "desc" }],
  });

  return row?.expiration_date ?? null;
}

export const scanTransferDocBarcode = asyncHandler(
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

    const doc = await prisma.transfer_doc.findUnique({
      where: { no },
      select: { id: true, no: true, deleted_at: true },
    });

    if (!doc) throw notFound(`ไม่พบ transfer_doc: ${no}`);
    if (doc.deleted_at) throw badRequest("TransferDoc นี้ถูกลบไปแล้ว");

    const loc = await resolveLocationByFullName(location_full_name);

    const parsed = await resolveBarcodeScan(barcodeText);

    const rows = await prisma.transfer_doc_item.findMany({
      where: {
        transfer_doc_id: doc.id,
        deleted_at: null,
        barcode_text: { not: null },
      } as any,
      select: {
        id: true,
        product_id: true,
        lot_id: true,
        lot_serial: true,
        exp: true,
        qty: true,
        quantity_count: true,
        code: true,
        name: true,
        unit: true,
        barcode_text: true as any,
        in_process: true,
      },
      orderBy: [{ sequence: "asc" }, { created_at: "asc" }],
    });

    const barcodeBase = normalizeBarcodeBaseForMatch(parsed.barcode_text ?? "");

    const candidates = rows.filter((x: any) => {
      const itemBase = normalizeBarcodeBaseForMatch(x.barcode_text ?? "");
      if (!itemBase) return false;
      return itemBase === barcodeBase;
    });

    let matchedItem: (typeof candidates)[number] | null = null;

    for (const item of candidates) {
      const lotMatched =
        normalizeScanText(item.lot_serial ?? "") ===
        normalizeScanText(parsed.lot_serial ?? "");

      const itemExpFromWms =
        item.product_id != null
          ? await findWmsGoodsExpByProductLot(
              Number(item.product_id),
              item.lot_id ?? null,
            )
          : null;

      const effectiveItemExp = item.exp ?? itemExpFromWms ?? null;

      const itemExpKey = effectiveItemExp
        ? new Date(effectiveItemExp).toISOString().slice(0, 10)
        : null;

      const parsedExpKey = parsed.exp
        ? new Date(parsed.exp).toISOString().slice(0, 10)
        : null;

      const expMatched = itemExpKey === parsedExpKey;

      if (!lotMatched) continue;
      if (!expMatched) continue;

      matchedItem = item;
      break;
    }

    if (!matchedItem) {
      throw badRequest(
        `ไม่พบ transfer_doc_item ที่ตรงกับ barcode_text + lot_serial + exp`,
      );
    }

    if (matchedItem.product_id == null) {
      throw badRequest("transfer_doc_item.product_id เป็น null");
    }

    const bc = parsed.barcode_text
      ? await findMasterBarcodeForScan(parsed.barcode_text)
      : null;

    const inputNumber = await resolveInputNumber(
      matchedItem.product_id,
      matchedItem.lot_id ?? null,
    );

    let addQty = 1;
    const q = req.body.qty_input;
    if (q != null && Number.isFinite(Number(q)) && Number(q) > 0) {
      addQty = Math.floor(Number(q));
    }

    let beforeCount = 0;
    let afterCount = 0;
    let beforeLocCount = 0;
    let afterLocCount = 0;
    let appliedQty = 0;

    await prisma.$transaction(async (tx) => {
      const fresh = await tx.transfer_doc_item.findUnique({
        where: { id: matchedItem!.id },
        select: {
          id: true,
          qty: true,
          quantity_count: true,
          in_process: true,
        },
      });

      if (!fresh) {
        throw badRequest("ไม่พบ transfer_doc_item ที่ต้องการอัปเดต");
      }

      const requiredQty = Number(fresh.qty ?? 0);
      const currentPick = Number(fresh.quantity_count ?? 0);

      beforeCount = currentPick;

      if (requiredQty > 0 && currentPick >= requiredQty) {
        throw badRequest("รายการนี้ pick ครบแล้ว ไม่สามารถ pick เพิ่มได้");
      }

      const nextPick =
        requiredQty > 0
          ? Math.min(requiredQty, currentPick + addQty)
          : currentPick + addQty;

      appliedQty = Math.max(0, nextPick - currentPick);
      if (appliedQty <= 0) {
        throw badRequest("รายการนี้ pick ครบแล้ว ไม่สามารถ pick เพิ่มได้");
      }

      const existingConfirm =
        await tx.transfer_doc_item_location_confirm.findUnique({
          where: {
            uniq_tf_location: {
              transfer_doc_item_id: fresh.id,
              location_id: loc.id,
            },
          },
          select: {
            confirmed_qty: true,
          },
        });

      beforeLocCount = Number(existingConfirm?.confirmed_qty ?? 0);
      afterLocCount = beforeLocCount + appliedQty;
      afterCount = nextPick;

      await tx.transfer_doc_item.update({
        where: { id: fresh.id },
        data: {
          quantity_count: nextPick,
          in_process: nextPick > 0,
          updated_at: new Date(),
          ...(user_ref ? { user_ref } : {}),
        },
      });

      await tx.transfer_doc_item_location_confirm.upsert({
        where: {
          uniq_tf_location: {
            transfer_doc_item_id: fresh.id,
            location_id: loc.id,
          },
        },
        update: {
          confirmed_qty: afterLocCount,
          updated_at: new Date(),
        },
        create: {
          transfer_doc_item_id: fresh.id,
          location_id: loc.id,
          confirmed_qty: appliedQty,
        },
      });

      await tx.transfer_doc.update({
        where: { id: doc.id },
        data: {
          updated_at: new Date(),
        },
      });
    });

    const detail = await buildTransferDocDetail(doc.id, no);
    const matchedLine =
      detail.lines.find((l: any) => String(l.id) === String(matchedItem!.id)) ??
      null;

    const responseData = {
      location: {
        location_id: loc.id,
        location_name: loc.full_name,
        ncr_check: loc.ncr_check,
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
      addQty: appliedQty,
      nextPickPreview: afterCount,
      scan_result: {
        before_count: beforeCount,
        after_count: afterCount,
        before_location_count: beforeLocCount,
        after_location_count: afterLocCount,
      },
      matchedLine,
      ...detail,
    };

    emitTransferDocSocket({
      transfer_doc_no: no,
      transfer_doc_id: doc.id,
      event: "transfer_doc:scan_barcode",
      data: responseData,
    });

    return res.json(responseData);
  },
);

export const scanTransferDocBarcodePut = asyncHandler(
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

    const doc = await prisma.transfer_doc.findUnique({
      where: { no },
      select: { id: true, no: true, deleted_at: true },
    });
    if (!doc) throw notFound(`ไม่พบ transfer_doc: ${no}`);
    if (doc.deleted_at) throw badRequest("TransferDoc นี้ถูกลบไปแล้ว");

    const loc = await resolveLocationByFullName(location_full_name);
    const parsed = await resolveBarcodeScan(barcodeText);

    const rows = await prisma.transfer_doc_item.findMany({
      where: {
        transfer_doc_id: doc.id,
        deleted_at: null,
        barcode_text: { not: null },
      } as any,
      select: {
        id: true,
        product_id: true,
        lot_id: true,
        lot_serial: true,
        exp: true,
        qty: true,
        quantity_count: true,
        quantity_put: true,
        code: true,
        name: true,
        unit: true,
        barcode_text: true as any,
        in_process: true,
      },
      orderBy: [{ sequence: "asc" }, { created_at: "asc" }],
    });

    const barcodeBase = normalizeBarcodeBaseForMatch(parsed.barcode_text ?? "");
    const candidates = rows.filter((x: any) => {
      const itemBase = normalizeBarcodeBaseForMatch(x.barcode_text ?? "");
      if (!itemBase) return false;
      return itemBase === barcodeBase;
    });

    if (!candidates.length) {
      throw badRequest(
        `ไม่พบ transfer_doc_item ที่ตรงกับ barcode นี้ใน doc: ${no}`,
      );
    }

    let matchedItem: (typeof candidates)[number] | null = null;

    for (const item of candidates) {
      const lotMatched =
        normalizeScanText(item.lot_serial ?? "") ===
        normalizeScanText(parsed.lot_serial ?? "");

      const itemExpFromWms =
        item.product_id != null && item.lot_id != null
          ? await findWmsGoodsExpByProductLot(
              Number(item.product_id),
              Number(item.lot_id),
            )
          : null;

      const effectiveItemExp = item.exp ?? itemExpFromWms ?? null;

      const itemExpKey = effectiveItemExp
        ? new Date(effectiveItemExp).toISOString().slice(0, 10)
        : null;

      const parsedExpKey = parsed.exp
        ? new Date(parsed.exp).toISOString().slice(0, 10)
        : null;

      const expMatched = itemExpKey === parsedExpKey;

      if (!lotMatched) continue;
      if (!expMatched) continue;

      matchedItem = item;
      break;
    }

    if (!matchedItem) {
      throw badRequest(
        `ไม่พบ transfer_doc_item ที่ตรงกับ barcode_text + lot_serial + exp ใน doc: ${no}`,
      );
    }

    if (matchedItem.product_id == null) {
      throw badRequest("transfer_doc_item.product_id เป็น null");
    }

    const bc = parsed.barcode_text
      ? await findMasterBarcodeForScan(parsed.barcode_text)
      : null;

    const inputNumber = await resolveInputNumber(
      matchedItem.product_id,
      matchedItem.lot_id ?? null,
    );

    let addQty = 1;
    const q = req.body.qty_input;
    if (q != null && Number.isFinite(Number(q)) && Number(q) > 0) {
      addQty = Math.floor(Number(q));
    }

    let beforePut = 0;
    let afterPut = 0;
    let beforeLocPut = 0;
    let afterLocPut = 0;
    let appliedQty = 0;

    await prisma.$transaction(async (tx) => {
      const fresh = await tx.transfer_doc_item.findUnique({
        where: { id: matchedItem!.id },
        select: {
          id: true,
          qty: true,
          quantity_put: true,
          in_process: true,
        },
      });

      if (!fresh) {
        throw badRequest("ไม่พบ transfer_doc_item ที่ต้องการอัปเดต");
      }

      const requiredQty = Number(fresh.qty ?? 0);
      const currentPut = Number(fresh.quantity_put ?? 0);

      beforePut = currentPut;

      if (requiredQty > 0 && currentPut >= requiredQty) {
        throw badRequest("รายการนี้ put ครบแล้ว ไม่สามารถ put เพิ่มได้");
      }

      const nextPut =
        requiredQty > 0
          ? Math.min(requiredQty, currentPut + addQty)
          : currentPut + addQty;

      appliedQty = Math.max(0, nextPut - currentPut);
      if (appliedQty <= 0) {
        throw badRequest("รายการนี้ put ครบแล้ว ไม่สามารถ put เพิ่มได้");
      }

      const existingPutConfirm =
        await tx.transfer_doc_item_location_put_confirm.findUnique({
          where: {
            uniq_tf_put_location: {
              transfer_doc_item_id: fresh.id,
              location_id: loc.id,
            },
          },
          select: {
            confirmed_put: true,
          },
        });

      beforeLocPut = Number(existingPutConfirm?.confirmed_put ?? 0);
      afterLocPut = beforeLocPut + appliedQty;
      afterPut = nextPut;

      await tx.transfer_doc_item.update({
        where: { id: fresh.id },
        data: {
          quantity_put: nextPut,
          in_process: true,
          updated_at: new Date(),
          ...(user_ref ? { user_ref } : {}),
        },
      });

      await tx.transfer_doc_item_location_put_confirm.upsert({
        where: {
          uniq_tf_put_location: {
            transfer_doc_item_id: fresh.id,
            location_id: loc.id,
          },
        },
        update: {
          confirmed_put: afterLocPut,
          updated_at: new Date(),
        },
        create: {
          transfer_doc_item_id: fresh.id,
          location_id: loc.id,
          confirmed_put: appliedQty,
        },
      });

      await tx.transfer_doc.update({
        where: { id: doc.id },
        data: {
          updated_at: new Date(),
        },
      });
    });

    const detail = await buildTransferDocDetail(doc.id, no);
    const matchedLine =
      detail.lines.find((l: any) => String(l.id) === String(matchedItem!.id)) ??
      null;

    const responseData = {
      location: {
        location_id: loc.id,
        location_name: loc.full_name,
        ncr_check: loc.ncr_check,
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
      addQty: appliedQty,
      nextPutPreview: afterPut,
      scan_result: {
        before_put: beforePut,
        after_put: afterPut,
        before_location_put: beforeLocPut,
        after_location_put: afterLocPut,
      },
      matchedLine,
      ...detail,
    };

    emitTransferDocSocket({
      transfer_doc_no: no,
      transfer_doc_id: doc.id,
      event: "transfer_doc:scan_barcode_put",
      data: responseData,
    });

    return res.json(responseData);
  },
);
/**
 * =========================
 * 3) Confirm Pick (TransferDoc) -> update confirm table + item.quantity_count
 * ✅ multi-location
 * ✅ delta mode (lines[].pick = delta)
 * ✅ NO STOCK CHANGE
 * =========================
 */

export type ConfirmTransferDocPickBody =
  | {
      location_full_name: string;
      user_ref?: string | null;
      lines: Array<{
        transfer_doc_item_id: string;
        location_full_name?: string;
        pick: number;
        put?: number;
        quantity_put?: number;
      }>;
    }
  | {
      user_ref?: string | null;
      locations: Array<{
        location_full_name: string;
        lines: Array<{
          transfer_item_id?: string;
          transfer_doc_item_id?: string;
          quantity_count?: number;
          pick?: number;
          quantity_put?: number;
          put?: number;
        }>;
      }>;
    };

const confirmKey = (transfer_doc_item_id: string, location_id: number) =>
  `tfi:${transfer_doc_item_id}|loc:${location_id}`;

function normalizeConfirmPayload(body: any): {
  user_ref: string | null;
  rootLoc: string;
  lines: Array<{
    transfer_doc_item_id: string;
    location_full_name: string;
    pick: number;
    put: number;
  }>;
} {
  const userRefRaw = body?.user_ref ?? null;
  const user_ref =
    userRefRaw == null ? null : String(userRefRaw).trim() || null;

  if (Array.isArray(body?.locations) && body.locations.length > 0) {
    const flat: Array<{
      transfer_doc_item_id: string;
      location_full_name: string;
      pick: number;
      put: number;
    }> = [];

    for (const loc of body.locations) {
      const locName = String(loc?.location_full_name ?? "").trim();
      if (!locName) continue;

      const ls = Array.isArray(loc?.lines) ? loc.lines : [];
      for (const l of ls) {
        const itemId = String(
          l?.transfer_doc_item_id ?? l?.transfer_item_id ?? "",
        ).trim();
        if (!itemId) continue;

        const pickRaw = l?.pick ?? l?.quantity_count ?? 0;
        const putRaw = l?.put ?? l?.quantity_put ?? 0;

        flat.push({
          transfer_doc_item_id: itemId,
          location_full_name: locName,
          pick: Number(pickRaw),
          put: Number(putRaw),
        });
      }
    }

    const rootLoc = String(
      body?.location_full_name ?? flat[0]?.location_full_name ?? "",
    ).trim();

    return { user_ref, rootLoc, lines: flat };
  }

  const rootLoc = String(body?.location_full_name ?? "").trim();
  const ls = Array.isArray(body?.lines) ? body.lines : [];

  const flat = ls.map((l: any) => ({
    transfer_doc_item_id: String(l?.transfer_doc_item_id ?? "").trim(),
    location_full_name: String(l?.location_full_name ?? rootLoc).trim(),
    pick: Number(l?.pick ?? l?.quantity_count ?? 0),
    put: Number(l?.put ?? l?.quantity_put ?? 0),
  }));

  return { user_ref, rootLoc, lines: flat };
}

function normalizeDateOnlyKey(v: unknown): string | null {
  if (!v) return null;

  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;

  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function findStockRowForTransferPickTx(
  tx: Prisma.TransactionClient,
  args: {
    product_id: number;
    lot_id: number | null;
    exp: Date | null;
    location_id: number;
    location_name: string;
  },
) {
  const rows = await tx.stock.findMany({
    where: {
      product_id: args.product_id,
      location_id: args.location_id,
      lot_id: args.lot_id ?? null,
    } as any,
    orderBy: [{ id: "desc" }],
  });

  const exact =
    rows.find((r: any) => {
      const sameExp =
        normalizeDateOnlyKey(r.expiration_date) ===
        normalizeDateOnlyKey(args.exp);
      return sameExp;
    }) ??
    rows[0] ??
    null;

  return exact;
}

async function decreaseStockFromTransferPickTx(
  tx: Prisma.TransactionClient,
  args: {
    product_id: number;
    lot_id: number | null;
    exp: Date | null;
    location_id: number;
    location_name: string;
    qty: number;
  },
) {
  const qty = Math.max(0, Math.floor(Number(args.qty ?? 0)));
  if (qty <= 0) return;

  const stockRow = await findStockRowForTransferPickTx(tx, args);

  if (!stockRow) {
    throw badRequest(
      `ไม่พบ stock สำหรับตัดออก product_id=${args.product_id} lot_id=${args.lot_id ?? "-"} location=${args.location_name}`,
    );
  }

  const currentQty = Number(stockRow.quantity ?? 0);
  if (currentQty < qty) {
    throw badRequest(
      `stock ไม่พอสำหรับ confirm pick product_id=${args.product_id} lot_id=${args.lot_id ?? "-"} location=${args.location_name} need=${qty} have=${currentQty}`,
    );
  }

  const remain = currentQty - qty;

  if (remain <= 0) {
    await tx.stock.update({
      where: { id: stockRow.id },
      data: {
        quantity: new Prisma.Decimal(0),
        updated_at: new Date(),
      } as any,
    });
    return;
  }

  await tx.stock.update({
    where: { id: stockRow.id },
    data: {
      quantity: new Prisma.Decimal(remain),
      updated_at: new Date(),
    } as any,
  });
}

async function findStockRowForTransferPutTx(
  tx: Prisma.TransactionClient,
  args: {
    product_id: number;
    lot_id: number | null;
    lot_serial: string | null;
    exp: Date | null;
    location_id: number;
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

  const exact =
    rows.find(
      (r: any) =>
        normalizeDateOnlyKey(r.expiration_date) ===
        normalizeDateOnlyKey(args.exp),
    ) ??
    rows[0] ??
    null;

  return exact;
}

async function increaseStockFromTransferPutTx(
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

  let resolvedLotSerial = args.item.lot_serial ?? null;
  let resolvedExp = args.item.exp ?? null;

  if (!resolvedLotSerial || !resolvedExp) {
    const fallbackWhere: any = {
      product_id: args.item.product_id,
    };

    if (args.item.lot_id != null) {
      fallbackWhere.lot_id = args.item.lot_id;
    }

    if (resolvedLotSerial) {
      fallbackWhere.lot_name = resolvedLotSerial;
    }

    const fallbackGoods = await tx.wms_mdt_goods.findFirst({
      where: fallbackWhere,
      orderBy: { id: "desc" },
    });

    if (!resolvedLotSerial) {
      resolvedLotSerial = fallbackGoods?.lot_name ?? null;
    }

    if (!resolvedExp) {
      resolvedExp = fallbackGoods?.expiration_date ?? null;
    }
  }

  const existing = await findStockRowForTransferPutTx(tx, {
    product_id: args.item.product_id,
    lot_id: args.item.lot_id,
    lot_serial: resolvedLotSerial,
    exp: resolvedExp,
    location_id: args.location.id,
  });

  if (existing) {
    await tx.stock.update({
      where: { id: existing.id },
      data: {
        quantity: { increment: new Prisma.Decimal(qty) },
        updated_at: new Date(),
        lot_id: args.item.lot_id ?? existing.lot_id ?? null,
        lot_name: resolvedLotSerial ?? existing.lot_name ?? null,
        expiration_date: resolvedExp ?? existing.expiration_date ?? null,
      } as any,
    });
    return;
  }

  await tx.stock.create({
    data: {
      product_id: args.item.product_id,
      product_code: args.item.code ?? null,
      product_name: args.item.name ?? null,
      unit: args.item.unit ?? null,
      location_id: args.location.id,
      location_name: args.location.full_name,
      lot_id: args.item.lot_id ?? null,
      lot_name: resolvedLotSerial ?? null,
      expiration_date: resolvedExp ?? null,
      quantity: new Prisma.Decimal(qty),
      source: "wms",
      active: true,
      bucket_key: buildStockBucketKey({
        source: "wms",
        product_id: args.item.product_id,
        product_code: args.item.code,
        lot_id: args.item.lot_id,
        lot_name: resolvedLotSerial,
        location_id: args.location.id,
        expiration_date: resolvedExp,
      }),
    } as any,
  });
}

export const confirmTransferDocPick = asyncHandler(
  async (req: Request, res: Response) => {
    const no = String(req.params.no || "");
    const body = req.body;

    if (!no) throw badRequest("no is required");

    const transfer = await prisma.transfer_doc.findFirst({
      where: { no, deleted_at: null },
    });

    if (!transfer) throw notFound("transfer not found");

    // Merge by product_id, location_id, lot_id, exp
    const mergedLineMap = new Map<string, any>();

    for (const loc of body.locations || []) {
      // ต้องแปลง location_full_name เป็น location_id ก่อน
      const resolvedLoc = await resolveLocationByFullName(
        String(loc.location_full_name || ""),
      );
      const locId = resolvedLoc.id;
      const locName = resolvedLoc.full_name;

      for (const line of loc.lines || []) {
        // ต้องดึงข้อมูล transfer_doc_item ก่อนเพื่อให้ได้ product_id, lot_id, exp
        const itemId = line.transfer_doc_item_id || line.transfer_item_id;
        if (!itemId) continue;
        const freshItem = await prisma.transfer_doc_item.findUnique({
          where: { id: itemId },
        });
        if (!freshItem) continue;

        const key = [
          freshItem.product_id,
          locId,
          freshItem.lot_id ?? "-",
          freshItem.exp
            ? new Date(freshItem.exp).toISOString().slice(0, 10)
            : "-",
        ].join("|");

        const prev = mergedLineMap.get(key) || {
          product_id: freshItem.product_id,
          lot_id: freshItem.lot_id ?? null,
          exp: freshItem.exp ?? null,
          location_id: locId,
          location_name: locName,
          pickDelta: 0,
        };

        prev.pickDelta += Number(line.quantity_count || 0);

        mergedLineMap.set(key, prev);
      }
    }

    await prisma.$transaction(async (tx) => {
      for (const [, merged] of mergedLineMap.entries()) {
        const {
          product_id,
          lot_id,
          exp,
          location_id,
          location_name,
          pickDelta,
        } = merged;
        if (pickDelta <= 0) continue;

        // 🔥 ตัด stock
        await decreaseStockFromTransferPickTx(tx, {
          product_id: Number(product_id),
          lot_id: lot_id ?? null,
          exp: exp ?? null,
          location_id,
          location_name,
          qty: pickDelta,
        });

        // ไม่เปลี่ยนแปลงการ update confirm table (ยังใช้ transfer_doc_item_id เดิม)
        // หา transfer_doc_item_id ที่ตรงกับ product/location/lot/exp
        const item = await tx.transfer_doc_item.findFirst({
          where: {
            product_id: Number(product_id),
            lot_id: lot_id ?? null,
            exp: exp ?? null,
            transfer_doc_id: transfer.id,
            deleted_at: null,
          },
        });
        if (!item) continue;

        await tx.transfer_doc_item_location_confirm.upsert({
          where: {
            uniq_tf_location: {
              transfer_doc_item_id: item.id,
              location_id,
            },
          },
          update: {
            confirmed_qty: { increment: pickDelta },
            updated_at: new Date(),
          },
          create: {
            transfer_doc_item_id: item.id,
            location_id,
            confirmed_qty: pickDelta,
          },
        });
      }
      await prisma.transfer_doc.update({
        where: { no },
        data: {
          status: "process",
          updated_at: new Date(),
        },
      });
    });
    return res.json({ success: true });
  },
);

type BuildBucketKeyInput = {
  source: string;
  product_id: number;
  product_code?: string | null;
  lot_id?: number | null;
  lot_name?: string | null;
  location_id: number;
  expiration_date?: Date | string | null;
};

function dateOnlyISO(v: Date | string | null | undefined) {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function buildStockBucketKey(input: BuildBucketKeyInput) {
  const source = String(input.source ?? "")
    .trim()
    .toLowerCase();
  const pid = Number(input.product_id ?? 0);
  const pcode = String(input.product_code ?? "")
    .trim()
    .toLowerCase();

  const lotName = String(input.lot_name ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

  const locId = Number(input.location_id ?? 0);
  const exp = dateOnlyISO(input.expiration_date ?? null);

  return [
    `src:${source}`,
    `pid:${pid}`,
    `pcode:${pcode}`,
    `lot:${lotName}`,
    `loc:${locId}`,
    `exp:${exp}`,
  ].join("|");
}

type PutConfirmKey = string;
const putConfirmKey = (transfer_doc_item_id: string, location_id: number) =>
  `tfi:${transfer_doc_item_id}|loc:${location_id}`;

/**
 * =========================
 * Confirm PUT -> Upsert stock (delta) + update item.quantity_put
 * =========================
 */
export const confirmTransferDocPutToStock = asyncHandler(
  async (req: Request, res: Response) => {
    const no = String(req.params.no || "");
    const body = req.body;

    if (!no) throw badRequest("no is required");

    const transfer = await prisma.transfer_doc.findFirst({
      where: { no, deleted_at: null },
    });

    if (!transfer) throw notFound("transfer not found");

    type MergedPutLine = {
      product_id: number;
      code: string | null;
      name: string | null;
      unit: string | null;
      lot_id: number | null;
      lot_serial: string | null;
      exp: Date | null;
      location_id: number;
      location_name: string;
      putDelta: number;
      confirmRows: {
        transfer_doc_item_id: string;
        location_id: number;
        qty: number;
      }[];
    };

    const mergedLineMap = new Map<string, MergedPutLine>();

    for (const loc of body.locations || []) {
      const resolvedLoc = await resolveLocationByFullName(
        String(loc.location_full_name || ""),
      );
      const locId = resolvedLoc.id;
      const locName = resolvedLoc.full_name;

      for (const line of loc.lines || []) {
        const itemId = line.transfer_doc_item_id || line.transfer_item_id;
        const qtyPut = Number(line.quantity_put || 0);

        if (!itemId || qtyPut <= 0) continue;

        const freshItem = await prisma.transfer_doc_item.findUnique({
          where: { id: itemId },
        });

        if (!freshItem || freshItem.deleted_at) continue;

        let resolvedLotSerial: string | null = freshItem.lot_serial ?? null;
        let resolvedExp: Date | null = freshItem.exp ?? null;

        if (!resolvedLotSerial || !resolvedExp) {
          const fallbackWhere: any = {
            product_id: freshItem.product_id,
          };

          if (freshItem.lot_id != null) {
            fallbackWhere.lot_id = freshItem.lot_id;
          }

          if (freshItem.lot_serial) {
            fallbackWhere.lot_name = freshItem.lot_serial;
          }

          const fallbackGoods = await prisma.wms_mdt_goods.findFirst({
            where: fallbackWhere,
            orderBy: { id: "desc" },
          });

          if (!resolvedLotSerial) {
            resolvedLotSerial = fallbackGoods?.lot_name ?? null;
          }

          if (!resolvedExp) {
            resolvedExp = fallbackGoods?.expiration_date ?? null;
          }
        }

        const expKey = resolvedExp
          ? new Date(resolvedExp).toISOString().slice(0, 10)
          : "-";

        const lotKey = resolvedLotSerial ?? "-";

        const key = [freshItem.product_id, locId, lotKey, expKey].join("|");

        const prev = mergedLineMap.get(key) || {
          product_id: Number(freshItem.product_id),
          code: freshItem.code ?? null,
          name: freshItem.name ?? null,
          unit: freshItem.unit ?? null,
          lot_id: freshItem.lot_id ?? null,
          lot_serial: resolvedLotSerial,
          exp: resolvedExp,
          location_id: locId,
          location_name: locName,
          putDelta: 0,
          confirmRows: [],
        };

        prev.putDelta += qtyPut;
        prev.confirmRows.push({
          transfer_doc_item_id: freshItem.id,
          location_id: locId,
          qty: qtyPut,
        });

        mergedLineMap.set(key, prev);
      }
    }

    await prisma.$transaction(async (tx) => {
      for (const [, merged] of mergedLineMap.entries()) {
        const {
          product_id,
          code,
          name,
          unit,
          lot_id,
          lot_serial,
          exp,
          location_id,
          location_name,
          putDelta,
          confirmRows,
        } = merged;

        if (putDelta <= 0) continue;

        await increaseStockFromTransferPutTx(tx, {
          item: {
            product_id,
            code,
            name,
            unit,
            lot_id,
            lot_serial,
            exp,
          },
          location: {
            id: location_id,
            full_name: location_name,
          },
          qty: putDelta,
        });

        for (const row of confirmRows) {
          await tx.transfer_doc_item_location_put_confirm.upsert({
            where: {
              uniq_tf_put_location: {
                transfer_doc_item_id: row.transfer_doc_item_id,
                location_id: row.location_id,
              },
            },
            update: {
              confirmed_put: { increment: row.qty },
              updated_at: new Date(),
            },
            create: {
              transfer_doc_item_id: row.transfer_doc_item_id,
              location_id: row.location_id,
              confirmed_put: row.qty,
            },
          });
        }
      }

      await prisma.transfer_doc.update({
        where: { no },
        data: {
          status: "completed",
          updated_at: new Date(),
        },
      });
    });

    return res.json({ success: true });
  },
);
