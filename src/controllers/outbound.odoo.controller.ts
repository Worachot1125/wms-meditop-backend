import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { asyncHandler } from "../utils/asyncHandler";
import axios from "axios";
import { getUserId } from "../utils/auth.util";
import { badRequest, notFound } from "../utils/appError";
import { AuthRequest, buildDepartmentAccessWhere } from "../middleware/auth";
import { formatOdooOutbound } from "../utils/formatters/odoo_outbound.formatter";
import { io } from "../index";
import {
  resolveBarcodeScan,
  normalizeScanText,
} from "../utils/helper_scan/barcode";
import {
  buildQueuedOdooFragment,
  buildOdooItemsForSingleAdjustment,
  buildLotAdjustmentSignature,
} from "../utils/helper_scan/change_lot";
import {
  isTFNumber,
  isExpNcrDest,
  parseSearchDateRange,
  toExpDate,
  normalizeExpDate,
  toDateOnlyKey,
  normalizeOwnerText,
  normalizeLotId,
  normalizeLotSerial,
  normalizeStr,
  normalizeNullableText,
  normalizeBarcodeTextFromOdoo,
  resolveOutTypeFromNo,
  buildKey,
  firstStr,
  decodeNoParam,
  pickPositiveInt,
  normalizeLotSerialForMatch,
  sameLotSerialForMatch,
} from "../utils/outbound/outbound.parse";
5;
import type {
  BorSerInternalLine,
  TFLine,
} from "../utils/outbound/outbound.type";

import {
  buildInputNumberMapFromItems,
  resolveInputNumberFromMap,
  buildLockNoMapFromItems,
  resolveLockLocationsFromMap,
  buildExpirationMapsFromStocks,
  firstLocId,
  expKeyLocOf,
  expKeyNoLocOf,
  buildExpirationDateMapForGoodsOutItems,
  expKeyOf,
  lotMatchedNullable,
  hydrateOutboundItemsBarcodeTextFromBarcodeMaster,
} from "../utils/outbound/outbound.barcode";

import {
  buildDepartmentCodeMapFromOutbounds,
  resolveDepartmentCodeForOutbound,
  buildDepartmentShortNameMapFromOutbounds,
  resolveDepartmentShortNameForOutbound,
  parseDepartmentIdsAsNumbers,
} from "../utils/outbound/outbound.department";

import {
  isVirtualBorrowDest,
  upsertVirtualLocationFromOdoo,
} from "../utils/outbound/outbound.virtual-location";

import {
  BOR_SER_DEDUCT_TYPES,
  BOR_SER_REPLACE_TYPES,
  decrementBorSerStocksForGaBosSv,
  replaceBorSerStocksForExBoa,
} from "../utils/outbound/outbound.bor-ser-stock";

import {
  isBorSerInternalTransferLike,
  isSwapTransferLike,
  handleBorSerInternalTransferOutbound,
  retryPendingSwapsByDestFullName,
} from "../utils/outbound/outbound.swap";

import {
  goodsInMatchKey,
  handleTFTransferOutbound,
} from "../utils/outbound/outbound.tf";

import {
  createCompletedAutoAdjustmentFromTransfer,
  enrichLotLinesWithResolvedLotId,
} from "../utils/outbound/outbound.adjustment";

import type {
  RawLotAdjustmentLine,
  NormalizedLotAdjustmentLine,
  GoodsOutItemRowForAdjustment,
} from "../utils/outbound/outbound.adjustment";
import { buildAutoLocationPackKey } from "../utils/helper_scan/location";

// ================================
// ✅ RECEIVE OUTBOUND FROM ODOO
// ================================
export const receiveOutboundFromOdoo = asyncHandler(
  async (req: Request<{}, {}, any>, res: Response) => {
    let logId: number | null = null;

    try {
      const requestLog = await prisma.odoo_request_log.create({
        data: {
          endpoint: "/api/Outbound",
          method: "POST",
          request_body: JSON.stringify(req.body),
          ip_address: req.ip || req.socket.remoteAddress || null,
          user_agent: req.headers["user-agent"] || null,
        },
      });
      logId = requestLog.id;
    } catch {}

    const getTransfers = (body: any) => {
      if (body?.params?.transfers) return body.params.transfers;
      if (body?.transfers) return body.transfers;
      return null;
    };

    const transfers = getTransfers(req.body as any);

    if (!transfers) throw badRequest("ไม่พบข้อมูล 'transfers' ใน request body");
    if (!Array.isArray(transfers)) {
      throw badRequest("'transfers' ต้องเป็น Array");
    }
    if (transfers.length === 0) {
      throw badRequest("'transfers' ต้องมีข้อมูลอย่างน้อย 1 รายการ");
    }

    try {
      const results: any[] = [];

      type MergedItem = {
        product_id: number | null;
        lot_id: number | null;
        lot_serial: string | null;
        code: string | null;
        name: string | null;
        unit: string | null;
        tracking: string | null;
        qty: number;
        barcode_text: string | null;
        exp: Date | null;
      };

      for (const transfer of transfers) {
        const {
          picking_id,
          no,
          location_id,
          location,
          location_owner,
          location_owner_display,
          location_dest_id,
          location_dest,
          location_dest_owner,
          location_dest_owner_display,
          department_id,
          department,
          reference,
          origin,
          items,
          invoice,
        } = transfer as any;

        if (!no) throw badRequest("ไม่พบเลข no ใน transfer");
        if (!items || !Array.isArray(items) || items.length === 0) {
          throw badRequest(`Transfer ${no} ไม่มี items`);
        }

        // =========================
        // ✅ TF intercept
        // =========================
        if (isTFNumber(no)) {
          const mergedMap = new Map<string, TFLine>();

          for (let i = 0; i < items.length; i++) {
            const raw = items[i];

            const product_id =
              typeof raw.product_id === "number" ? raw.product_id : null;

            const lot_id = normalizeLotId(raw.lot_id);
            const lot_serial = normalizeLotSerial(raw.lot_serial);
            const exp =
              normalizeExpDate(raw.exp) ??
              normalizeExpDate(raw.expire_date) ??
              null;

            const qty =
              typeof raw.qty === "number" ? raw.qty : Number(raw.qty ?? 0) || 0;

            const key = buildKey({ product_id, lot_serial, exp });

            const code = normalizeStr(raw.code);
            const name = normalizeStr(raw.name);
            const unit = normalizeStr(raw.unit);
            const tracking = normalizeStr(raw.tracking);
            const barcode_text = normalizeBarcodeTextFromOdoo(raw);

            const seq = typeof raw.sequence === "number" ? raw.sequence : i + 1;

            const existed = mergedMap.get(key);
            if (existed) {
              existed.qty += qty;
              existed.code = code ?? existed.code;
              existed.name = name ?? existed.name;
              existed.unit = unit ?? existed.unit;
              existed.tracking = tracking ?? existed.tracking;
              existed.barcode_text = barcode_text ?? existed.barcode_text;
              existed.lot_id = lot_id ?? existed.lot_id;
              existed.exp = existed.exp ?? exp;
            } else {
              mergedMap.set(key, {
                sequence: seq,
                product_id,
                code,
                name,
                unit,
                tracking,
                lot_id,
                lot_serial,
                qty,
                barcode_text,
                exp,
                expire_date: toDateOnlyKey(exp),
              });
            }
          }

          const mergedItemsRaw = Array.from(mergedMap.values());

          const mergedItems = await prisma.$transaction(async (tx) => {
            return hydrateOutboundItemsBarcodeTextFromBarcodeMaster(
              tx,
              mergedItemsRaw,
            );
          });

          // ✅ TF + ปลายทางเป็น EXP&NCR
          // ให้ยังเข้า transfer แต่ mark ประเภทเป็น EXP&NCR/NCR ตามที่ FE ใช้แยกเมนู
          if (isExpNcrDest(location_dest)) {
            const doc = await prisma.$transaction(async (tx) => {
              const convertedReference =
                typeof reference === "boolean"
                  ? reference
                    ? "true"
                    : null
                  : reference || null;

              const convertedOrigin =
                typeof origin === "string"
                  ? origin
                  : origin
                    ? String(origin)
                    : null;

              const existing = await tx.transfer_doc.findFirst({
                where: { no: String(no), deleted_at: null },
              });

              const saved = existing
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
                      in_type: "NCR",
                      updated_at: new Date(),
                    },
                  })
                : await tx.transfer_doc.create({
                    data: {
                      no: String(no),
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
                      in_type: "NCR",
                    },
                  });

              const existingLines = await tx.transfer_doc_item.findMany({
                where: { transfer_doc_id: saved.id, deleted_at: null },
                select: {
                  id: true,
                  sequence: true,
                  product_id: true,
                  lot_serial: true,
                  in_process: true,
                  quantity_receive: true,
                  qty: true,
                  exp: true,
                },
              });

              const openMap = new Map<string, (typeof existingLines)[number]>();
              for (const r of existingLines) {
                if (r.product_id == null) continue;
                if (r.in_process) continue;

                openMap.set(
                  goodsInMatchKey({
                    product_id: r.product_id,
                    lot_serial: r.lot_serial,
                    exp: r.exp ?? null,
                  }),
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
                  throw badRequest(
                    `Odoo item missing product_id (TF-EXP&NCR: ${no})`,
                  );
                }
                if (!item.name || !item.unit) {
                  throw badRequest(
                    `Odoo item missing name/unit (TF-EXP&NCR: ${no}, product_id: ${item.product_id})`,
                  );
                }

                const exp =
                  item.exp ?? toExpDate(item.expire_date ?? null) ?? null;
                const lotSerial = item.lot_serial ?? null;

                const key = goodsInMatchKey({
                  product_id: item.product_id,
                  lot_serial: lotSerial,
                  exp,
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

                  continue;
                }

                const finalSeq = item.sequence ?? nextSeq++;
                await tx.transfer_doc_item.create({
                  data: {
                    transfer_doc_id: saved.id,
                    sequence: finalSeq,
                    odoo_sequence: finalSeq,
                    odoo_line_key: `${no}-${finalSeq}`,

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
                    exp: exp ?? undefined,

                    updated_at: new Date(),
                  },
                });
              }

              return tx.transfer_doc.findUnique({
                where: { id: saved.id },
                include: {
                  transfer_doc_items: {
                    where: { deleted_at: null },
                    orderBy: { sequence: "asc" },
                  },
                },
              });
            });

            results.push(doc);
            continue;
          }

          const doc = await handleTFTransferOutbound({
            picking_id,
            number: String(no),
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

        // =========================
        // ✅ BOR/SER/BOS internal transfer
        // =========================
        if (
          isBorSerInternalTransferLike({
            location,
            location_dest,
            location_owner,
            location_dest_owner,
          })
        ) {
          const mergedMap = new Map<string, BorSerInternalLine>();

          for (let i = 0; i < items.length; i++) {
            const raw = items[i];

            const product_id =
              typeof raw.product_id === "number" ? raw.product_id : null;

            const lot_id = normalizeLotId(raw.lot_id);
            const lot_serial = normalizeLotSerial(raw.lot_serial);
            const exp =
              normalizeExpDate(raw.exp) ??
              normalizeExpDate(raw.expire_date) ??
              null;

            const qty =
              typeof raw.qty === "number" ? raw.qty : Number(raw.qty ?? 0) || 0;

            const key = buildKey({ product_id, lot_serial, exp });

            const code = normalizeStr(raw.code);
            const name = normalizeStr(raw.name);
            const unit = normalizeStr(raw.unit);
            const tracking = normalizeStr(raw.tracking);
            const barcode_text = normalizeBarcodeTextFromOdoo(raw);

            const seq = typeof raw.sequence === "number" ? raw.sequence : i + 1;

            const existed = mergedMap.get(key);
            if (existed) {
              existed.qty += qty;
              existed.code = code ?? existed.code;
              existed.name = name ?? existed.name;
              existed.unit = unit ?? existed.unit;
              existed.tracking = tracking ?? existed.tracking;
              existed.barcode_text = barcode_text ?? existed.barcode_text;
              existed.lot_id = lot_id ?? existed.lot_id;
              existed.exp = existed.exp ?? exp;
            } else {
              mergedMap.set(key, {
                sequence: seq,
                product_id,
                code,
                name,
                unit,
                tracking,
                lot_id,
                lot_serial,
                qty,
                barcode_text,
                exp,
              });
            }
          }

          const mergedItemsRaw = Array.from(mergedMap.values());

          const mergedItems = await prisma.$transaction(async (tx) => {
            return hydrateOutboundItemsBarcodeTextFromBarcodeMaster(
              tx,
              mergedItemsRaw,
            );
          });

          const moved = await handleBorSerInternalTransferOutbound({
            no: String(no),
            picking_id,

            location_id,
            location,
            location_dest_id,
            location_dest,

            location_owner,
            location_owner_display,
            location_dest_owner,
            location_dest_owner_display,

            department_id,
            department,
            reference,
            origin,

            mergedItems,
          });

          results.push(moved);
          continue;
        }

        const outType = resolveOutTypeFromNo(no);
        const autoProcess = BOR_SER_DEDUCT_TYPES.has(outType);

        const convertedReference =
          typeof reference === "boolean"
            ? reference
              ? "true"
              : null
            : reference || null;

        const convertedOrigin =
          typeof origin === "boolean"
            ? origin
              ? "true"
              : null
            : typeof origin === "string"
              ? origin
              : origin
                ? String(origin)
                : null;

        const convertedInvoice =
          invoice === false ? null : (normalizeStr(invoice) ?? null);

        // =========================
        // ✅ EXP&NCR intercept
        // - ไม่ให้ไปทำ pick/pack ที่ outbound
        // =========================
        if (isExpNcrDest(location_dest)) {
          const savedExpNcr = await prisma.$transaction(async (tx) => {
            const existing = await tx.outbound.findFirst({
              where: { no, deleted_at: null },
              select: { id: true },
            });

            const outbound = existing
              ? await tx.outbound.update({
                  where: { id: existing.id },
                  data: {
                    picking_id,
                    location_id,
                    location,
                    location_dest_id:
                      typeof location_dest_id === "number"
                        ? location_dest_id
                        : null,
                    location_dest,
                    department_id: department_id?.toString(),
                    department: department?.toString() || "",
                    reference: convertedReference,
                    origin: convertedOrigin,
                    invoice: convertedInvoice,
                    out_type: "NCR",
                    in_process: false,
                    updated_at: new Date(),
                  },
                })
              : await tx.outbound.create({
                  data: {
                    no,
                    picking_id,
                    location_id,
                    location,
                    location_dest_id:
                      typeof location_dest_id === "number"
                        ? location_dest_id
                        : null,
                    location_dest,
                    department_id: department_id?.toString(),
                    department: department?.toString() || "",
                    reference: convertedReference,
                    origin: convertedOrigin,
                    invoice: convertedInvoice,
                    date: new Date(),
                    out_type: "NCR",
                    outbound_barcode: no,
                    in_process: false,
                  },
                });

            const mergedMap = new Map<string, MergedItem>();

            for (const raw of items) {
              const product_id =
                typeof raw.product_id === "number" ? raw.product_id : null;

              const lot_id = normalizeLotId(raw.lot_id);
              const lot_serial = normalizeLotSerial(raw.lot_serial);
              const exp =
                normalizeExpDate(raw.exp) ??
                normalizeExpDate(raw.expire_date) ??
                null;

              const qty =
                typeof raw.qty === "number"
                  ? raw.qty
                  : Number(raw.qty ?? 0) || 0;

              const key = buildKey({ product_id, lot_serial, exp });

              const code = normalizeStr(raw.code);
              const name = normalizeStr(raw.name);
              const unit = normalizeStr(raw.unit);
              const tracking = normalizeStr(raw.tracking);
              const barcode_text = normalizeBarcodeTextFromOdoo(raw);

              const existed = mergedMap.get(key);
              if (existed) {
                existed.qty += qty;
                existed.code = code ?? existed.code;
                existed.name = name ?? existed.name;
                existed.unit = unit ?? existed.unit;
                existed.tracking = tracking ?? existed.tracking;
                existed.barcode_text = barcode_text ?? existed.barcode_text;
                existed.lot_id = lot_id ?? existed.lot_id;
                existed.exp = existed.exp ?? exp;
              } else {
                mergedMap.set(key, {
                  product_id,
                  lot_id,
                  lot_serial,
                  code,
                  name,
                  unit,
                  tracking,
                  qty,
                  barcode_text,
                  exp,
                });
              }
            }

            const mergedItemsRaw = Array.from(mergedMap.values());

            const mergedItems =
              await hydrateOutboundItemsBarcodeTextFromBarcodeMaster(
                tx,
                mergedItemsRaw,
              );

            const existingRows = await tx.goods_out_item.findMany({
              where: { outbound_id: outbound.id, deleted_at: null },
              select: {
                id: true,
                sequence: true,
                product_id: true,
                lot_serial: true,
              },
            });

            const openMap = new Map<string, (typeof existingRows)[number]>();
            for (const r of existingRows) {
              const k = `p:${r.product_id ?? "null"}|lotSer:${r.lot_serial ?? ""}`;
              openMap.set(k, r);
            }

            const maxSeq = existingRows.reduce(
              (m, x) => Math.max(m, Number(x.sequence ?? 0)),
              0,
            );
            let nextSeq = maxSeq + 1;

            for (const it of mergedItems) {
              const nameText = (it.name ?? "-").trim() || "-";
              const unitText = (it.unit ?? "-").trim() || "-";

              const openKey = `p:${it.product_id ?? "null"}|lotSer:${it.lot_serial ?? ""}`;
              const open = openMap.get(openKey);

              if (open?.id) {
                await tx.goods_out_item.update({
                  where: { id: open.id },
                  data: {
                    code: it.code ?? undefined,
                    name: nameText,
                    unit: unitText,
                    tracking: it.tracking ?? undefined,
                    lot_id: it.lot_id ?? null,
                    lot_serial: it.lot_serial,
                    barcode_text: it.barcode_text ?? null,
                    qty: it.qty,
                    in_process: false,
                    updated_at: new Date(),
                  } as any,
                });
              } else {
                const seq = nextSeq++;

                await tx.goods_out_item.create({
                  data: {
                    outbound_id: outbound.id,
                    sequence: seq,
                    product_id: it.product_id,
                    code: it.code ?? undefined,
                    name: nameText,
                    unit: unitText,
                    tracking: it.tracking ?? undefined,
                    lot_id: it.lot_id ?? null,
                    lot_serial: it.lot_serial,
                    qty: it.qty,
                    sku: it.code ?? undefined,
                    barcode_text: it.barcode_text ?? null,
                    in_process: false,
                    updated_at: new Date(),
                  } as any,
                });
              }
            }

            return tx.outbound.findUnique({
              where: { no },
              include: {
                goods_outs: {
                  where: { deleted_at: null },
                  orderBy: { sequence: "asc" },
                },
              },
            });
          });

          results.push(savedExpNcr);
          continue;
        }

        const shouldAutoVirtualLocation =
          !isTFNumber(no) &&
          !isBorSerInternalTransferLike({
            location,
            location_dest,
            location_owner,
            location_dest_owner,
          }) &&
          !isSwapTransferLike({
            location,
            location_dest,
            location_owner,
            location_dest_owner,
          }) &&
          isVirtualBorrowDest(location_dest) &&
          normalizeNullableText(location_dest_owner) !== null;

        let createdVirtualLocationFullName: string | null = null;

        const saved = await prisma.$transaction(async (tx) => {
          let mappedVirtualLocationId: number | null =
            typeof location_dest_id === "number" ? location_dest_id : null;

          if (shouldAutoVirtualLocation) {
            const virtualLoc = await upsertVirtualLocationFromOdoo(tx, {
              location_dest_id,
              location_dest,
              location_dest_owner,
              location_dest_owner_display,
            });

            if (virtualLoc?.id) {
              mappedVirtualLocationId = virtualLoc.id;
              createdVirtualLocationFullName = virtualLoc.full_name ?? null;
            }
          }

          const existing = await tx.outbound.findFirst({
            where: { no, deleted_at: null },
            select: { id: true },
          });

          const outbound = existing
            ? await tx.outbound.update({
                where: { id: existing.id },
                data: {
                  picking_id,
                  location_id,
                  location,
                  location_dest_id: mappedVirtualLocationId,
                  location_dest,
                  department_id: department_id?.toString(),
                  department: department?.toString() || "",
                  reference: convertedReference,
                  origin: convertedOrigin,
                  invoice: convertedInvoice,
                  out_type: outType,
                  ...(autoProcess ? { in_process: true } : {}),
                  updated_at: new Date(),
                },
              })
            : await tx.outbound.create({
                data: {
                  no,
                  picking_id,
                  location_id,
                  location,
                  location_dest_id: mappedVirtualLocationId,
                  location_dest,
                  department_id: department_id?.toString(),
                  department: department?.toString() || "",
                  reference: convertedReference,
                  origin: convertedOrigin,
                  invoice: convertedInvoice,
                  date: new Date(),
                  out_type: outType,
                  outbound_barcode: no,
                  ...(autoProcess ? { in_process: true } : {}),
                },
              });

          const mergedMap = new Map<string, MergedItem>();

          for (const raw of items) {
            const product_id =
              typeof raw.product_id === "number" ? raw.product_id : null;

            const lot_id = normalizeLotId(raw.lot_id);
            const lot_serial = normalizeLotSerial(raw.lot_serial);
            const exp =
              normalizeExpDate(raw.exp) ??
              normalizeExpDate(raw.expire_date) ??
              null;

            const qty =
              typeof raw.qty === "number" ? raw.qty : Number(raw.qty ?? 0) || 0;

            const key = buildKey({ product_id, lot_serial, exp });

            const code = normalizeStr(raw.code);
            const name = normalizeStr(raw.name);
            const unit = normalizeStr(raw.unit);
            const tracking = normalizeStr(raw.tracking);
            const barcode_text = normalizeBarcodeTextFromOdoo(raw);

            const existed = mergedMap.get(key);
            if (existed) {
              existed.qty += qty;
              existed.code = code ?? existed.code;
              existed.name = name ?? existed.name;
              existed.unit = unit ?? existed.unit;
              existed.tracking = tracking ?? existed.tracking;
              existed.barcode_text = barcode_text ?? existed.barcode_text;
              existed.lot_id = lot_id ?? existed.lot_id;
              existed.exp = existed.exp ?? exp;
            } else {
              mergedMap.set(key, {
                product_id,
                lot_id,
                lot_serial,
                code,
                name,
                unit,
                tracking,
                qty,
                barcode_text,
                exp,
              });
            }
          }

          const mergedItemsRaw = Array.from(mergedMap.values());

          const mergedItems =
            await hydrateOutboundItemsBarcodeTextFromBarcodeMaster(
              tx,
              mergedItemsRaw,
            );

          const existingRows = await tx.goods_out_item.findMany({
            where: { outbound_id: outbound.id, deleted_at: null },
            select: {
              id: true,
              sequence: true,
              product_id: true,
              lot_serial: true,
              in_process: true,
            },
          });

          const openMap = new Map<string, (typeof existingRows)[number]>();
          for (const r of existingRows) {
            const k = `p:${r.product_id ?? "null"}|lotSer:${r.lot_serial ?? ""}`;
            if (!r.in_process) openMap.set(k, r);
          }

          const maxSeq = existingRows.reduce(
            (m, x) => Math.max(m, Number(x.sequence ?? 0)),
            0,
          );
          let nextSeq = maxSeq + 1;

          for (let i = 0; i < mergedItems.length; i++) {
            const it = mergedItems[i];

            const nameText = (it.name ?? "-").trim() || "-";
            const unitText = (it.unit ?? "-").trim() || "-";

            const openKey = `p:${it.product_id ?? "null"}|lotSer:${it.lot_serial ?? ""}`;
            const open = openMap.get(openKey);

            if (open?.id) {
              const now = new Date();

              await tx.goods_out_item.update({
                where: { id: open.id },
                data: {
                  code: it.code ?? undefined,
                  name: nameText,
                  unit: unitText,
                  tracking: it.tracking ?? undefined,
                  lot_id: it.lot_id ?? null,
                  lot_serial: it.lot_serial,
                  barcode_text: it.barcode_text ?? null,
                  qty: { increment: it.qty },
                  ...(autoProcess
                    ? {
                        pick: { increment: it.qty },
                        confirmed_pick: { increment: it.qty },
                        in_process: true,
                      }
                    : {}),
                  updated_at: now,
                } as any,
              });

              continue;
            }

            const seq = nextSeq++;
            const now = new Date();

            await tx.goods_out_item.create({
              data: {
                outbound_id: outbound.id,
                sequence: seq,
                product_id: it.product_id,
                code: it.code ?? undefined,
                name: nameText,
                unit: unitText,
                tracking: it.tracking ?? undefined,
                lot_id: it.lot_id ?? null,
                lot_serial: it.lot_serial,
                qty: it.qty,
                sku: it.code ?? undefined,
                barcode_text: it.barcode_text ?? null,
                ...(autoProcess
                  ? {
                      pick: it.qty,
                      confirmed_pick: it.qty,
                      in_process: true,
                    }
                  : {}),
                updated_at: now,
              } as any,
            });
          }

          if (BOR_SER_DEDUCT_TYPES.has(outType)) {
            await decrementBorSerStocksForGaBosSv(tx, {
              outType,
              transfer: {
                no,
                location_id:
                  typeof location_id === "number" ? location_id : null,
                location: typeof location === "string" ? location : null,
                location_dest_id:
                  typeof location_dest_id === "number"
                    ? location_dest_id
                    : null,
                location_dest:
                  typeof location_dest === "string" ? location_dest : null,
              },
              mergedItems: mergedItems.map((x: any) => ({
                product_id: x.product_id,
                lot_id: x.lot_id,
                lot_serial: x.lot_serial,
                qty: x.qty,
                exp: x.exp ?? null,
              })),
            });
          }

          if (BOR_SER_REPLACE_TYPES.has(outType)) {
            await replaceBorSerStocksForExBoa(tx, {
              outType,
              transfer: {
                no,
                location_dest_id:
                  typeof location_dest_id === "number"
                    ? location_dest_id
                    : null,
                location_dest:
                  typeof location_dest === "string" ? location_dest : null,
                department_id:
                  department_id != null ? String(department_id) : null,
                department: department != null ? String(department) : null,

                location_owner: normalizeOwnerText(location_owner),
                location_owner_display: normalizeOwnerText(
                  location_owner_display,
                ),
                location_dest_owner: normalizeOwnerText(location_dest_owner),
                location_dest_owner_display: normalizeOwnerText(
                  location_dest_owner_display,
                ),
              },
              mergedItems: mergedItems.map((x: any) => ({
                product_id: x.product_id,
                lot_id: x.lot_id,
                lot_serial: x.lot_serial,
                qty: x.qty,
                code: x.code ?? null,
                name: x.name ?? null,
                unit: x.unit ?? null,
                exp: x.exp ?? null,
              })),
            });
          }

          // ✅ สร้าง completed adjust auto สำหรับ SV / GA / BOS
          if (["SV", "GA", "BOS"].includes(outType)) {
            await createCompletedAutoAdjustmentFromTransfer(tx, {
              no,
              picking_id: typeof picking_id === "number" ? picking_id : null,
              location_id: typeof location_id === "number" ? location_id : null,
              location: typeof location === "string" ? location : null,
              location_dest_id:
                typeof location_dest_id === "number" ? location_dest_id : null,
              location_dest:
                typeof location_dest === "string" ? location_dest : null,
              location_owner: normalizeOwnerText(location_owner),
              location_owner_display: normalizeOwnerText(
                location_owner_display,
              ),
              location_dest_owner: normalizeOwnerText(location_dest_owner),
              location_dest_owner_display: normalizeOwnerText(
                location_dest_owner_display,
              ),
              department_id:
                department_id != null ? String(department_id) : null,
              department: department != null ? String(department) : null,
              reference: convertedReference,
              origin: convertedOrigin,
              type: outType,
              items: mergedItems.map((x: any, idx: number) => ({
                sequence: idx + 1,
                product_id: x.product_id,
                code: x.code ?? null,
                name: x.name ?? null,
                unit: x.unit ?? null,
                tracking: x.tracking ?? null,
                lot_id: x.lot_id,
                lot_serial: x.lot_serial,
                qty: x.qty,
                exp: x.exp ?? null,
                barcode_payload: null,
              })),
            });
          }

          if (autoProcess) {
            const now = new Date();

            await tx.outbound.update({
              where: { id: outbound.id },
              data: { in_process: true, updated_at: now },
            });

            await tx.goods_out_item.updateMany({
              where: { outbound_id: outbound.id, deleted_at: null },
              data: {
                in_process: true,
                updated_at: now,
              } as any,
            });

            const allItems = await tx.goods_out_item.findMany({
              where: { outbound_id: outbound.id, deleted_at: null },
              select: { id: true, qty: true },
            });

            for (const it of allItems) {
              const q = Math.max(0, Math.floor(Number(it.qty ?? 0)));

              await tx.goods_out_item.update({
                where: { id: it.id },
                data: {
                  pick: q,
                  confirmed_pick: q,
                  in_process: true,
                  updated_at: now,
                } as any,
              });
            }
          }

          return tx.outbound.findUnique({
            where: { no },
            include: {
              goods_outs: {
                where: { deleted_at: null },
                orderBy: { sequence: "asc" },
              },
            },
          });
        });

        if (createdVirtualLocationFullName) {
          await retryPendingSwapsByDestFullName(createdVirtualLocationFullName);
        }

        results.push(saved);
      }

      const responseData = {
        message: `สร้าง/อัพเดท ${results.length} transfers สำเร็จ`,
        data: results,
      };

      if (logId) {
        try {
          await prisma.odoo_request_log.update({
            where: { id: logId },
            data: {
              response_status: 201,
              response_body: JSON.stringify(responseData),
              error_message: null,
            },
          });
        } catch {}
      }

      return res.status(201).json(responseData);
    } catch (error) {
      if (logId) {
        const msg = error instanceof Error ? error.message : String(error);
        try {
          await prisma.odoo_request_log.update({
            where: { id: logId },
            data: {
              response_status: (error as any)?.statusCode || 500,
              response_body: JSON.stringify({ error: msg }),
              error_message: msg,
            },
          });
        } catch {}
      }
      throw error;
    }
  },
);

/**
 * GET /api/outbounds/odoo/transfers
 */
export const getOdooOutbounds = asyncHandler(
  async (req: Request, res: Response) => {
    const outbounds = await prisma.outbound.findMany({
      where: { deleted_at: null, picking_id: { not: null } },
      include: {
        goods_outs: {
          where: { deleted_at: null },
          include: {
            barcode_ref: { where: { deleted_at: null } },
          },
          orderBy: { sequence: "asc" },
        },
      },
      orderBy: { created_at: "desc" },
    });

    const deptMap = await buildDepartmentCodeMapFromOutbounds(outbounds as any);

    const data = await Promise.all(
      outbounds.map(async (outbound) => {
        const formatted: any = formatOdooOutbound(outbound as any);

        formatted.department_code = resolveDepartmentCodeForOutbound(
          deptMap,
          outbound as any,
        );

        const itemsKey = (outbound.goods_outs || []).map((it: any) => ({
          product_id: it.product_id,
          lot_serial: it.lot_serial,
          lot_name: it.lot_serial,
        }));

        const inputMap = await buildInputNumberMapFromItems(itemsKey);

        const lockNoMap = await buildLockNoMapFromItems(
          itemsKey.map((x: any) => ({
            product_id: x.product_id,
            lot_name: x.lot_name,
          })),
        );

        formatted.items = (outbound.goods_outs || []).map((gi: any) => {
          const lockLocations = resolveLockLocationsFromMap(
            lockNoMap,
            gi.product_id,
            gi.lot_serial,
          );

          return {
            id: gi.id,
            outbound_id: gi.outbound_id,
            sequence: gi.sequence,
            product_id: gi.product_id,
            code: gi.code,
            name: gi.name,
            unit: gi.unit,
            tracking: gi.tracking,
            lot_id: gi.lot_id, // keep compat
            lot_serial: gi.lot_serial,
            qty: gi.qty,
            pick: gi.pick,
            pack: gi.pack,
            status: gi.status,
            barcode_id: gi.barcode_id,
            user_pick: gi.user_pick,
            user_pack: gi.user_pack,
            barcode_text: gi.barcode_text ?? null,

            input_number: resolveInputNumberFromMap(
              inputMap,
              gi.product_id,
              gi.lot_serial,
            ),

            lock_no: lockLocations.map(
              (x) => `${x.location_name} (จำนวน ${x.qty})`,
            ),
            lock_locations: lockLocations,

            barcode: gi.barcode_ref
              ? {
                  barcode: gi.barcode_ref.barcode,
                  lot_start: gi.barcode_ref.lot_start,
                  lot_stop: gi.barcode_ref.lot_stop,
                  exp_start: gi.barcode_ref.exp_start,
                  exp_stop: gi.barcode_ref.exp_stop,
                  barcode_length: gi.barcode_ref.barcode_length,
                }
              : null,

            boxes:
              gi.boxes
                ?.filter((ib: any) => !ib.deleted_at)
                .map((ib: any) => ({
                  id: ib.box.id,
                  box_code: ib.box.box_code,
                  box_name: ib.box.box_name,
                  quantity: ib.quantity ?? null,
                })) ?? [],
          };
        });

        return formatted;
      }),
    );

    return res.json({ total: data.length, data });
  },
);

function parseSpecialOutboundSearchColumns(raw: unknown) {
  if (typeof raw !== "string") return [];

  const allowed = new Set([
    "date",
    "no",
    "department",
    "status",
    "user_ref",
    "out_type",
  ]);

  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => allowed.has(s));
}

function buildSpecialOutboundSearchWhere(search: string, columns: string[]) {
  const baseWhere: Prisma.outboundWhereInput = {
    deleted_at: null,
    out_type: { in: ["BO", "SV", "GA", "EX", "BOA"] },
    in_process: true,
  };

  if (!search) return baseWhere;

  const orConditions: Prisma.outboundWhereInput[] = [];

  if (columns.includes("date")) {
    const dateRange = parseSearchDateRange(search);
    if (dateRange) {
      orConditions.push({
        date: {
          gte: dateRange.gte,
          lt: dateRange.lt,
        },
      } as any);
    }
  }

  if (columns.includes("no")) {
    orConditions.push({
      no: { contains: search, mode: "insensitive" },
    });
  }

  if (columns.includes("department")) {
    orConditions.push({
      department: { contains: search, mode: "insensitive" },
    } as any);
  }

  if (columns.includes("user_ref")) {
    orConditions.push({
      user_ref: { contains: search, mode: "insensitive" },
    } as any);
  }

  if (columns.includes("status")) {
    orConditions.push({
      status: { contains: search, mode: "insensitive" },
    } as any);
  }

  if (columns.includes("out_type")) {
    orConditions.push({
      out_type: { contains: search, mode: "insensitive" },
    });
  }

  if (orConditions.length === 0) {
    return {
      AND: [baseWhere, { id: -1 }],
    } as Prisma.outboundWhereInput;
  }

  return {
    AND: [baseWhere, { OR: orConditions }],
  } as Prisma.outboundWhereInput;
}

// GET /api/outbounds/adjust
export const getSpecialOutbounds = asyncHandler(
  async (req: Request, res: Response) => {
    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";
    const selectedColumns = parseSpecialOutboundSearchColumns(
      req.query.columns,
    );

    const where = buildSpecialOutboundSearchWhere(search, selectedColumns);

    const outbounds = await prisma.outbound.findMany({
      where,
      include: {
        goods_outs: {
          where: { deleted_at: null },
          include: {
            barcode_ref: { where: { deleted_at: null } },
          },
          orderBy: { sequence: "asc" },
        },
      },
      orderBy: { created_at: "desc" },
    });

    const deptShortMap = await buildDepartmentShortNameMapFromOutbounds(
      outbounds as any,
    );

    const data = await Promise.all(
      outbounds.map(async (outbound) => {
        const formatted: any = formatOdooOutbound(outbound as any);

        const shortName = resolveDepartmentShortNameForOutbound(
          deptShortMap,
          outbound as any,
        );
        if (shortName) formatted.department = shortName;

        const itemsKey = (outbound.goods_outs || []).map((it: any) => ({
          product_id: it.product_id,
          lot_serial: it.lot_serial,
          lot_name: it.lot_serial,
        }));

        const inputMap = await buildInputNumberMapFromItems(itemsKey);

        const lockNoMap = await buildLockNoMapFromItems(
          itemsKey.map((x: any) => ({
            product_id: x.product_id,
            lot_name: x.lot_name,
          })),
        );

        formatted.items = (outbound.goods_outs || []).map((gi: any) => {
          const lockLocations = resolveLockLocationsFromMap(
            lockNoMap,
            gi.product_id,
            gi.lot_serial,
          );

          return {
            id: gi.id,
            outbound_id: gi.outbound_id,
            sequence: gi.sequence,
            product_id: gi.product_id,
            code: gi.code,
            name: gi.name,
            unit: gi.unit,
            tracking: gi.tracking,
            lot_id: gi.lot_id,
            lot_serial: gi.lot_serial,
            qty: gi.qty,
            pick: gi.pick,
            pack: gi.pack,
            status: gi.status,
            barcode_id: gi.barcode_id,
            user_pick: gi.user_pick,
            user_pack: gi.user_pack,
            barcode_text: gi.barcode_text ?? null,

            input_number: resolveInputNumberFromMap(
              inputMap,
              gi.product_id,
              gi.lot_serial,
            ),

            lock_no: lockLocations.map(
              (x: any) => `${x.location_name} (จำนวน ${x.qty})`,
            ),
            lock_locations: lockLocations,

            barcode: gi.barcode_ref
              ? {
                  barcode: gi.barcode_ref.barcode,
                  lot_start: gi.barcode_ref.lot_start,
                  lot_stop: gi.barcode_ref.lot_stop,
                  exp_start: gi.barcode_ref.exp_start,
                  exp_stop: gi.barcode_ref.exp_stop,
                  barcode_length: gi.barcode_ref.barcode_length,
                }
              : null,

            boxes:
              gi.boxes
                ?.filter((ib: any) => !ib.deleted_at)
                .map((ib: any) => ({
                  id: ib.box.id,
                  box_code: ib.box.box_code,
                  box_name: ib.box.box_name,
                  quantity: ib.quantity ?? null,
                })) ?? [],
          };
        });

        return formatted;
      }),
    );

    return res.json({ total: data.length, data });
  },
);

// GET /api/outbounds/adjust/:id
export const getSpecialOutboundById = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const TYPES = ["BO", "SV", "GA", "EX", "BOA"] as const;

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) throw badRequest("id ต้องเป็นตัวเลข");

    const outbound = await prisma.outbound.findFirst({
      where: {
        id,
        deleted_at: null,
        out_type: { in: [...TYPES] },
        in_process: true,
      },
      include: {
        goods_outs: {
          where: { deleted_at: null },
          include: {
            barcode_ref: { where: { deleted_at: null } },
          },
          orderBy: { sequence: "asc" },
        },
      },
    });

    if (!outbound) throw notFound("ไม่พบ Special Outbound นี้");

    // ✅ NEW: map หา short_name แล้ว override department
    const deptShortMap = await buildDepartmentShortNameMapFromOutbounds([
      outbound as any,
    ]);
    const shortName = resolveDepartmentShortNameForOutbound(
      deptShortMap,
      outbound as any,
    );

    const formatted: any = formatOdooOutbound(outbound as any);
    if (shortName) formatted.department = shortName;

    const itemsKey = (outbound.goods_outs || []).map((it: any) => ({
      product_id: it.product_id,
      lot_serial: it.lot_serial,
      lot_name: it.lot_serial,
    }));

    const inputMap = await buildInputNumberMapFromItems(itemsKey);

    const lockNoMap = await buildLockNoMapFromItems(
      itemsKey.map((x: any) => ({
        product_id: x.product_id,
        lot_name: x.lot_name,
      })),
    );

    // ✅ NEW: ดึง exp จาก wms_mdt_goods โดยเช็ค product_id + lot_id
    const goodsRows =
      (outbound.goods_outs || []).filter(
        (it: any) => it.product_id != null && it.lot_id != null,
      ).length > 0
        ? await prisma.wms_mdt_goods.findMany({
            where: {
              OR: (outbound.goods_outs || [])
                .filter((it: any) => it.product_id != null && it.lot_id != null)
                .map((it: any) => ({
                  product_id: Number(it.product_id),
                  lot_id: Number(it.lot_id),
                })),
            },
            select: {
              id: true,
              product_id: true,
              lot_id: true,
              lot_name: true,
              expiration_date: true,
            },
            orderBy: [{ id: "desc" }],
          })
        : [];

    const goodsRowByProductLot = new Map<string, any>();
    for (const g of goodsRows as any[]) {
      const pid = g?.product_id;
      const lid = g?.lot_id;
      if (pid == null || lid == null) continue;

      const key = `${Number(pid)}__${Number(lid)}`;
      if (!goodsRowByProductLot.has(key)) {
        goodsRowByProductLot.set(key, g);
      }
    }

    formatted.items = (outbound.goods_outs || []).map((gi: any) => {
      const lockLocations = resolveLockLocationsFromMap(
        lockNoMap,
        gi.product_id,
        gi.lot_serial,
      );

      const goodsRef =
        gi.product_id != null && gi.lot_id != null
          ? goodsRowByProductLot.get(
              `${Number(gi.product_id)}__${Number(gi.lot_id)}`,
            )
          : null;

      return {
        id: gi.id,
        outbound_id: gi.outbound_id,
        sequence: gi.sequence,
        product_id: gi.product_id,
        code: gi.code,
        name: gi.name,
        unit: gi.unit,
        tracking: gi.tracking,
        lot_id: gi.lot_id,
        lot_serial: gi.lot_serial,
        qty: gi.qty,
        pick: gi.pick,
        pack: gi.pack,
        status: gi.status,
        barcode_id: gi.barcode_id,
        user_pick: gi.user_pick,
        user_pack: gi.user_pack,
        barcode_text: gi.barcode_text ?? null,

        // ✅ NEW
        exp: goodsRef?.expiration_date ?? null,

        input_number: resolveInputNumberFromMap(
          inputMap,
          gi.product_id,
          gi.lot_serial,
        ),

        lock_no: lockLocations.map(
          (x: any) => `${x.location_name} (จำนวน ${x.qty})`,
        ),
        lock_locations: lockLocations,

        barcode: gi.barcode_ref
          ? {
              barcode: gi.barcode_ref.barcode,
              lot_start: gi.barcode_ref.lot_start,
              lot_stop: gi.barcode_ref.lot_stop,
              exp_start: gi.barcode_ref.exp_start,
              exp_stop: gi.barcode_ref.exp_stop,
              barcode_length: gi.barcode_ref.barcode_length,
            }
          : null,

        boxes:
          gi.boxes
            ?.filter((ib: any) => !ib.deleted_at)
            .map((ib: any) => ({
              id: ib.box.id,
              box_code: ib.box.box_code,
              box_name: ib.box.box_name,
              quantity: ib.quantity ?? null,
            })) ?? [],
      };
    });

    return res.json(formatted);
  },
);

const parseDepartmentNames = (value: unknown): string[] => {
  if (typeof value !== "string") return [];

  return value
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
};

const buildOdooOutboundAvailableSearchWhere = async (
  search: string,
): Promise<Prisma.outboundWhereInput> => {
  const terms = search
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  const searchTerms = terms.length > 0 ? terms : [search];

  if (!search || searchTerms.length === 0) return {};

  const orConditions: Prisma.outboundWhereInput[] = [];

  for (const term of searchTerms) {
    const deptIdsFromShortName: string[] = [];

    const deptRows = await prisma.department.findMany({
      where: {
        deleted_at: null,
        OR: [
          { short_name: { contains: term, mode: "insensitive" } },
          { full_name: { contains: term, mode: "insensitive" } },
        ],
      },
      select: { odoo_id: true },
      take: 200,
    });

    for (const d of deptRows) {
      if (d.odoo_id != null && Number.isFinite(Number(d.odoo_id))) {
        deptIdsFromShortName.push(String(d.odoo_id));
      }
    }

    const dateRange = parseSearchDateRange(term);

    orConditions.push(
      { no: { contains: term, mode: "insensitive" } },
      { department: { contains: term, mode: "insensitive" } },
      { reference: { contains: term, mode: "insensitive" } },
      { origin: { contains: term, mode: "insensitive" } },
      { invoice: { contains: term, mode: "insensitive" } },
      {
        goods_outs: {
          some: {
            deleted_at: null,
            OR: [
              { code: { contains: term, mode: "insensitive" } },
              { name: { contains: term, mode: "insensitive" } },
              { sku: { contains: term, mode: "insensitive" } },
              { lot_serial: { contains: term, mode: "insensitive" } },
              { barcode_text: { contains: term, mode: "insensitive" } },
              { unit: { contains: term, mode: "insensitive" } },
            ],
          },
        },
      },
    );

    if (deptIdsFromShortName.length > 0) {
      orConditions.push({
        department_id: { in: deptIdsFromShortName },
      });
    }

    if (dateRange) {
      orConditions.push(
        {
          date: {
            gte: dateRange.gte,
            lt: dateRange.lt,
          },
        },
        {
          created_at: {
            gte: dateRange.gte,
            lt: dateRange.lt,
          },
        },
        {
          updated_at: {
            gte: dateRange.gte,
            lt: dateRange.lt,
          },
        },
      );
    }
  }

  return { OR: orConditions };
};

export const getOdooOutboundsAvailable = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const page = Number(req.query.page) || 1;
    const limit =
      req.query.limit !== undefined ? Number(req.query.limit) || 10 : 10;

    if (isNaN(page) || page < 1) {
      throw badRequest("page ต้องเป็นตัวเลขบวกที่มีค่ามากกว่า 0");
    }

    if (isNaN(limit) || limit < 1) {
      throw badRequest("limit ต้องเป็นตัวเลขบวกที่มีค่ามากกว่า 0");
    }

    const skip = (page - 1) * limit;

    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

    const selectedDepartmentNames = parseDepartmentNames(req.query.department);

    const accessWhere = buildDepartmentAccessWhere(
      req,
    ) as Prisma.outboundWhereInput;

    const allowedDepartmentFilter = accessWhere.department_id;

    const requestedLocalDepartmentIds = parseDepartmentIdsAsNumbers(
      req.query.department_ids ?? req.query.department_id,
    );

    let requestedOdooDepartmentIds: string[] = [];

    if (selectedDepartmentNames.length > 0) {
      const deptRows = await prisma.department.findMany({
        where: {
          deleted_at: null,
          OR: [
            {
              short_name: {
                in: selectedDepartmentNames,
                mode: "insensitive",
              },
            },
            {
              full_name: {
                in: selectedDepartmentNames,
                mode: "insensitive",
              },
            },
          ],
        },
        select: {
          odoo_id: true,
        },
      });

      requestedOdooDepartmentIds = deptRows
        .map((d) => d.odoo_id)
        .filter((v): v is number => v !== null && v !== undefined)
        .map((v) => String(v));
    } else if (requestedLocalDepartmentIds.length > 0) {
      const deptRows = await prisma.department.findMany({
        where: {
          id: { in: requestedLocalDepartmentIds },
          deleted_at: null,
        },
        select: {
          id: true,
          odoo_id: true,
        },
      });

      requestedOdooDepartmentIds = deptRows
        .map((d) => d.odoo_id)
        .filter((v): v is number => v !== null && v !== undefined)
        .map((v) => String(v));
    }

    let selectedDepartmentWhere: Prisma.outboundWhereInput = {};

    if (requestedOdooDepartmentIds.length > 0) {
      if (typeof allowedDepartmentFilter === "string") {
        selectedDepartmentWhere = requestedOdooDepartmentIds.includes(
          allowedDepartmentFilter,
        )
          ? { department_id: allowedDepartmentFilter }
          : { department_id: { in: [] } };
      } else if (
        allowedDepartmentFilter &&
        typeof allowedDepartmentFilter === "object" &&
        "in" in allowedDepartmentFilter
      ) {
        const allowed = (allowedDepartmentFilter.in as (string | number)[]).map(
          (v) => String(v),
        );

        const selected = requestedOdooDepartmentIds.filter((id) =>
          allowed.includes(id),
        );

        selectedDepartmentWhere = {
          department_id: { in: selected },
        };
      } else {
        selectedDepartmentWhere = {
          department_id: { in: requestedOdooDepartmentIds },
        };
      }
    } else {
      if (selectedDepartmentNames.length > 0) {
        selectedDepartmentWhere = { department_id: { in: [] } };
      } else if (typeof allowedDepartmentFilter === "string") {
        selectedDepartmentWhere = { department_id: allowedDepartmentFilter };
      } else if (
        allowedDepartmentFilter &&
        typeof allowedDepartmentFilter === "object" &&
        "in" in allowedDepartmentFilter
      ) {
        selectedDepartmentWhere = {
          department_id: {
            in: (allowedDepartmentFilter.in as (string | number)[]).map((v) =>
              String(v),
            ),
          },
        };
      } else {
        selectedDepartmentWhere = {};
      }
    }

    const baseWhere: Prisma.outboundWhereInput = {
      deleted_at: null,
      batch_lock: null,
      in_process: false,
      ...selectedDepartmentWhere,
    };

    let where: Prisma.outboundWhereInput = baseWhere;

    if (search) {
      const searchCondition =
        await buildOdooOutboundAvailableSearchWhere(search);

      where = {
        AND: [baseWhere, searchCondition],
      };
    }

    const [outbounds, total] = await Promise.all([
      prisma.outbound.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: "desc" },
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
      }),

      prisma.outbound.count({ where }),
    ]);

    const departmentIds = [
      ...new Set(
        outbounds
          .map((ob) =>
            typeof ob.department_id === "string" ? ob.department_id.trim() : "",
          )
          .filter((s) => s !== "")
          .map((s) => parseInt(s, 10))
          .filter((num) => Number.isFinite(num)),
      ),
    ];

    const deptMap = new Map<number, string>();

    if (departmentIds.length > 0) {
      const departments = await prisma.department.findMany({
        where: {
          odoo_id: { in: departmentIds },
          deleted_at: null,
        },
        select: { odoo_id: true, short_name: true },
      });

      for (const dept of departments) {
        if (dept.odoo_id) {
          deptMap.set(Number(dept.odoo_id), dept.short_name);
        }
      }
    }

    const formatted = outbounds.map((ob) => {
      const deptId =
        typeof ob.department_id === "string"
          ? parseInt(ob.department_id, 10)
          : NaN;

      const departmentShortName = Number.isFinite(deptId)
        ? deptMap.get(deptId)
        : undefined;

      const items = Array.isArray(ob.goods_outs)
        ? ob.goods_outs.map((item: any) => ({
            id: item.id,
            outbound_id: item.outbound_id,
            sequence: item.sequence,
            product_id: item.product_id,
            code: item.code,
            name: item.name,
            sku: item.sku,
            unit: item.unit,
            tracking: item.tracking,
            lot_id: item.lot_id,
            lot_serial: item.lot_serial,
            qty: item.qty,
            pick: item.pick,
            confirmed_pick: item.confirmed_pick,
            pack: item.pack,
            rtc: item.rtc,
            rtc_check: item.rtc_check,
            return: item.return,
            return_check: item.return_check,
            status: item.status,
            barcode_id: item.barcode_id,
            barcode_text: item.barcode_text,
            created_at: item.created_at,
            updated_at: item.updated_at,
            barcode: item.barcode_ref
              ? {
                  id: item.barcode_ref.id,
                  barcode: item.barcode_ref.barcode,
                  lot_start: item.barcode_ref.lot_start,
                  lot_stop: item.barcode_ref.lot_stop,
                  exp_start: item.barcode_ref.exp_start,
                  exp_stop: item.barcode_ref.exp_stop,
                  barcode_length: item.barcode_ref.barcode_length,
                }
              : null,
          }))
        : [];

      return {
        id: ob.id,
        no: ob.no,
        date: ob.date,
        created_at: ob.created_at,
        invoice: ob.invoice,
        origin: ob.origin,
        reference: ob.reference,
        department_id: ob.department_id,
        department: departmentShortName ?? ob.department,
        location: ob.location,
        location_dest: ob.location_dest,
        out_type: ob.out_type,
        total_items: items.length,
        items, // ✅ เพิ่มตรงนี้
      };
    });

    return res.json({
      data: formatted,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        department:
          selectedDepartmentNames.length > 0
            ? selectedDepartmentNames.join(",")
            : null,
      },
    });
  },
);

/**
 * GET /api/outbounds/odoo/transfers/:no
 */
export const getOdooOutboundByNo = asyncHandler(
  async (req: Request<{ no: string }>, res: Response) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;
    if (!no) throw badRequest("กรุณาระบุเลข Transfer No");

    const outbound = await prisma.outbound.findUnique({
      where: { no },
      include: {
        goods_outs: {
          where: { deleted_at: null },
          include: {
            barcode_ref: { where: { deleted_at: null } },
          },
          orderBy: { sequence: "asc" },
        },
      },
    });

    if (!outbound) throw notFound(`ไม่พบ Outbound: ${no}`);
    if (outbound.deleted_at) throw badRequest("Outbound นี้ถูกลบไปแล้ว");

    const formatted: any = formatOdooOutbound(outbound as any);

    const deptMap = await buildDepartmentCodeMapFromOutbounds([
      outbound as any,
    ]);
    formatted.department_code = resolveDepartmentCodeForOutbound(
      deptMap,
      outbound as any,
    );

    const itemsKey = (outbound.goods_outs || []).map((it: any) => ({
      product_id: it.product_id,
      lot_serial: it.lot_serial,
      lot_name: it.lot_serial,
    }));

    const inputMap = await buildInputNumberMapFromItems(itemsKey);

    const lockNoMap = await buildLockNoMapFromItems(
      itemsKey.map((x: any) => ({
        product_id: x.product_id,
        lot_name: x.lot_name,
      })),
    );

    formatted.items = (outbound.goods_outs || []).map((gi: any) => {
      const lockLocations = resolveLockLocationsFromMap(
        lockNoMap,
        gi.product_id,
        gi.lot_serial,
      );

      return {
        id: gi.id,
        outbound_id: gi.outbound_id,
        sequence: gi.sequence,
        product_id: gi.product_id,
        code: gi.code,
        name: gi.name,
        unit: gi.unit,
        tracking: gi.tracking,
        lot_id: gi.lot_id,
        lot_serial: gi.lot_serial,
        qty: gi.qty,
        pick: gi.pick,
        pack: gi.pack,
        status: gi.status,
        barcode_id: gi.barcode_id,
        user_pick: gi.user_pick,
        user_pack: gi.user_pack,
        barcode_text: gi.barcode_text ?? null,

        input_number: resolveInputNumberFromMap(
          inputMap,
          gi.product_id,
          gi.lot_serial,
        ),

        lock_no: lockLocations.map(
          (x) => `${x.location_name} (จำนวน ${x.qty})`,
        ),
        lock_locations: lockLocations,

        barcode: gi.barcode_ref
          ? {
              barcode: gi.barcode_ref.barcode,
              lot_start: gi.barcode_ref.lot_start,
              lot_stop: gi.barcode_ref.lot_stop,
              exp_start: gi.barcode_ref.exp_start,
              exp_stop: gi.barcode_ref.exp_stop,
              barcode_length: gi.barcode_ref.barcode_length,
            }
          : null,

        boxes:
          gi.boxes
            ?.filter((ib: any) => !ib.deleted_at)
            .map((ib: any) => ({
              id: ib.box.id,
              box_code: ib.box.box_code,
              box_name: ib.box.box_name,
              quantity: ib.quantity ?? null,
            })) ?? [],
      };
    });

    return res.json(formatted);
  },
);

export const getOdooOutboundsByMyBatch = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!Number.isFinite(userId)) throw badRequest("ไม่พบ user ใน token");

    const page = Math.max(1, Number(req.query.page ?? 1));
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 200)));
    const search =
      typeof req.query.search === "string" ? req.query.search.trim() : "";
    const skip = (page - 1) * limit;

    const locks = await prisma.batch_outbound.findMany({
      where: { user_id: userId, status: "process" },
      select: { outbound_id: true, name: true, created_at: true },
    });

    if (locks.length === 0) {
      return res.json({ total: 0, page, limit, data: [] });
    }

    const outboundIds = locks.map((x) => x.outbound_id);

    const batchMap = new Map<
      number,
      { name: string | null; created_at: Date }
    >();
    for (const l of locks) {
      batchMap.set(l.outbound_id, {
        name: l.name ?? null,
        created_at: l.created_at,
      });
    }

    const where: Prisma.outboundWhereInput = {
      id: { in: outboundIds },
      deleted_at: null,
      picking_id: { not: null },
      ...(search
        ? {
            OR: [
              { no: { contains: search, mode: "insensitive" } },
              { outbound_barcode: { contains: search, mode: "insensitive" } },
              { out_type: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [total, outbounds] = await prisma.$transaction([
      prisma.outbound.count({ where }),
      prisma.outbound.findMany({
        where,
        include: {
          goods_outs: {
            where: { deleted_at: null },
            include: {
              barcode_ref: { where: { deleted_at: null } },

              // ✅ NEW: pick แยก location
              goodsOutItemLocationPicks: {
                include: {
                  location: {
                    select: {
                      id: true,
                      full_name: true,
                    },
                  },
                },
              },
            },
            orderBy: { sequence: "asc" },
          },
        },
        skip,
        take: limit,
      }),
    ]);

    const deptMap = await buildDepartmentCodeMapFromOutbounds(outbounds as any);

    const data = await Promise.all(
      outbounds.map(async (outbound) => {
        const formatted: any = formatOdooOutbound(outbound as any);

        const batchInfo = batchMap.get(outbound.id);
        formatted.batch_name = batchInfo?.name ?? null;
        formatted.created_at = (
          batchInfo?.created_at ?? outbound.created_at
        ).toISOString();

        formatted.department_code = resolveDepartmentCodeForOutbound(
          deptMap,
          outbound as any,
        );

        const itemsKey = (outbound.goods_outs || []).map((it: any) => ({
          product_id: it.product_id,
          lot_serial: it.lot_serial,
          lot_name: it.lot_serial,
        }));

        const inputMap = await buildInputNumberMapFromItems(itemsKey);

        const lockNoMap = await buildLockNoMapFromItems(
          itemsKey.map((x: any) => ({
            product_id: x.product_id,
            lot_name: x.lot_name,
          })),
        );

        const expInput = (outbound.goods_outs || []).map((it: any) => {
          const locks = resolveLockLocationsFromMap(
            lockNoMap,
            it.product_id,
            it.lot_serial,
          );

          const location_ids = Array.isArray(locks)
            ? locks
                .map((x) => x.location_id)
                .filter(
                  (n): n is number =>
                    typeof n === "number" && Number.isFinite(n) && n > 0,
                )
            : [];

          return {
            product_id: it.product_id ?? null,
            lot_serial: it.lot_serial ?? null,
            location_ids,
          };
        });

        const { byLoc: expByLoc, byNoLoc: expByNoLoc } =
          await buildExpirationMapsFromStocks({ items: expInput });

        formatted.items = (outbound.goods_outs || []).map((gi: any) => {
          const locks = resolveLockLocationsFromMap(
            lockNoMap,
            gi.product_id,
            gi.lot_serial,
          );

          const locId = firstLocId(locks);
          const exp =
            gi.product_id != null
              ? ((locId != null
                  ? expByLoc.get(
                      expKeyLocOf(gi.product_id, gi.lot_serial, locId),
                    )
                  : undefined) ??
                expByNoLoc.get(expKeyNoLocOf(gi.product_id, gi.lot_serial)) ??
                null)
              : null;

          const location_picks = Array.isArray(gi.goodsOutItemLocationPicks)
            ? gi.goodsOutItemLocationPicks.map((lp: any) => ({
                location_id: Number(lp.location_id ?? lp.location?.id ?? 0),
                location_name: String(lp.location?.full_name ?? ""),
                qty_pick: Number(lp.qty_pick ?? 0),
              }))
            : [];

          return {
            id: gi.id,
            outbound_id: gi.outbound_id,
            sequence: gi.sequence,
            product_id: gi.product_id,
            code: gi.code,
            name: gi.name,
            unit: gi.unit,
            tracking: gi.tracking,
            lot_id: gi.lot_id,
            lot_serial: gi.lot_serial,

            exp: exp ? new Date(exp).toISOString() : null,

            qty: gi.qty,
            pick: gi.pick,
            pack: gi.pack,
            status: gi.status,
            barcode_id: gi.barcode_id,
            user_pick: gi.user_pick,
            user_pack: gi.user_pack,
            barcode_text: gi.barcode_text ?? null,

            input_number: resolveInputNumberFromMap(
              inputMap,
              gi.product_id,
              gi.lot_serial,
            ),

            lock_no: (locks || []).map(
              (x) => `${x.location_name} (จำนวน ${x.qty})`,
            ),
            lock_locations: locks,

            // ✅ NEW
            location_picks,

            barcode: gi.barcode_ref
              ? {
                  barcode: gi.barcode_ref.barcode,
                  lot_start: gi.barcode_ref.lot_start,
                  lot_stop: gi.barcode_ref.lot_stop,
                  exp_start: gi.barcode_ref.exp_start,
                  exp_stop: gi.barcode_ref.exp_stop,
                  barcode_length: gi.barcode_ref.barcode_length,
                }
              : null,

            boxes:
              gi.boxes
                ?.filter((ib: any) => !ib.deleted_at)
                .map((ib: any) => ({
                  id: ib.box.id,
                  box_code: ib.box.box_code,
                  box_name: ib.box.box_name,
                  quantity: ib.quantity ?? null,
                })) ?? [],
          };
        });

        return formatted;
      }),
    );

    return res.json({ total, page, limit, data });
  },
);

export const getOdooOutboundsByBatchName = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const userId = getUserId(req);
    if (!Number.isFinite(userId)) throw badRequest("ไม่พบ user ใน token");

    if (!req.departmentAccess) {
      throw badRequest(
        "กรุณาเรียก attachDepartmentAccess middleware ก่อนใช้งาน endpoint นี้",
      );
    }

    const rawName = Array.isArray(req.params.name)
      ? req.params.name[0]
      : req.params.name;

    const name = decodeURIComponent(String(rawName ?? "")).trim();
    if (!name) throw badRequest("กรุณาระบุ batch name");

    const page = Math.max(1, Number(req.query.page ?? 1));
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 200)));
    const skip = (page - 1) * limit;

    const search =
      typeof req.query.search === "string" ? req.query.search.trim() : "";
    const code =
      typeof req.query.code === "string" ? req.query.code.trim() : "";
    const product_id =
      typeof req.query.product_id === "string"
        ? req.query.product_id.trim()
        : "";

    const parsedProductId = product_id ? Number(product_id) : null;

    if (product_id && !Number.isFinite(parsedProductId)) {
      throw badRequest("product_id ต้องเป็นตัวเลข");
    }

    const normalizeRefKey = (value: unknown) =>
      String(value ?? "")
        .trim()
        .toLowerCase();

    const departmentWhere: Prisma.outboundWhereInput = req.departmentAccess
      .isPrivileged
      ? {}
      : Array.isArray(req.departmentAccess.allowedDepartmentIds) &&
          req.departmentAccess.allowedDepartmentIds.length > 0
        ? {
            department_id: {
              in: req.departmentAccess.allowedDepartmentIds,
            },
          }
        : {
            department_id: "__NO_ACCESS__",
          };

    const allUserLocks = await prisma.batch_outbound.findMany({
      where: { name },
      select: {
        outbound_id: true,
        name: true,
        created_at: true,
        id: true,
        status: true,
        user_id: true,
      },
      orderBy: { id: "asc" },
    });

    if (allUserLocks.length === 0) {
      throw notFound(`ไม่พบ batch name: ${name}`);
    }

    const locks = allUserLocks;
    const outboundIds = locks.map((l) => l.outbound_id);

    const batchMap = new Map<
      number,
      { name: string | null; created_at: Date; status: string | null }
    >();

    for (const l of locks) {
      batchMap.set(l.outbound_id, {
        name: l.name ?? null,
        created_at: l.created_at,
        status: l.status ?? null,
      });
    }

    const itemFilterEnabled = Boolean(code) || Number.isFinite(parsedProductId);

    const goodsOutItemWhere: Prisma.goods_out_itemWhereInput = {
      deleted_at: null,
      ...(code ? { code: { contains: code, mode: "insensitive" } } : {}),
      ...(Number.isFinite(parsedProductId)
        ? { product_id: parsedProductId as number }
        : {}),
    };

    const where: Prisma.outboundWhereInput = {
      id: { in: outboundIds },
      deleted_at: null,
      picking_id: { not: null },
      ...departmentWhere,
      ...(search
        ? {
            OR: [
              { no: { contains: search, mode: "insensitive" } },
              { invoice: { contains: search, mode: "insensitive" } },
              { outbound_barcode: { contains: search, mode: "insensitive" } },
              { out_type: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
      ...(itemFilterEnabled
        ? {
            goods_outs: {
              some: goodsOutItemWhere,
            },
          }
        : {}),
    };

    const [total, outboundsRaw] = await prisma.$transaction([
      prisma.outbound.count({ where }),
      prisma.outbound.findMany({
        where,
        include: {
          goods_outs: {
            where: itemFilterEnabled ? goodsOutItemWhere : { deleted_at: null },
            include: {
              barcode_ref: { where: { deleted_at: null } },

              goodsOutItemLocationPicks: {
                include: {
                  location: {
                    select: {
                      id: true,
                      full_name: true,
                    },
                  },
                },
              },

              location_confirms: {
                include: {
                  location: {
                    select: {
                      id: true,
                      full_name: true,
                    },
                  },
                },
              },

              goodsOutItemLocationReturns: {
                include: {
                  location: {
                    select: {
                      id: true,
                      full_name: true,
                    },
                  },
                },
              },

              lot_adjustment: {
                select: {
                  id: true,
                  status: true,
                },
              },
              source_item: {
                select: {
                  id: true,
                },
              },
              split_children: {
                where: { deleted_at: null },
                select: {
                  id: true,
                },
              },
            },
            orderBy: [{ sequence: "asc" }, { id: "asc" }],
          },

          outboundLotAdjustments: {
            where: { deleted_at: null },
            select: {
              id: true,
              goods_out_item_id: true,
              status: true,
              original_lot_serial: true,
              original_qty: true,
              created_at: true,
              lines: {
                where: { deleted_at: null },
                select: {
                  id: true,
                  lot_id: true,
                  lot_serial: true,
                  qty: true,
                  is_original_lot: true,
                },
                orderBy: { id: "asc" },
              },
            },
            orderBy: { id: "asc" },
          },
        },
        skip,
        take: limit,
      }),
    ]);

    const allowedOutboundIdSet = new Set(outboundsRaw.map((x) => x.id));

    const orderIndex = new Map<number, number>();
    locks.forEach((l, idx) => {
      if (allowedOutboundIdSet.has(l.outbound_id)) {
        orderIndex.set(l.outbound_id, idx);
      }
    });

    const outbounds = [...outboundsRaw].sort((a, b) => {
      const ia = orderIndex.get(a.id) ?? 999999;
      const ib = orderIndex.get(b.id) ?? 999999;
      return ia - ib;
    });

    const outboundRefs = Array.from(
      new Set(
        outbounds
          .flatMap((o: any) => [o.no, o.origin, o.invoice, o.reference])
          .map((v) => String(v ?? "").trim())
          .filter(Boolean),
      ),
    );

    const pdRefs = Array.from(
      new Set(
        outbounds
          .flatMap((o: any) => [o.origin, o.invoice])
          .map((v) => String(v ?? "").trim())
          .filter(Boolean),
      ),
    );

    const pdInbounds =
      pdRefs.length > 0
        ? await prisma.inbound.findMany({
            where: {
              deleted_at: null,
              in_type: "PD",
              OR: pdRefs.map((ref) => ({
                origin: {
                  equals: ref,
                  mode: "insensitive",
                },
              })),
            },
            include: {
              goods_ins: {
                where: { deleted_at: null },
                orderBy: [{ sequence: "asc" }, { id: "asc" }],
              },
            },
            orderBy: { id: "desc" },
          })
        : [];

    const pdInboundMap = new Map<string, any[]>();

    for (const inbound of pdInbounds as any[]) {
      const key = normalizeRefKey(inbound.origin);
      if (!key) continue;

      if (!pdInboundMap.has(key)) pdInboundMap.set(key, []);
      pdInboundMap.get(key)!.push(inbound);
    }

    const rtcInbounds =
      outboundRefs.length > 0
        ? await prisma.inbound.findMany({
            where: {
              deleted_at: null,
              in_type: "RTC",
              OR: [
                ...outboundRefs.map((ref) => ({
                  origin: {
                    contains: ref,
                    mode: "insensitive",
                  },
                })),
                ...outboundRefs.map((ref) => ({
                  reference: {
                    contains: ref,
                    mode: "insensitive",
                  },
                })),
                ...outboundRefs.map((ref) => ({
                  invoice: {
                    contains: ref,
                    mode: "insensitive",
                  },
                })),
                ...outboundRefs.map((ref) => ({
                  no: {
                    contains: ref,
                    mode: "insensitive",
                  },
                })),
              ],
            } as any,
            include: {
              goods_ins: {
                where: { deleted_at: null },
                orderBy: [{ sequence: "asc" }, { id: "asc" }],
              },
            },
            orderBy: { id: "desc" },
          })
        : [];

    const rtcInboundMap = new Map<string, any[]>();

    const putRtcInboundMap = (keyRaw: unknown, inbound: any) => {
      const key = normalizeRefKey(keyRaw);
      if (!key) return;

      if (!rtcInboundMap.has(key)) rtcInboundMap.set(key, []);
      rtcInboundMap.get(key)!.push(inbound);
    };

    for (const inbound of rtcInbounds as any[]) {
      const inboundKeys = [
        inbound.no,
        inbound.origin,
        inbound.reference,
        inbound.invoice,
      ]
        .map(normalizeRefKey)
        .filter(Boolean);

      for (const key of inboundKeys) {
        putRtcInboundMap(key, inbound);
      }

      const haystack = inboundKeys.join(" ");

      for (const outbound of outbounds as any[]) {
        const outboundNoKey = normalizeRefKey(outbound.no);
        const outboundOriginKey = normalizeRefKey(outbound.origin);
        const outboundInvoiceKey = normalizeRefKey(outbound.invoice);
        const outboundReferenceKey = normalizeRefKey(outbound.reference);

        const candidateKeys = [
          outboundNoKey,
          outboundOriginKey,
          outboundInvoiceKey,
          outboundReferenceKey,
        ].filter(Boolean);

        for (const key of candidateKeys) {
          if (haystack.includes(key)) {
            putRtcInboundMap(key, inbound);
          }
        }
      }
    }

    const mapInboundItems = (inbound: any) =>
      Array.isArray(inbound.goods_ins)
        ? inbound.goods_ins.map((gi: any) => ({
            id: gi.id,
            inbound_id: gi.inbound_id,
            sequence: gi.sequence ?? null,
            product_id: gi.product_id,
            code: gi.code,
            name: gi.name,
            unit: gi.unit,
            tracking: gi.tracking ?? null,
            lot_id: gi.lot_id,
            lot_serial: gi.lot_serial,
            barcode_id: gi.barcode_id ?? null,
            barcode_text: gi.barcode_text ?? null,
            qty: gi.quantity ?? gi.qty ?? null,
            quantity: gi.quantity ?? null,
            quantity_count: gi.quantity_count ?? null,
            status: gi.status ?? null,
            created_at: gi.created_at ?? null,
            updated_at: gi.updated_at ?? null,
          }))
        : [];

    const deptMap = await buildDepartmentCodeMapFromOutbounds(outbounds as any);

    const data = await Promise.all(
      outbounds.map(async (outbound) => {
        const formatted: any = formatOdooOutbound(outbound as any);

        const batchInfo = batchMap.get(outbound.id);
        formatted.batch_name = batchInfo?.name ?? null;
        formatted.batch_status = batchInfo?.status ?? null;
        formatted.created_at = (
          batchInfo?.created_at ?? outbound.created_at
        ).toISOString();

        formatted.department_code = resolveDepartmentCodeForOutbound(
          deptMap,
          outbound as any,
        );

        const outboundNoKey = normalizeRefKey(outbound.no);
        const outboundOriginKey = normalizeRefKey(outbound.origin);
        const outboundInvoiceKey = normalizeRefKey(outbound.invoice);
        const outboundReferenceKey = normalizeRefKey(outbound.reference);

        const pdInboundsByOrigin = outboundOriginKey
          ? (pdInboundMap.get(outboundOriginKey) ?? [])
          : [];

        const pdInboundsByInvoice = outboundInvoiceKey
          ? (pdInboundMap.get(outboundInvoiceKey) ?? [])
          : [];

        const pdInboundUniqueMap = new Map<number, any>();

        for (const pd of [...pdInboundsByOrigin, ...pdInboundsByInvoice]) {
          pdInboundUniqueMap.set(Number(pd.id), pd);
        }

        formatted.pd_inbounds = [...pdInboundUniqueMap.values()].map(
          (pd: any) => ({
            id: pd.id,
            no: pd.no,
            picking_id: pd.picking_id ?? null,
            in_type: pd.in_type,
            origin: pd.origin,
            invoice: pd.invoice ?? null,
            reference: pd.reference ?? null,
            status: pd.status,
            location_id: pd.location_id ?? null,
            location: pd.location ?? null,
            location_dest_id: pd.location_dest_id ?? null,
            location_dest: pd.location_dest ?? null,
            department_id: pd.department_id ?? null,
            department: pd.department ?? null,
            created_at: pd.created_at,
            updated_at: pd.updated_at ?? null,
            matched_outbound_by:
              outboundOriginKey &&
              normalizeRefKey(pd.origin) === outboundOriginKey
                ? "origin"
                : outboundInvoiceKey &&
                    normalizeRefKey(pd.origin) === outboundInvoiceKey
                  ? "invoice"
                  : null,
            matched_outbound_value: String(pd.origin ?? "").trim() || null,
            items: mapInboundItems(pd),
          }),
        );

        const rtcCandidates = [
          ...(outboundNoKey ? (rtcInboundMap.get(outboundNoKey) ?? []) : []),
          ...(outboundOriginKey
            ? (rtcInboundMap.get(outboundOriginKey) ?? [])
            : []),
          ...(outboundInvoiceKey
            ? (rtcInboundMap.get(outboundInvoiceKey) ?? [])
            : []),
          ...(outboundReferenceKey
            ? (rtcInboundMap.get(outboundReferenceKey) ?? [])
            : []),
        ];

        const rtcInboundUniqueMap = new Map<number, any>();

        for (const rtc of rtcCandidates) {
          rtcInboundUniqueMap.set(Number(rtc.id), rtc);
        }

        formatted.rtc_inbounds = [...rtcInboundUniqueMap.values()].map(
          (rtc: any) => {
            const rtcOriginKey = normalizeRefKey(rtc.origin);
            const rtcInvoiceKey = normalizeRefKey(rtc.invoice);
            const rtcReferenceKey = normalizeRefKey(rtc.reference);
            const rtcNoKey = normalizeRefKey(rtc.no);
            const rtcHaystack = [
              rtcOriginKey,
              rtcInvoiceKey,
              rtcReferenceKey,
              rtcNoKey,
            ].join(" ");

            let matchedBy: string | null = null;
            let matchedValue: string | null = null;

            if (outboundNoKey && rtcHaystack.includes(outboundNoKey)) {
              matchedBy = "outbound_no";
              matchedValue = String(outbound.no ?? "").trim();
            } else if (
              outboundOriginKey &&
              rtcHaystack.includes(outboundOriginKey)
            ) {
              matchedBy = "origin";
              matchedValue = String(outbound.origin ?? "").trim();
            } else if (
              outboundInvoiceKey &&
              rtcHaystack.includes(outboundInvoiceKey)
            ) {
              matchedBy = "invoice";
              matchedValue = String(outbound.invoice ?? "").trim();
            } else if (
              outboundReferenceKey &&
              rtcHaystack.includes(outboundReferenceKey)
            ) {
              matchedBy = "reference";
              matchedValue = String(outbound.reference ?? "").trim();
            }

            return {
              id: rtc.id,
              no: rtc.no,
              picking_id: rtc.picking_id ?? null,
              in_type: rtc.in_type,
              origin: rtc.origin,
              invoice: rtc.invoice ?? null,
              reference: rtc.reference ?? null,
              status: rtc.status,
              location_id: rtc.location_id ?? null,
              location: rtc.location ?? null,
              location_dest_id: rtc.location_dest_id ?? null,
              location_dest: rtc.location_dest ?? null,
              department_id: rtc.department_id ?? null,
              department: rtc.department ?? null,
              created_at: rtc.created_at,
              updated_at: rtc.updated_at ?? null,
              matched_outbound_by: matchedBy,
              matched_outbound_value: matchedValue,
              items: mapInboundItems(rtc),
            };
          },
        );

        const visibleGoodsOuts = Array.isArray(outbound.goods_outs)
          ? outbound.goods_outs.filter((it: any) => !it.deleted_at)
          : [];

        const itemsKey = visibleGoodsOuts.map((it: any) => ({
          product_id: it.product_id,
          lot_serial: it.lot_serial,
          lot_name: it.lot_serial,
        }));

        const inputMap = await buildInputNumberMapFromItems(itemsKey);

        const lockNoMap = await buildLockNoMapFromItems(
          itemsKey.map((x: any) => ({
            product_id: x.product_id,
            lot_name: x.lot_name,
          })),
        );

        const expInput = visibleGoodsOuts.map((it: any) => {
          const locks = resolveLockLocationsFromMap(
            lockNoMap,
            it.product_id,
            it.lot_serial,
          );

          const location_ids = Array.isArray(locks)
            ? locks
                .map((x) => x.location_id)
                .filter(
                  (n): n is number =>
                    typeof n === "number" && Number.isFinite(n) && n > 0,
                )
            : [];

          return {
            product_id: it.product_id ?? null,
            lot_serial: it.lot_serial ?? null,
            location_ids,
          };
        });

        const { byLoc: expByLoc, byNoLoc: expByNoLoc } =
          await buildExpirationMapsFromStocks({ items: expInput });

        formatted.items = visibleGoodsOuts.map((gi: any) => {
          const locks = resolveLockLocationsFromMap(
            lockNoMap,
            gi.product_id,
            gi.lot_serial,
          );

          const locId = firstLocId(locks);

          const exp =
            gi.product_id != null
              ? ((locId != null
                  ? expByLoc.get(
                      expKeyLocOf(gi.product_id, gi.lot_serial, locId),
                    )
                  : undefined) ??
                expByNoLoc.get(expKeyNoLocOf(gi.product_id, gi.lot_serial)) ??
                null)
              : null;

          const location_picks = Array.isArray(gi.goodsOutItemLocationPicks)
            ? gi.goodsOutItemLocationPicks.map((lp: any) => ({
                location_id: Number(lp.location_id ?? lp.location?.id ?? 0),
                location_name: String(lp.location?.full_name ?? ""),
                qty_pick: Number(lp.qty_pick ?? 0),
              }))
            : [];

          const location_confirms = Array.isArray(gi.location_confirms)
            ? gi.location_confirms.map((lc: any) => ({
                location_id: Number(lc.location_id ?? lc.location?.id ?? 0),
                location_name: String(lc.location?.full_name ?? ""),
                confirmed_pick: Number(lc.confirmed_pick ?? 0),
              }))
            : [];

          const return_locations = Array.isArray(gi.goodsOutItemLocationReturns)
            ? gi.goodsOutItemLocationReturns.map((lr: any) => ({
                location_id: Number(lr.location_id ?? lr.location?.id ?? 0),
                location_name: String(lr.location?.full_name ?? ""),
                return: Number(lr.return ?? 0),
              }))
            : [];

          return {
            id: gi.id,
            outbound_id: gi.outbound_id,
            sequence: gi.sequence,
            product_id: gi.product_id,
            code: gi.code,
            name: gi.name,
            unit: gi.unit,
            tracking: gi.tracking,
            lot_id: gi.lot_id,
            lot_serial: gi.lot_serial,
            lot_adjustment_id: gi.lot_adjustment_id ?? null,
            exp: exp ? new Date(exp).toISOString() : null,
            qty: gi.qty,
            pick: gi.pick,
            confirmed_pick: Number(gi.confirmed_pick ?? 0),
            pack: gi.pack,
            rtc: gi.rtc ?? null,
            rtc_check: Boolean(gi.rtc_check),
            return: Number(gi.return ?? 0),
            return_check: Boolean(gi.return_check),
            status: gi.status,
            barcode_id: gi.barcode_id,
            user_pick: gi.user_pick,
            user_pack: gi.user_pack,
            barcode_text: gi.barcode_text ?? null,
            input_number: resolveInputNumberFromMap(
              inputMap,
              gi.product_id,
              gi.lot_serial,
            ),
            lock_no: (locks || []).map(
              (x) => `${x.location_name} (จำนวน ${x.qty})`,
            ),
            lock_locations: locks,
            location_picks,
            location_confirms,
            return_locations,
            barcode: gi.barcode_ref
              ? {
                  barcode: gi.barcode_ref.barcode,
                  lot_start: gi.barcode_ref.lot_start,
                  lot_stop: gi.barcode_ref.lot_stop,
                  exp_start: gi.barcode_ref.exp_start,
                  exp_stop: gi.barcode_ref.exp_stop,
                  barcode_length: gi.barcode_ref.barcode_length,
                }
              : null,
            boxes:
              gi.boxes
                ?.filter((ib: any) => !ib.deleted_at)
                .map((ib: any) => ({
                  id: ib.box.id,
                  box_code: ib.box.box_code,
                  box_name: ib.box.box_name,
                  quantity: ib.quantity ?? null,
                })) ?? [],
          };
        });

        return formatted;
      }),
    );

    res.set("Cache-Control", "no-store");

    return res.json({
      batch_name: name,
      total,
      page,
      limit,
      search_criteria: {
        search: search || null,
        code: code || null,
        product_id: Number.isFinite(parsedProductId) ? parsedProductId : null,
      },
      data,
    });
  },
);

/**
 * PATCH /api/outbounds/odoo/transfers/:no
 */
export const updateOdooOutbound = asyncHandler(
  async (req: Request<{ no: string }>, res: Response) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;
    const updateData = req.body;

    if (!no) throw badRequest("กรุณาระบุเลข Transfer No");

    const existing = await prisma.outbound.findUnique({ where: { no } });
    if (!existing) throw notFound(`ไม่พบ Outbound: ${no}`);
    if (existing.deleted_at)
      throw badRequest("ไม่สามารถแก้ไข Outbound ที่ถูกลบแล้ว");

    const updated = await prisma.outbound.update({
      where: { no },
      data: {
        picking_id: updateData.picking_id ?? undefined,
        location_id: updateData.location_id ?? undefined,
        location: updateData.location ?? undefined,
        location_dest_id: updateData.location_dest_id ?? undefined,
        location_dest: updateData.location_dest ?? undefined,
        department_id: updateData.department_id?.toString() ?? undefined,
        department: updateData.department ?? undefined,
        reference: updateData.reference ?? undefined,
        invoice: updateData.invoice ?? undefined,
        origin: updateData.origin ?? undefined,
        updated_at: new Date(),
      },
      include: {
        goods_outs: {
          where: { deleted_at: null },
          orderBy: { sequence: "asc" },
        },
      },
    });

    return res.json({
      message: "อัพเดท Outbound สำเร็จ",
      data: formatOdooOutbound(updated),
    });
  },
);

/**
 * DELETE /api/outbounds/odoo/transfers/:no
 */
export const deleteOdooOutbound = asyncHandler(
  async (req: Request<{ no: string }>, res: Response) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;

    if (!no) throw badRequest("กรุณาระบุเลข Transfer No");

    const existing = await prisma.outbound.findUnique({
      where: { no },
      include: { goods_outs: true },
    });

    if (!existing) throw notFound(`ไม่พบ Outbound: ${no}`);
    if (existing.deleted_at) throw badRequest("Outbound นี้ถูกลบไปแล้ว");

    await prisma.outbound.update({
      where: { no },
      data: { deleted_at: new Date(), updated_at: new Date() },
    });

    if (existing.goods_outs.length > 0) {
      await prisma.goods_out_item.updateMany({
        where: { outbound_id: existing.id, deleted_at: null },
        data: { deleted_at: new Date(), updated_at: new Date() },
      });
    }

    return res.json({
      message: `ลบ Outbound ${no} และ ${existing.goods_outs.length} items สำเร็จ`,
    });
  },
);

/**
 * POST /api/outbounds/bulk-delete
 */
export const bulkDeleteOutbounds = asyncHandler(
  async (req: Request<{}, {}, { outbound_nos: string[] }>, res: Response) => {
    const { outbound_nos } = req.body;

    if (
      !outbound_nos ||
      !Array.isArray(outbound_nos) ||
      outbound_nos.length === 0
    )
      throw badRequest("กรุณาระบุ outbound_nos เป็น array");

    const outbounds = await prisma.outbound.findMany({
      where: { no: { in: outbound_nos }, deleted_at: null },
      include: { goods_outs: { where: { deleted_at: null } } },
    });

    if (outbounds.length === 0) throw notFound("ไม่พบ Outbound ที่ต้องการลบ");

    await prisma.outbound.updateMany({
      where: { no: { in: outbounds.map((o) => o.no) } },
      data: { deleted_at: new Date(), updated_at: new Date() },
    });

    const outboundIds = outbounds.map((o) => o.id);
    const deletedItems = await prisma.goods_out_item.updateMany({
      where: { outbound_id: { in: outboundIds }, deleted_at: null },
      data: { deleted_at: new Date(), updated_at: new Date() },
    });

    return res.json({
      message: `ลบ ${outbounds.length} Outbounds สำเร็จ`,
      deleted_outbounds: outbounds.length,
      deleted_items: deletedItems.count,
      outbound_nos: outbounds.map((o) => o.no),
    });
  },
);

/**
 * POST /api/outbounds/odoo/transfers/:no/items/:itemId/barcode
 */
export const createOrUpdateOutboundItemBarcode = asyncHandler(
  async (
    req: Request<{ no: string; itemId: string }, {}, { barcode_id: number }>,
    res: Response,
  ) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;
    const itemIdStr = Array.isArray(req.params.itemId)
      ? req.params.itemId[0]
      : req.params.itemId;
    const itemId = parseInt(itemIdStr, 10);
    const { barcode_id } = req.body;

    if (!no) throw badRequest("กรุณาระบุเลข Transfer No");
    if (isNaN(itemId)) throw badRequest("Item ID ต้องเป็นตัวเลข");
    if (!barcode_id) throw badRequest("กรุณาระบุ barcode_id");

    const outbound = await prisma.outbound.findUnique({ where: { no } });
    if (!outbound) throw notFound(`ไม่พบ Outbound: ${no}`);
    if (outbound.deleted_at) throw badRequest("Outbound นี้ถูกลบไปแล้ว");

    const item = await prisma.goods_out_item.findUnique({
      where: { id: itemId },
    });
    if (!item) throw notFound(`ไม่พบ Item: ${itemId}`);
    if (item.outbound_id !== outbound.id)
      throw badRequest("Item ไม่ตรงกับ Outbound ที่ระบุ");
    if (item.deleted_at) throw badRequest("Item นี้ถูกลบไปแล้ว");

    const barcode = await prisma.barcode.findUnique({
      where: { id: barcode_id },
    });
    if (!barcode) throw notFound(`ไม่พบ Barcode ID: ${barcode_id}`);
    if (barcode.deleted_at) throw badRequest("Barcode นี้ถูกลบไปแล้ว");

    const updatedItem = await prisma.goods_out_item.update({
      where: { id: itemId },
      data: { barcode_id, updated_at: new Date() },
      include: {
        barcode_ref: true,
      },
    });

    return res.json({
      message: "เชื่อม Barcode สำเร็จ",
      data: {
        id: updatedItem.id,
        outbound_id: updatedItem.outbound_id,
        pick: updatedItem.pick,
        pack: updatedItem.pack,
        barcode_id: updatedItem.barcode_id,
        barcode: updatedItem.barcode_ref
          ? {
              barcode: updatedItem.barcode_ref.barcode,
              lot_start: updatedItem.barcode_ref.lot_start,
              lot_stop: updatedItem.barcode_ref.lot_stop,
              exp_start: updatedItem.barcode_ref.exp_start,
              exp_stop: updatedItem.barcode_ref.exp_stop,
              barcode_length: updatedItem.barcode_ref.barcode_length,
            }
          : null,
      },
    });
  },
);

/**
 * DELETE /api/outbounds/odoo/transfers/:no/items/:itemId/barcode
 */
export const removeOutboundItemBarcode = asyncHandler(
  async (req: Request<{ no: string; itemId: string }>, res: Response) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;
    const itemIdStr = Array.isArray(req.params.itemId)
      ? req.params.itemId[0]
      : req.params.itemId;
    const itemId = parseInt(itemIdStr, 10);

    if (!no) throw badRequest("กรุณาระบุเลข Transfer No");
    if (isNaN(itemId)) throw badRequest("Item ID ต้องเป็นตัวเลข");

    const item = await prisma.goods_out_item.findUnique({
      where: { id: itemId },
    });
    if (!item) throw notFound(`ไม่พบ Item: ${itemId}`);

    const outbound = await prisma.outbound.findUnique({ where: { no } });
    if (!outbound || item.outbound_id !== outbound.id)
      throw badRequest("Item ไม่ตรงกับ Outbound ที่ระบุ");
    if (item.deleted_at) throw badRequest("Item นี้ถูกลบไปแล้ว");

    await prisma.goods_out_item.update({
      where: { id: itemId },
      data: { barcode_id: null, updated_at: new Date() },
    });

    return res.json({ message: "ลบ Barcode สำเร็จ" });
  },
);

/**
 * POST /api/outbounds/odoo/transfers/:no/barcode
 */
export const createOrUpdateOutboundBarcode = asyncHandler(
  async (
    req: Request<{ no: string }, {}, { outbound_barcode: string }>,
    res: Response,
  ) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;
    const { outbound_barcode } = req.body;

    if (!no) throw badRequest("กรุณาระบุเลข Transfer No");
    if (!outbound_barcode) throw badRequest("กรุณาระบุ outbound_barcode");

    const outbound = await prisma.outbound.findUnique({ where: { no } });
    if (!outbound) throw notFound(`ไม่พบ Outbound: ${no}`);
    if (outbound.deleted_at) throw badRequest("Outbound นี้ถูกลบไปแล้ว");

    if (outbound_barcode !== outbound.outbound_barcode) {
      const existing = await prisma.outbound.findUnique({
        where: { outbound_barcode },
      });
      if (existing && existing.no !== no)
        throw badRequest(`Barcode ${outbound_barcode} ถูกใช้ไปแล้ว`);
    }

    const updated = await prisma.outbound.update({
      where: { no },
      data: { outbound_barcode, updated_at: new Date() },
      include: {
        goods_outs: {
          where: { deleted_at: null },
          include: {
            barcode_ref: { where: { deleted_at: null } },
          },
          orderBy: { sequence: "asc" },
        },
      },
    });

    return res.json({
      message: "สร้าง/อัพเดท Barcode สำเร็จ",
      data: formatOdooOutbound(updated),
    });
  },
);

/**
 * GET /api/outbounds/odoo/barcode/:barcode
 */
export const getOutboundByBarcode = asyncHandler(
  async (req: Request<{ barcode: string }>, res: Response) => {
    const keyword = decodeNoParam((req.params as any).barcode).trim();
    if (!keyword) throw badRequest("กรุณาระบุ Barcode หรือ Transfer No");

    const outbound = await prisma.outbound.findFirst({
      where: {
        deleted_at: null,
        OR: [{ outbound_barcode: keyword }, { no: keyword }],
      },
      include: {
        goods_outs: {
          where: { deleted_at: null },
          include: {
            barcode_ref: { where: { deleted_at: null } },
          },
          orderBy: { sequence: "asc" },
        },
      },
    });

    if (!outbound) throw notFound(`ไม่พบ Outbound: ${keyword}`);

    const inputMap = await buildInputNumberMapFromItems(
      (outbound.goods_outs || []).map((x: any) => ({
        product_id: x.product_id,
        lot_serial: x.lot_serial,
        lot_name: x.lot_serial,
      })),
    );

    // ✅ NEW: build expMap from STOCK (match lot_serial -> stock.lot_name)
    const expMap = await buildExpirationDateMapForGoodsOutItems(
      (outbound.goods_outs || []).map((x: any) => ({
        product_id: x.product_id ?? null,
        lot_serial: x.lot_serial ?? null,
      })),
    );

    const texts = Array.from(
      new Set(
        (outbound.goods_outs || [])
          .map((x: any) => (x.barcode_text ?? "").trim())
          .filter((t: string) => t.length > 0),
      ),
    );

    const barcodeMap = new Map<
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

    if (texts.length > 0) {
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
      barcodeRows.forEach((b) => barcodeMap.set(b.barcode, b));
    }

    const formatted: any = formatOdooOutbound(outbound as any);

    const items = (outbound.goods_outs || []).map((gi: any) => {
      const t = (gi.barcode_text ?? "").trim();
      const b = t ? barcodeMap.get(t) : null;

      const exp =
        gi.product_id != null
          ? (expMap.get(expKeyOf(gi.product_id, gi.lot_serial)) ?? null)
          : null;

      return {
        id: gi.id,
        outbound_id: gi.outbound_id,
        sequence: gi.sequence,
        product_id: gi.product_id,
        code: gi.code,
        name: gi.name,
        unit: gi.unit,
        tracking: gi.tracking,
        lot_id: gi.lot_id, // keep compat
        lot_serial: gi.lot_serial,

        // ✅ NEW: expiration_date from STOCK
        exp: exp ? new Date(exp).toISOString() : null,

        qty: gi.qty,
        pick: gi.pick,
        pack: gi.pack,
        status: gi.status,
        barcode_id: gi.barcode_id,

        input_number: resolveInputNumberFromMap(
          inputMap,
          gi.product_id,
          gi.lot_serial,
        ),

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
          : gi.barcode_ref
            ? {
                barcode: gi.barcode_ref.barcode,
                lot_start: gi.barcode_ref.lot_start,
                lot_stop: gi.barcode_ref.lot_stop,
                exp_start: gi.barcode_ref.exp_start,
                exp_stop: gi.barcode_ref.exp_stop,
                barcode_length: gi.barcode_ref.barcode_length,
              }
            : null,

        boxes:
          gi.boxes
            ?.filter((ib: any) => !ib.deleted_at)
            .map((ib: any) => ({
              id: ib.box.id,
              box_code: ib.box.box_code,
              box_name: ib.box.box_name,
              quantity: ib.quantity ?? null,
            })) ?? [],
      };
    });

    return res.json({
      ...(formatted as any),
      items,
    });
  },
);

/**
 * POST /api/outbounds/:no/items
 */
export const addItemToOutbound = asyncHandler(
  async (
    req: Request<
      { no: string },
      {},
      {
        product_id: number;
        code: string;
        name: string;
        unit: string;
        tracking?: string;
        lot_id?: number;
        lot_serial?: string;
        qty: number;
        pick?: number;
        pack?: number;
        box_id?: string;
        status?: string;
      }
    >,
    res: Response,
  ) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;
    const {
      product_id,
      code,
      name,
      unit,
      tracking,
      lot_id,
      lot_serial,
      qty,
      pick,
      pack,
      box_id,
      status,
    } = req.body;

    if (!no) throw badRequest("กรุณาระบุเลข Outbound");
    if (!product_id || !code || !name || !unit || !qty)
      throw badRequest("กรุณาระบุข้อมูล product_id, code, name, unit และ qty");

    const outbound = await prisma.outbound.findUnique({
      where: { no },
      include: {
        goods_outs: {
          where: { deleted_at: null },
          orderBy: { sequence: "desc" },
          take: 1,
        },
      },
    });

    if (!outbound) throw notFound("ไม่พบ Outbound");
    if (outbound.deleted_at) throw badRequest("Outbound นี้ถูกลบไปแล้ว");

    const lastSequence =
      outbound.goods_outs.length > 0 ? outbound.goods_outs[0].sequence : 0;
    const newSequence = (lastSequence ?? 0) + 1;

    const newItem = await prisma.goods_out_item.create({
      data: {
        outbound_id: outbound.id,
        sequence: newSequence,
        product_id,
        code,
        name,
        unit,
        tracking: tracking || "none",
        lot_id: lot_id || null, // keep compat
        lot_serial: lot_serial || null,
        qty,
        sku: code,
        pick: pick || 0,
        pack: pack || 0,
        status: status || "DRAFT",
      },
      include: {
        barcode_ref: { where: { deleted_at: null } },
      },
    });

    return res.status(201).json({
      message: "เพิ่ม item สำเร็จ",
      data: {
        id: newItem.id,
        outbound_id: newItem.outbound_id,
        sequence: newItem.sequence,
        product_id: newItem.product_id,
        code: newItem.code,
        name: newItem.name,
        unit: newItem.unit,
        qty: newItem.qty,
        pick: newItem.pick,
        pack: newItem.pack,
        status: newItem.status,
        barcode_id: newItem.barcode_id,
        barcode: newItem.barcode_ref
          ? {
              barcode: newItem.barcode_ref.barcode,
              lot_start: newItem.barcode_ref.lot_start,
              lot_stop: newItem.barcode_ref.lot_stop,
              exp_start: newItem.barcode_ref.exp_start,
              exp_stop: newItem.barcode_ref.exp_stop,
              barcode_length: newItem.barcode_ref.barcode_length,
            }
          : null,
      },
    });
  },
);

/**
 * PATCH /api/outbounds/:no/items/:itemId
 * ✅ คง flow เดิมของ WMS ทั้งหมด
 * ✅ ปรับเฉพาะ payload ที่ส่งกลับ Odoo
 *    - เปลี่ยนจาก transfers/items[1]
 *    - เป็น adjusts/items[2] แบบ "คู่ lot เดิม + lot ใหม่"
 * ✅ location/location_dest อ้างจาก outbound
 * ✅ ไม่ throw ถ้า Odoo sync fail (best effort เหมือนเดิม)
 */
export const updateOutboundItem = asyncHandler(
  async (req: Request, res: Response) => {
    const no = firstStr((req.params as any).no);
    const itemId = Number((req.params as any).itemId);

    if (!no) throw badRequest("กรุณาระบุเลข Outbound");
    if (Number.isNaN(itemId)) throw badRequest("Item ID ต้องเป็นตัวเลข");

    console.log(
      "[updateOutboundItem] request body =>",
      JSON.stringify(req.body, null, 2),
    );

    const outbound = await prisma.outbound.findUnique({
      where: { no },
      select: {
        id: true,
        no: true,
        picking_id: true,
        outbound_barcode: true,
        deleted_at: true,
        origin: true,
        location_id: true,
        location: true,
        location_dest_id: true,
        location_dest: true,
      },
    });

    if (!outbound) throw notFound(`ไม่พบ Outbound: ${no}`);
    if (outbound.deleted_at) throw badRequest("Outbound นี้ถูกลบไปแล้ว");

    const item = await prisma.goods_out_item.findUnique({
      where: { id: itemId },
      include: {
        barcode_ref: { where: { deleted_at: null } },
      },
    });

    if (!item) throw notFound(`ไม่พบ Item: ${itemId}`);
    if (item.outbound_id !== outbound.id) {
      throw badRequest("Item ไม่ตรงกับ Outbound ที่ระบุ");
    }
    if (item.deleted_at) throw badRequest("Item นี้ถูกลบไปแล้ว");

    console.log(
      "[updateOutboundItem] old item =>",
      JSON.stringify(
        {
          id: item.id,
          product_id: item.product_id,
          lot_serial: item.lot_serial,
          qty: item.qty,
          barcode_text: item.barcode_text,
        },
        null,
        2,
      ),
    );

    const oldLot = item.lot_serial ?? null;
    const oldQty = Number(item.qty ?? 0);

    const newQty =
      req.body.qty !== undefined
        ? req.body.qty === null
          ? null
          : Number(req.body.qty)
        : undefined;

    if (newQty !== undefined && newQty !== null && newQty < 0) {
      throw badRequest("qty ต้องไม่ติดลบ");
    }

    const lotWasProvided =
      req.body.lot !== undefined ||
      req.body.lot_serial !== undefined ||
      req.body.lot_id !== undefined;

    let normalizedLot: string | null | undefined = undefined;

    if (lotWasProvided) {
      const lotRaw =
        req.body.lot ??
        req.body.lot_serial ??
        (req.body.lot_id != null ? String(req.body.lot_id) : null);

      normalizedLot = lotRaw === null ? null : String(lotRaw).trim() || null;
    }

    const userPackRaw =
      req.body.user_ref ?? req.body.user_pack ?? req.body.changed_by ?? null;

    const userPack =
      userPackRaw == null ? null : String(userPackRaw).trim() || null;

    const userPackWasProvided =
      req.body.user_ref !== undefined ||
      req.body.user_pack !== undefined ||
      req.body.changed_by !== undefined;

    const now = new Date();
    const data: any = { updated_at: now };

    if (lotWasProvided) data.lot_serial = normalizedLot;
    if (req.body.qty !== undefined) data.qty = newQty;
    if (req.body.pick !== undefined) data.pick = req.body.pick;
    if (req.body.pack !== undefined) data.pack = req.body.pack;
    if (req.body.status !== undefined) data.status = req.body.status;
    if (userPackWasProvided) data.user_pack = userPack;

    const packProvided = req.body.pack !== undefined;
    const statusProvided = req.body.status !== undefined;

    const packValue =
      req.body.pack !== undefined && req.body.pack !== null
        ? Number(req.body.pack)
        : null;

    const isPackingAction =
      (packProvided &&
        packValue !== null &&
        Number.isFinite(packValue) &&
        packValue > 0) ||
      (statusProvided &&
        String(req.body.status ?? "").toLowerCase() === "packed");

    if (isPackingAction) data.pack_time = now;

    const updatedItem = await prisma.goods_out_item.update({
      where: { id: itemId },
      data,
      include: {
        barcode_ref: { where: { deleted_at: null } },
      },
    });

    console.log(
      "[updateOutboundItem] updated item =>",
      JSON.stringify(
        {
          id: updatedItem.id,
          product_id: updatedItem.product_id,
          lot_serial: updatedItem.lot_serial,
          qty: updatedItem.qty,
          barcode_text: updatedItem.barcode_text,
        },
        null,
        2,
      ),
    );

    const finalLot = updatedItem.lot_serial ?? null;
    const finalQty = Number(updatedItem.qty ?? 0);

    const oldBarcodes = item.barcode_ref
      ? [
          {
            barcode_id: item.barcode_ref.id,
            barcode: item.barcode_ref.barcode,
          },
        ]
      : item.barcode_text
        ? [
            {
              barcode_id: null,
              barcode: item.barcode_text,
            },
          ]
        : [];

    const newBarcodes = updatedItem.barcode_ref
      ? [
          {
            barcode_id: updatedItem.barcode_ref.id,
            barcode: updatedItem.barcode_ref.barcode,
          },
        ]
      : updatedItem.barcode_text
        ? [
            {
              barcode_id: null,
              barcode: updatedItem.barcode_text,
            },
          ]
        : [];

    const oldItemForOdoo = {
      sequence: item.sequence ?? null,
      product_id: item.product_id ?? null,
      code: item.code ?? null,
      name: item.name ?? null,
      unit: item.unit ?? null,

      location_id: outbound.location_id ?? null,
      location: outbound.location ?? null,
      location_dest_id: outbound.location_dest_id ?? null,
      location_dest: outbound.location_dest ?? null,

      tracking: item.tracking ?? null,
      lot_id: item.lot_id ?? null,
      lot_serial: oldLot,
      qty: oldQty,
      reference: req.body.reason ?? "Adjustment lot",
      barcodes: oldBarcodes,
    };

    const newItemForOdoo = {
      sequence: updatedItem.sequence ?? null,
      product_id: updatedItem.product_id ?? null,
      code: updatedItem.code ?? null,
      name: updatedItem.name ?? null,
      unit: updatedItem.unit ?? null,

      location_id: outbound.location_id ?? null,
      location: outbound.location ?? null,
      location_dest_id: outbound.location_dest_id ?? null,
      location_dest: outbound.location_dest ?? null,

      tracking: updatedItem.tracking ?? null,
      lot_id: updatedItem.lot_id ?? null,
      lot_serial: finalLot,
      qty: finalQty,
      reference: req.body.reason ?? "Adjustment lot",
      barcodes: newBarcodes,
    };

    const odooPayload = {
      params: {
        adjusts: [
          {
            no: outbound.no,
            origin: outbound.origin ?? outbound.no,
            items: [oldItemForOdoo, newItemForOdoo],
          },
        ],
      },
      jsonrpc: "2.0",
    };

    console.log(
      "[updateOutboundItem] Odoo payload =>",
      JSON.stringify(odooPayload, null, 2),
    );

    const ODOO_BASE_URL = String(process.env.ODOO_BASE_URL ?? "").trim();
    const ODOO_OUTBOUND_UPDATE_PATH = String(
      process.env.ODOO_OUTBOUND_UPDATE_PATH ?? "",
    ).trim();
    const ODOO_API_KEY = String(process.env.ODOO_API_KEY ?? "").trim();

    // ❗ strict check
    if (!ODOO_BASE_URL) {
      throw badRequest("ODOO_BASE_URL is not set");
    }

    if (!ODOO_OUTBOUND_UPDATE_PATH) {
      throw badRequest("ODOO_OUTBOUND_UPDATE_PATH is not set");
    }

    if (!ODOO_API_KEY) {
      throw badRequest("ODOO_API_KEY is not set");
    }

    // ✅ build URL แบบปลอดภัย
    const ODOO_URL = `${ODOO_BASE_URL.replace(/\/+$/, "")}/${ODOO_OUTBOUND_UPDATE_PATH.replace(
      /^\/+/,
      "",
    )}`;

    let odooSync = {
      success: false,
      error: null as string | null,
    };

    let syncLogId: number | null = null;
    const syncStartedAt = new Date();

    try {
      const log = await prisma.adjust_lot_log.create({
        data: {
          outbound_id: outbound.id,
          goods_out_item_id: updatedItem.id,
          outbound_no: outbound.no,
          event_name: "update_item_lot",
          request_path: "/api/outbounds/:no/items/:itemId",
          odoo_url: ODOO_URL || null,
          request_body: odooPayload as any,
          success: false,
          started_at: syncStartedAt,
        },
      });
      syncLogId = log.id;
    } catch (logErr) {
      console.error("[updateOutboundItem] create sync log failed =>", logErr);
    }

    if (ODOO_URL) {
      try {
        const response = await axios.post(ODOO_URL, odooPayload, {
          timeout: 20000,
          headers: {
            "api-key": ODOO_API_KEY,
            "content-type": "application/json",
          },
        });

        odooSync.success = true;

        if (syncLogId) {
          try {
            await prisma.adjust_lot_log.update({
              where: { id: syncLogId },
              data: {
                success: true,
                response_status: response.status,
                response_body: response.data ?? null,
                error_message: null,
                completed_at: new Date(),
                updated_at: new Date(),
              },
            });
          } catch (logErr) {
            console.error(
              "[updateOutboundItem] update sync log success failed =>",
              logErr,
            );
          }
        }
      } catch (e: any) {
        odooSync.error = e instanceof Error ? e.message : String(e);

        const responseStatus =
          typeof e?.response?.status === "number" ? e.response.status : null;
        const responseBody =
          e?.response?.data !== undefined ? e.response.data : null;

        if (syncLogId) {
          try {
            await prisma.adjust_lot_log.update({
              where: { id: syncLogId },
              data: {
                success: false,
                response_status: responseStatus,
                response_body: responseBody,
                error_message: odooSync.error,
                completed_at: new Date(),
                updated_at: new Date(),
              },
            });
          } catch (logErr) {
            console.error(
              "[updateOutboundItem] update sync log error failed =>",
              logErr,
            );
          }
        }
      }
    } else {
      const noUrlError = "ODOO_URL is empty";

      odooSync.error = noUrlError;

      if (syncLogId) {
        try {
          await prisma.adjust_lot_log.update({
            where: { id: syncLogId },
            data: {
              success: false,
              response_status: null,
              response_body: Prisma.JsonNull,
              error_message: noUrlError,
              completed_at: new Date(),
              updated_at: new Date(),
            },
          });
        } catch (logErr) {
          console.error(
            "[updateOutboundItem] update sync log no-url failed =>",
            logErr,
          );
        }
      }
    }

    return res.json({
      message: "แก้ไข item สำเร็จ",
      data: updatedItem,
      odoo_sync: odooSync,
      odoo_sync_log_id: syncLogId,
    });
  },
);

export const scanOutboundItemCheckBarcode = asyncHandler(
  async (
    req: Request<{ no: string; itemId: string }, {}, { barcode: string }>,
    res: Response,
  ) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;
    const itemIdStr = Array.isArray(req.params.itemId)
      ? req.params.itemId[0]
      : req.params.itemId;

    const itemId = parseInt(itemIdStr, 10);
    const barcodeRaw = String(req.body.barcode ?? "").trim();

    if (!no) throw badRequest("กรุณาระบุเลข Outbound No");
    if (isNaN(itemId)) throw badRequest("Item ID ต้องเป็นตัวเลข");
    if (!barcodeRaw) throw badRequest("กรุณาส่ง barcode");

    const outbound = await prisma.outbound.findUnique({
      where: { no },
      select: { id: true, no: true, deleted_at: true },
    });
    if (!outbound) throw notFound(`ไม่พบ Outbound: ${no}`);
    if (outbound.deleted_at) throw badRequest("Outbound นี้ถูกลบไปแล้ว");

    const item = await prisma.goods_out_item.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        outbound_id: true,
        deleted_at: true,
        barcode_id: true,
        barcode_text: true,
        lot_serial: true,
        product_id: true,
      },
    });

    if (!item) throw notFound(`ไม่พบ Item: ${itemId}`);
    if (item.outbound_id !== outbound.id) {
      throw badRequest("Item ไม่ตรงกับ Outbound ที่ระบุ");
    }
    if (item.deleted_at) throw badRequest("Item นี้ถูกลบไปแล้ว");

    let masterBarcode: {
      id: number;
      barcode: string;
      lot_start: number | null;
      lot_stop: number | null;
      exp_start: number | null;
      exp_stop: number | null;
      barcode_length: number | null;
    } | null = null;

    if (item.barcode_id) {
      masterBarcode = await prisma.barcode.findUnique({
        where: { id: item.barcode_id },
        select: {
          id: true,
          barcode: true,
          lot_start: true,
          lot_stop: true,
          exp_start: true,
          exp_stop: true,
          barcode_length: true,
        },
      });
    }

    const parsed = await resolveBarcodeScan(barcodeRaw);

    const expectedBarcodeText = String(
      masterBarcode?.barcode ?? item.barcode_text ?? "",
    ).trim();

    const parsedBarcodeText = String(parsed.barcode_text ?? "").trim();

    const barcodeMatched =
      !!expectedBarcodeText &&
      normalizeScanText(parsedBarcodeText) ===
        normalizeScanText(expectedBarcodeText);

    const lotMatched = lotMatchedNullable(item.lot_serial, parsed.lot_serial);

    const normalized_scan = `${parsed.barcode_text ?? ""}${parsed.lot_serial ?? ""}${parsed.exp_text ?? ""}`;

    return res.json({
      message: "แปลง barcode สำเร็จ",
      data: {
        raw_input: parsed.raw_input,
        normalized_input: parsed.normalized_input,
        barcode_text: parsed.barcode_text,
        lot_serial: parsed.lot_serial,
        exp_text: parsed.exp_text,
        exp: parsed.exp ? parsed.exp.toISOString() : null,
        normalized_scan,
        matched_by: parsed.matched_by,
        matched: barcodeMatched && lotMatched,
        checks: {
          barcode_matched: barcodeMatched,
          lot_matched: lotMatched,
        },
        item: {
          id: item.id,
          barcode_id: item.barcode_id,
          barcode_text: item.barcode_text,
          lot_serial: item.lot_serial,
          exp: null,
        },
        barcode_meta: masterBarcode
          ? {
              id: masterBarcode.id,
              barcode: masterBarcode.barcode,
              lot_start: masterBarcode.lot_start,
              lot_stop: masterBarcode.lot_stop,
              exp_start: masterBarcode.exp_start,
              exp_stop: masterBarcode.exp_stop,
              barcode_length: masterBarcode.barcode_length,
            }
          : null,
      },
    });
  },
);

export const createOutboundLotAdjustment = asyncHandler(
  async (req: Request, res: Response) => {
    const no = firstStr((req.params as any).no);
    const itemId = Number((req.params as any).itemId);

    if (!no) throw badRequest("กรุณาระบุเลข Outbound");
    if (Number.isNaN(itemId)) throw badRequest("Item ID ต้องเป็นตัวเลข");

    const lines: RawLotAdjustmentLine[] = Array.isArray(req.body?.lines)
      ? (req.body.lines as RawLotAdjustmentLine[])
      : [];

    if (lines.length === 0) throw badRequest("กรุณาระบุ lines");

    const reason = firstStr(req.body?.reason) || "Partial lot adjustment";
    const userRef =
      firstStr(req.body?.user_ref) ||
      firstStr(req.body?.user_pack) ||
      firstStr(req.body?.changed_by) ||
      null;

    const outbound = await prisma.outbound.findUnique({
      where: { no },
      select: {
        id: true,
        no: true,
        picking_id: true,
        origin: true,
        deleted_at: true,
        location_id: true,
        location: true,
        location_dest_id: true,
        location_dest: true,
      },
    });

    if (!outbound) throw notFound(`ไม่พบ Outbound: ${no}`);
    if (outbound.deleted_at) throw badRequest("Outbound นี้ถูกลบไปแล้ว");

    const item = await prisma.goods_out_item.findFirst({
      where: {
        id: itemId,
        outbound_id: outbound.id,
        deleted_at: null,
      },
      select: {
        id: true,
        outbound_id: true,
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
        barcode_text: true,
        source_item_id: true,
        lot_adjustment_id: true,
        is_split_generated: true,
        updated_at: true,
        deleted_at: true,
      },
    });

    if (!item) {
      throw notFound(`ไม่พบ goods_out_item: ${itemId}`);
    }

    const currentQty = Math.max(0, Math.floor(Number(item.qty ?? 0)));
    const currentPack = Math.max(0, Math.floor(Number(item.pack ?? 0)));

    if (currentPack > 0) {
      throw badRequest("มีการ pack แล้ว ห้ามเปลี่ยน lot");
    }

    const siblingRows = await prisma.goods_out_item.findMany({
      where: {
        outbound_id: outbound.id,
        deleted_at: null,
        product_id: item.product_id,
      },
      select: {
        id: true,
        lot_id: true,
        lot_serial: true,
      },
    });

    const rawNormalizedLines = lines.map((line) => {
      const rawLotId =
        line.lot_id == null || line.lot_id === "" ? null : Number(line.lot_id);

      if (line.lot_id != null && line.lot_id !== "" && Number.isNaN(rawLotId)) {
        throw badRequest("lot_id ต้องเป็นตัวเลข");
      }

      const lot_serial = firstStr(line.lot_serial) || null;
      const qty = Math.max(0, Math.floor(Number(line.qty ?? 0)));

      const matchedSibling =
        siblingRows.find((row) =>
          sameLotSerialForMatch(row.lot_serial, lot_serial),
        ) ?? null;

      return {
        lot_id: rawLotId ?? matchedSibling?.lot_id ?? null,
        lot_serial,
        qty,
      };
    });

    const normalizedLines: NormalizedLotAdjustmentLine[] =
      await enrichLotLinesWithResolvedLotId({
        product_id: item.product_id,
        lines: rawNormalizedLines,
      });

    if (normalizedLines.length === 0) {
      throw badRequest("กรุณาระบุ lines");
    }

    const totalQty = normalizedLines.reduce(
      (sum, line) => sum + Math.max(0, Number(line.qty ?? 0)),
      0,
    );

    if (totalQty !== currentQty) {
      throw badRequest(
        `ผลรวม qty ใหม่ (${totalQty}) ต้องเท่ากับ qty เดิม (${currentQty})`,
      );
    }

    const duplicateCheckSet = new Set<string>();
    for (const line of normalizedLines) {
      const dupKey = [
        item.product_id ?? "null",
        normalizeLotSerialForMatch(line.lot_serial),
      ].join("|");

      if (duplicateCheckSet.has(dupKey)) {
        throw badRequest(
          `พบ lot ซ้ำใน payload (${line.lot_serial ?? "null"}) กรุณารวม qty มาก่อนส่ง`,
        );
      }
      duplicateCheckSet.add(dupKey);
    }

    const newSignature = buildLotAdjustmentSignature(normalizedLines);

    const originalLineIndex = normalizedLines.findIndex((line) =>
      sameLotSerialForMatch(line.lot_serial, item.lot_serial),
    );

    const originalLine =
      originalLineIndex >= 0 ? normalizedLines[originalLineIndex] : null;

    const result = await prisma.$transaction(async (tx) => {
      const now = new Date();

      const pendingSameItem = await tx.outbound_lot_adjustment.findMany({
        where: {
          outbound_id: outbound.id,
          goods_out_item_id: item.id,
          status: "pending",
          deleted_at: null,
        },
        select: {
          id: true,
          queue_no: true,
          outbound_id: true,
          goods_out_item_id: true,
          status: true,
          original_lot_serial: true,
          original_lot_id: true,
          original_qty: true,
          created_at: true,
          lines: {
            where: { deleted_at: null },
            select: {
              lot_id: true,
              lot_serial: true,
              qty: true,
            },
            orderBy: { id: "asc" },
          },
        },
        orderBy: [{ queue_no: "asc" }, { id: "asc" }],
      });

      const duplicatedPending =
        pendingSameItem.find((adj) => {
          const oldSignature = buildLotAdjustmentSignature(adj.lines);
          return oldSignature === newSignature;
        }) ?? null;

      if (duplicatedPending) {
        const adjustment = await tx.outbound_lot_adjustment.update({
          where: { id: duplicatedPending.id },
          data: {
            reason,
            status: "pending",
            updated_by: userRef,
            updated_at: now,
            sent_at: null,
            send_error: null,
          } as any,
          select: {
            id: true,
            outbound_id: true,
            goods_out_item_id: true,
            status: true,
            original_lot_serial: true,
            original_lot_id: true,
            original_qty: true,
            queue_no: true,
            created_at: true,
          },
        });

        const linkedLines = await tx.outbound_lot_adjustment_line.findMany({
          where: {
            adjustment_id: adjustment.id,
            deleted_at: null,
          },
          select: {
            id: true,
            lot_id: true,
            lot_serial: true,
            qty: true,
            is_original_lot: true,
            goods_out_item_id: true,
          },
          orderBy: { id: "asc" },
        });

        return {
          mode: "update_existing_pending" as const,
          adjustment,
          updatedRootItem: item,
          affectedChildItems: [],
          linkedLines,
        };
      }

      const adjustment = await tx.outbound_lot_adjustment.create({
        data: {
          outbound_id: outbound.id,
          goods_out_item_id: item.id,
          reason,
          status: "pending",
          created_by: userRef,
          updated_by: userRef,
          original_lot_serial: item.lot_serial,
          original_lot_id: item.lot_id,
          original_qty: currentQty,
        },
        select: {
          id: true,
          outbound_id: true,
          goods_out_item_id: true,
          status: true,
          original_lot_serial: true,
          original_lot_id: true,
          original_qty: true,
          queue_no: true,
          created_at: true,
        },
      });

      const createdAdjustmentLines =
        await tx.outbound_lot_adjustment_line.createManyAndReturn({
          data: normalizedLines.map((line) => ({
            adjustment_id: adjustment.id,
            lot_id: line.lot_id,
            lot_serial: line.lot_serial,
            qty: line.qty,
            pick: 0,
            is_original_lot: sameLotSerialForMatch(
              line.lot_serial,
              item.lot_serial,
            ),
          })),
          select: {
            id: true,
            adjustment_id: true,
            lot_id: true,
            lot_serial: true,
            qty: true,
            pick: true,
            is_original_lot: true,
            goods_out_item_id: true,
          },
        });

      const getAdjustmentLineByIndex = (index: number) =>
        createdAdjustmentLines[index] ?? null;

      let updatedRootItem: GoodsOutItemRowForAdjustment & {
        deleted_at?: Date | null;
      };
      let rootSourceLineIndex = -1;

      if (originalLine && originalLine.qty > 0) {
        updatedRootItem = await tx.goods_out_item.update({
          where: { id: item.id },
          data: {
            lot_id: originalLine.lot_id,
            lot_serial: originalLine.lot_serial,
            qty: originalLine.qty,
            lot_adjustment_id: adjustment.id,
            updated_at: now,
          },
          select: {
            id: true,
            outbound_id: true,
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
            barcode_text: true,
            source_item_id: true,
            lot_adjustment_id: true,
            is_split_generated: true,
            updated_at: true,
            deleted_at: true,
          },
        });

        rootSourceLineIndex = originalLineIndex;
      } else {
        updatedRootItem = await tx.goods_out_item.update({
          where: { id: item.id },
          data: {
            qty: 0,
            lot_adjustment_id: adjustment.id,
            deleted_at: now,
            updated_at: now,
          },
          select: {
            id: true,
            outbound_id: true,
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
            barcode_text: true,
            source_item_id: true,
            lot_adjustment_id: true,
            is_split_generated: true,
            updated_at: true,
            deleted_at: true,
          },
        });

        rootSourceLineIndex = -1;
      }

      const rootAdjustmentLine =
        rootSourceLineIndex >= 0
          ? getAdjustmentLineByIndex(rootSourceLineIndex)
          : null;

      if (rootAdjustmentLine) {
        await tx.outbound_lot_adjustment_line.update({
          where: { id: rootAdjustmentLine.id },
          data: {
            goods_out_item_id: updatedRootItem.id,
            updated_at: now,
          },
        });
      }

      const affectedChildItems: Array<
        GoodsOutItemRowForAdjustment & { deleted_at?: Date | null }
      > = [];

      const childLineEntries = normalizedLines
        .map((line, index) => ({ line, index }))
        .filter(
          ({ index, line }) => index !== rootSourceLineIndex && line.qty > 0,
        );

      for (const { line, index } of childLineEntries) {
        const candidateRows = await tx.goods_out_item.findMany({
          where: {
            outbound_id: item.outbound_id,
            deleted_at: null,
            id: { not: item.id },
            product_id: item.product_id,
          },
          select: {
            id: true,
            outbound_id: true,
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
            barcode_text: true,
            source_item_id: true,
            lot_adjustment_id: true,
            is_split_generated: true,
            updated_at: true,
            deleted_at: true,
          },
          orderBy: [{ id: "asc" }],
        });

        const existingSameLot =
          candidateRows.find((row) => {
            const lotIdMatched =
              line.lot_id != null &&
              row.lot_id != null &&
              Number(line.lot_id) === Number(row.lot_id);

            const lotSerialMatched = sameLotSerialForMatch(
              row.lot_serial,
              line.lot_serial,
            );

            return lotIdMatched || lotSerialMatched;
          }) ?? null;

        let linkedItem: GoodsOutItemRowForAdjustment & {
          deleted_at?: Date | null;
        };

        if (existingSameLot) {
          linkedItem = await tx.goods_out_item.update({
            where: { id: existingSameLot.id },
            data: {
              qty: { increment: line.qty },
              lot_id:
                existingSameLot.lot_id == null
                  ? line.lot_id
                  : existingSameLot.lot_id,
              lot_serial:
                firstStr(existingSameLot.lot_serial) || line.lot_serial,
              updated_at: now,
            },
            select: {
              id: true,
              outbound_id: true,
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
              barcode_text: true,
              source_item_id: true,
              lot_adjustment_id: true,
              is_split_generated: true,
              updated_at: true,
              deleted_at: true,
            },
          });
        } else {
          linkedItem = await tx.goods_out_item.create({
            data: {
              outbound_id: item.outbound_id,
              sequence: item.sequence,
              product_id: item.product_id,
              code: item.code,
              name: item.name,
              unit: item.unit,
              tracking: item.tracking,
              lot_id: line.lot_id,
              lot_serial: line.lot_serial,
              qty: line.qty,
              pick: 0,
              pack: 0,
              status: item.status,
              barcode_text: item.barcode_text,
              source_item_id: item.id,
              lot_adjustment_id: adjustment.id,
              is_split_generated: true,
              user_pack: userRef,
              updated_at: now,
            },
            select: {
              id: true,
              outbound_id: true,
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
              barcode_text: true,
              source_item_id: true,
              lot_adjustment_id: true,
              is_split_generated: true,
              updated_at: true,
              deleted_at: true,
            },
          });
        }

        const childAdjustmentLine = getAdjustmentLineByIndex(index);

        if (childAdjustmentLine) {
          await tx.outbound_lot_adjustment_line.update({
            where: { id: childAdjustmentLine.id },
            data: {
              goods_out_item_id: linkedItem.id,
              updated_at: now,
            },
          });
        }

        affectedChildItems.push(linkedItem);
      }

      const linkedLines = await tx.outbound_lot_adjustment_line.findMany({
        where: { adjustment_id: adjustment.id },
        select: {
          id: true,
          lot_id: true,
          lot_serial: true,
          qty: true,
          is_original_lot: true,
          goods_out_item_id: true,
        },
        orderBy: { id: "asc" },
      });

      return {
        mode: "create_new_pending" as const,
        adjustment,
        updatedRootItem,
        affectedChildItems,
        linkedLines,
      };
    });

    const allActiveItems = await prisma.goods_out_item.findMany({
      where: {
        outbound_id: outbound.id,
        deleted_at: null,
      },
      select: {
        id: true,
        outbound_id: true,
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
        barcode_text: true,
        source_item_id: true,
        lot_adjustment_id: true,
        is_split_generated: true,
        updated_at: true,
        deleted_at: true,
      },
      orderBy: [{ sequence: "asc" }, { id: "asc" }],
    });

    const itemsForResponse = allActiveItems.filter(
      (row) => Math.max(0, Math.floor(Number(row.qty ?? 0))) > 0,
    );

    let queuedFragment: any = null;

    if (outbound.picking_id) {
      const itemsForOdoo = buildOdooItemsForSingleAdjustment({
        item: {
          code: item.code,
          name: item.name,
          unit: item.unit,
          product_id: item.product_id,
          tracking: item.tracking,
          sequence: item.sequence,
          barcode_text: item.barcode_text,
          lot_id: item.lot_id,
          lot_serial: item.lot_serial,
          qty: item.qty,
        },
        outbound: {
          location: outbound.location,
          location_id: outbound.location_id,
          location_dest: outbound.location_dest,
          location_dest_id: outbound.location_dest_id,
        },
        reference: reason,
        linkedLines: result.linkedLines,
      });

      const totalOdooQty = itemsForOdoo.reduce(
        (sum: number, row: any) =>
          sum + Math.max(0, Math.floor(Number(row.qty ?? 0))),
        0,
      );

      if (totalOdooQty !== currentQty) {
        throw badRequest(
          `Odoo payload qty ไม่ตรงกับ qty เดิมของ item (${totalOdooQty}/${currentQty})`,
        );
      }

      queuedFragment = buildQueuedOdooFragment({
        outbound,
        reason,
        itemsForOdoo,
      });

      let nextQueueNo = result.adjustment.queue_no;

      if (!nextQueueNo) {
        const maxQueue = await prisma.outbound_lot_adjustment.aggregate({
          where: {
            outbound_id: outbound.id,
            deleted_at: null,
          },
          _max: {
            queue_no: true,
          },
        });

        nextQueueNo = Number(maxQueue._max.queue_no ?? 0) + 1;
      }

      await prisma.outbound_lot_adjustment.update({
        where: { id: result.adjustment.id },
        data: {
          status: "pending",
          queue_no: nextQueueNo,
          odoo_payload_fragment: queuedFragment,
          sent_at: null,
          send_error: null,
          updated_by: userRef,
        } as any,
      });
    }

    return res.status(201).json({
      message:
        result.mode === "update_existing_pending"
          ? "อัปเดต outbound lot adjustment pending เดิมสำเร็จ"
          : "สร้าง outbound lot adjustment สำเร็จ",
      data: {
        mode: result.mode,
        adjustment: {
          ...result.adjustment,
          status: outbound.picking_id ? "pending" : result.adjustment.status,
        },
        items: itemsForResponse,
        linked_lines: result.linkedLines,
        adjust_lot_log_id: null,
        odoo_payload: queuedFragment,
        odoo: {
          success: false,
          queued: !!queuedFragment,
          sent: false,
          response: null,
          error: outbound.picking_id
            ? {
                message:
                  result.mode === "update_existing_pending"
                    ? "อัปเดต Queue payload เดิมแล้ว รอส่งตอน confirm pick"
                    : "Queue payload ไว้แล้ว รอส่งตอน confirm pick",
              }
            : {
                message: "Skip queue เพราะ outbound ไม่มี picking_id",
              },
        },
      },
    });
  },
);

export const revertOutboundLotAdjustment = asyncHandler(
  async (req: Request, res: Response) => {
    const no = firstStr((req.params as any).no);
    const itemId = Number((req.params as any).itemId);
    const adjustmentId = Number((req.params as any).adjustmentId);

    if (!no) throw badRequest("กรุณาระบุเลข Outbound");
    if (Number.isNaN(itemId)) throw badRequest("Item ID ต้องเป็นตัวเลข");
    if (Number.isNaN(adjustmentId)) {
      throw badRequest("Adjustment ID ต้องเป็นตัวเลข");
    }

    const outbound = await prisma.outbound.findUnique({
      where: { no },
      select: {
        id: true,
        no: true,
        picking_id: true,
        origin: true,
        deleted_at: true,
        location_id: true,
        location: true,
        location_dest_id: true,
        location_dest: true,
      },
    });

    if (!outbound) throw notFound(`ไม่พบ Outbound: ${no}`);
    if (outbound.deleted_at) throw badRequest("Outbound นี้ถูกลบไปแล้ว");
    if (outbound.picking_id == null) {
      throw badRequest(`Outbound ${outbound.no} ไม่มี picking_id`);
    }

    const requestItem = await prisma.goods_out_item.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        outbound_id: true,
        source_item_id: true,
        lot_adjustment_id: true,
        is_split_generated: true,
        sequence: true,
        product_id: true,
        code: true,
        name: true,
        unit: true,
        tracking: true,
        lot_id: true,
        lot_serial: true,
        qty: true,
        barcode_text: true,
        barcode_ref: true,
      },
    });

    if (!requestItem) throw notFound(`ไม่พบ Item: ${itemId}`);
    if (requestItem.outbound_id !== outbound.id) {
      throw badRequest("Item ไม่ตรงกับ Outbound ที่ระบุ");
    }

    const adjustment = await prisma.outbound_lot_adjustment.findFirst({
      where: {
        id: adjustmentId,
        outbound_id: outbound.id,
        status: "active",
        deleted_at: null,
      },
      select: {
        id: true,
        goods_out_item_id: true,
        original_lot_id: true,
        original_lot_serial: true,
        original_qty: true,
      },
    });

    if (!adjustment) {
      throw notFound("ไม่พบ adjustment ที่ active");
    }

    const rootItem = await prisma.goods_out_item.findUnique({
      where: { id: adjustment.goods_out_item_id },
      select: {
        id: true,
        outbound_id: true,
        sequence: true,
        product_id: true,
        code: true,
        name: true,
        unit: true,
        tracking: true,
        lot_id: true,
        lot_serial: true,
        qty: true,
        lot_adjustment_id: true,
        barcode_text: true,
        barcode_ref: true,
      },
    });

    if (!rootItem) {
      throw notFound(`ไม่พบ root item ของ adjustment: ${adjustment.id}`);
    }

    const childItems = await prisma.goods_out_item.findMany({
      where: {
        source_item_id: rootItem.id,
        lot_adjustment_id: adjustment.id,
        is_split_generated: true,
        deleted_at: null,
      },
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
        barcode_text: true,
        barcode_ref: true,
      },
      orderBy: { id: "asc" },
    });

    const now = new Date();

    const txResult = await prisma.$transaction(async (tx) => {
      const deletedChildren = await tx.goods_out_item.updateMany({
        where: {
          source_item_id: rootItem.id,
          lot_adjustment_id: adjustment.id,
          is_split_generated: true,
          deleted_at: null,
        },
        data: {
          deleted_at: now,
          updated_at: now,
        },
      });

      const restoredRoot = await tx.goods_out_item.update({
        where: { id: rootItem.id },
        data: {
          lot_id: adjustment.original_lot_id,
          lot_serial: adjustment.original_lot_serial,
          qty: adjustment.original_qty,
          lot_adjustment_id: null,
          updated_at: now,
        },
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
          lot_adjustment_id: true,
          barcode_text: true,
          updated_at: true,
        },
      });

      await tx.outbound_lot_adjustment.update({
        where: { id: adjustment.id },
        data: {
          status: "reverted",
          updated_at: now,
        },
      });

      await tx.outbound_lot_adjustment_line.updateMany({
        where: {
          adjustment_id: adjustment.id,
        },
        data: {
          updated_at: now,
        },
      });

      return {
        deletedChildrenCount: deletedChildren.count,
        restoredRoot,
      };
    });

    const restoredBarcodes = txResult.restoredRoot.barcode_text
      ? [{ barcode_id: null, barcode: txResult.restoredRoot.barcode_text }]
      : [];

    // ✅ revert แล้วส่งกลับ Odoo เฉพาะสถานะล่าสุดหลัง revert = item เดิม 1 รายการ
    const restoredItemForOdoo = {
      sequence: txResult.restoredRoot.sequence ?? null,
      product_id: txResult.restoredRoot.product_id ?? null,
      code: txResult.restoredRoot.code ?? null,
      name: txResult.restoredRoot.name ?? null,
      unit: txResult.restoredRoot.unit ?? null,

      location_id: outbound.location_id ?? null,
      location: outbound.location ?? null,
      location_dest_id: outbound.location_dest_id ?? null,
      location_dest: outbound.location_dest ?? null,

      tracking: txResult.restoredRoot.tracking ?? null,
      lot_id: txResult.restoredRoot.lot_id ?? null,
      lot_serial: txResult.restoredRoot.lot_serial ?? null,
      qty: Number(txResult.restoredRoot.qty ?? 0),
      reference: "Revert lot adjustment",
      barcodes: restoredBarcodes,
    };

    const odooPayload = {
      params: {
        adjusts: [
          {
            no: outbound.no,
            picking_id: outbound.picking_id,
            origin: outbound.origin ?? outbound.no,
            items: [restoredItemForOdoo],
          },
        ],
      },
      jsonrpc: "2.0",
    };

    console.log(
      "[revertOutboundLotAdjustment] result =>",
      JSON.stringify(
        {
          deletedChildrenCount: txResult.deletedChildrenCount,
          restoredRoot: txResult.restoredRoot,
          removedChildIds: childItems.map((x) => x.id),
        },
        null,
        2,
      ),
    );

    console.log(
      "[revertOutboundLotAdjustment] Odoo payload =>",
      JSON.stringify(odooPayload, null, 2),
    );

    return res.json({
      message: "revert lot adjustment สำเร็จ",
      data: {
        adjustment_id: adjustment.id,
        root_item_id: rootItem.id,
        deleted_children_count: txResult.deletedChildrenCount,
        deleted_child_item_ids: childItems.map((x) => x.id),
        restored_root: txResult.restoredRoot,
      },
      odoo_payload: odooPayload,
    });
  },
);

/**
 * GET /api/outbounds/:no/items/:itemId
 */
export const getOutboundItem = asyncHandler(
  async (req: Request<{ no: string; itemId: string }>, res: Response) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;
    const itemIdStr = Array.isArray(req.params.itemId)
      ? req.params.itemId[0]
      : req.params.itemId;
    const itemId = parseInt(itemIdStr, 10);

    if (!no) throw badRequest("กรุณาระบุเลข Outbound");
    if (isNaN(itemId)) throw badRequest("Item ID ต้องเป็นตัวเลข");

    const outbound = await prisma.outbound.findUnique({ where: { no } });
    if (!outbound) throw notFound(`ไม่พบ Outbound: ${no}`);
    if (outbound.deleted_at) throw badRequest("Outbound นี้ถูกลบไปแล้ว");

    const item = await prisma.goods_out_item.findUnique({
      where: { id: itemId },
      include: {
        barcode_ref: { where: { deleted_at: null } },
        outbound: {
          select: { id: true, no: true, outbound_barcode: true, invoice: true },
        },
      },
    });

    if (!item) throw notFound(`ไม่พบ Item: ${itemId}`);
    if (item.outbound_id !== outbound.id)
      throw badRequest("Item ไม่ตรงกับ Outbound ที่ระบุ");
    if (item.deleted_at) throw badRequest("Item นี้ถูกลบไปแล้ว");

    const inputMap = await buildInputNumberMapFromItems([
      {
        product_id: item.product_id,
        lot_serial: item.lot_serial,
        lot_name: item.lot_serial,
      },
    ]);

    const input_number = resolveInputNumberFromMap(
      inputMap,
      item.product_id,
      item.lot_serial,
    );

    return res.json({
      id: item.id,
      outbound_id: item.outbound_id,
      outbound_no: item.outbound.no,
      invoice: item.outbound.invoice ?? null,
      outbound_barcode: item.outbound.outbound_barcode ?? null, // (แนะนำเพิ่มแยกไว้ชัดๆ)
      sequence: item.sequence,
      product_id: item.product_id,
      code: item.code,
      sku: item.sku,
      name: item.name,
      unit: item.unit,
      lot_id: item.lot_id,
      lot_serial: item.lot_serial,
      qty: item.qty,
      pick: item.pick,
      pack: item.pack,
      status: item.status,
      input_number,
      barcode_text: item.barcode_text ?? null,
      barcode_id: item.barcode_id,
      barcode: item.barcode_ref
        ? {
            barcode: item.barcode_ref.barcode,
            lot_start: item.barcode_ref.lot_start,
            lot_stop: item.barcode_ref.lot_stop,
            exp_start: item.barcode_ref.exp_start,
            exp_stop: item.barcode_ref.exp_stop,
            barcode_length: item.barcode_ref.barcode_length,
          }
        : null,
    });
  },
);

/**
 * GET /api/outbounds/search?product_id=123
 * GET /api/outbounds/search?code=PROD-123
 */
export const searchOutboundsByItem = asyncHandler(
  async (
    req: Request<{}, {}, {}, { product_id?: string; code?: string }>,
    res: Response,
  ) => {
    const { product_id, code } = req.query;

    console.log("✅ searchOutboundsByItem called", req.query);

    if (!product_id && !code) {
      throw badRequest("กรุณาระบุ product_id หรือ code");
    }

    const parsedProductId = product_id ? parseInt(product_id, 10) : undefined;

    const goodsOutWhere: any = {
      deleted_at: null,
      ...(parsedProductId ? { product_id: parsedProductId } : {}),
      ...(code ? { code } : {}),
    };

    const batches = await prisma.batch_outbound.findMany({
      where: {
        outbound: {
          deleted_at: null,
          goods_outs: {
            some: goodsOutWhere,
          },
        },
      },
      include: {
        outbound: {
          include: {
            goods_outs: {
              where: goodsOutWhere,
              include: {
                barcode_ref: { where: { deleted_at: null } },
              },
              orderBy: { sequence: "asc" },
            },
          },
        },
        user: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            username: true,
          },
        },
      },
      orderBy: { created_at: "desc" },
    });

    const data = await Promise.all(
      batches.map(async (batch) => {
        const formatted: any = formatOdooOutbound(batch.outbound as any);

        const inputMap = await buildInputNumberMapFromItems(
          (formatted.items || []).map((it: any) => ({
            product_id: it.product_id,
            lot_serial: it.lot_serial,
            lot_name: it.lot_serial,
          })),
        );

        formatted.items = (formatted.items || []).map((it: any) => ({
          ...it,
          input_number: resolveInputNumberFromMap(
            inputMap,
            it.product_id,
            it.lot_serial,
          ),
        }));

        formatted.batch_outbound = {
          id: batch.id,
          name: batch.name,
          status: batch.status,
          remark: batch.remark,
          created_at: batch.created_at,
          updated_at: batch.updated_at,
          released_at: batch.released_at,
          user: batch.user,
        };

        return formatted;
      }),
    );

    res.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate",
    );
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");

    return res.json({
      total: data.length,
      search_criteria: { product_id, code },
      data,
    });
  },
);

/**
 * GET /api/outbounds/packed-items
 */
export const getPackedOutboundItems = asyncHandler(
  async (req: Request, res: Response) => {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const wherePacked = {
      pack: { not: 0 },
      boxes: { some: { deleted_at: null } },
      deleted_at: null,
    } as const;

    const [items, total] = await Promise.all([
      prisma.goods_out_item.findMany({
        where: wherePacked,
        include: {
          outbound: {
            select: {
              no: true,
              date: true,
              out_type: true,
              department: true,
              invoice: true,
            },
          },
        },
        orderBy: [{ outbound: { date: "desc" } }, { sequence: "asc" }],
        skip,
        take: limit,
      }),
      prisma.goods_out_item.count({ where: wherePacked }),
    ]);

    const inputMap = await buildInputNumberMapFromItems(
      items.map((it: any) => ({
        product_id: it.product_id,
        lot_serial: it.lot_serial,
        lot_name: it.lot_serial,
      })),
    );

    const formattedItems = items.map((item: any, index: number) => {
      const boxText =
        item.boxes
          ?.map((b: any) => b.box?.box_code || b.box?.box_name)
          .filter(Boolean)
          .join(", ") || "-";

      return {
        no: skip + index + 1,
        outbound_no: item.outbound?.no ?? null,
        out_type: item.outbound?.out_type ?? null,
        department: item.outbound?.department ?? null,
        date: item.outbound?.date ?? null,
        box: boxText,

        input_number: resolveInputNumberFromMap(
          inputMap,
          item.product_id,
          item.lot_serial,
        ),

        sequence: item.sequence ?? null,
        product_id: item.product_id ?? null,
        code: item.code ?? null,
        name: item.name ?? null,
        unit: item.unit ?? null,
        tracking: item.tracking ?? null,
        lot_id: item.lot_id ?? null,
        lot_serial: item.lot_serial ?? null,
        qty: item.qty ?? null,
        sku: item.sku ?? null,
        lock_no: item.lock_no ?? null,
        lock_name: item.lock_name ?? null,
        barcode: item.barcode ?? null,
        created_at: item.created_at ?? null,
        updated_at: item.updated_at ?? null,
        deleted_at: item.deleted_at ?? null,
        barcode_id: item.barcode_id ?? null,
        outbound_id: item.outbound_id ?? null,
        id: item.id ?? null,
        pack: item.pack ?? 0,
        pick: item.pick ?? 0,
        status: item.status ?? null,
        confirmed_pick: item.confirmed_pick ?? 0,
        barcode_text: item.barcode_text ?? null,

        qty_required: item.qty ?? 0,
        qty_packed: item.pack ?? 0,
        item_id: item.id,

        boxes:
          item.boxes?.map((ib: any) => ({
            id: ib.box?.id ?? null,
            box_code: ib.box?.box_code ?? null,
            box_name: ib.box?.box_name ?? null,
            quantity: ib.quantity ?? null,
          })) ?? [],
      };
    });

    return res.json({
      data: formattedItems,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  },
);

type UpdateGoodsOutItemRtcBody = {
  rtc: number;
};

export const updateGoodsOutItemRtc = asyncHandler(
  async (
    req: Request<{ id: string }, {}, UpdateGoodsOutItemRtcBody>,
    res: Response,
  ) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      throw badRequest("id ต้องเป็นตัวเลขจำนวนเต็มบวก");
    }

    const rtc = pickPositiveInt(req.body?.rtc, "rtc");

    const result = await prisma.$transaction(async (tx) => {
      const row = await tx.goods_out_item.findUnique({
        where: { id },
        select: {
          id: true,
          outbound_id: true,
          qty: true,
          rtc: true,
          deleted_at: true,
          outbound: {
            select: {
              id: true,
              no: true,
            },
          },
        },
      });

      if (!row || row.deleted_at) {
        throw notFound(`ไม่พบ goods_out_item: ${id}`);
      }

      const currentQty = Math.max(0, Math.floor(Number(row.qty ?? 0)));
      const currentRtc = Math.max(0, Math.floor(Number(row.rtc ?? 0)));

      // rtc ที่ส่งมาเป็น "ค่าที่จะใช้แทนทั้งหมด"
      // qty ใหม่ = qty เดิม + rtc เดิม - rtc ใหม่
      const restoredQty = currentQty + currentRtc;
      const nextQty = restoredQty - rtc;

      if (nextQty < 0) {
        throw badRequest(
          `rtc มากกว่าจำนวนที่มีอยู่ได้ (restored_qty=${restoredQty}, rtc=${rtc})`,
        );
      }

      const updated = await tx.goods_out_item.update({
        where: { id: row.id },
        data: {
          rtc,
          qty: nextQty,
          updated_at: new Date(),
        },
        select: {
          id: true,
          outbound_id: true,
          qty: true,
          rtc: true,
          updated_at: true,
        },
      });

      return {
        ...updated,
        outbound_no: row.outbound?.no ?? null,
      };
    });

    const payload = {
      source: "goods_out_item_rtc_update",
      goods_out_item_id: result.id,
      outbound_id: result.outbound_id,
      outbound_no: result.outbound_no,
      data: result,
    };

    try {
      if (result.outbound_no) {
        io.to(`outbound:${result.outbound_no}`).emit(
          "outbound:item_rtc_updated",
          payload,
        );
      }

      io.to(`outbound-id:${result.outbound_id}`).emit(
        "outbound:item_rtc_updated",
        payload,
      );

      io.emit("outbound:item_rtc_updated", payload);
    } catch {}

    return res.json({
      message: "อัปเดต rtc สำเร็จ",
      data: result,
    });
  },
);

const buildProductLotKey = (productId?: number | null, lotId?: number | null) =>
  `${productId ?? "NULL"}|${lotId ?? "NULL"}`;

// ============================================================
// GET CANDIDATES
// ============================================================

export const getAutoLocationPackCandidates = asyncHandler(
  async (req: Request, res: Response) => {
    const outboundNos = Array.isArray(req.body?.outbound_nos)
      ? req.body.outbound_nos
          .map((x: any) => String(x ?? "").trim())
          .filter(Boolean)
      : [];

    if (outboundNos.length === 0) {
      throw badRequest("ไม่พบ outbound_nos");
    }

    const outbounds = await prisma.outbound.findMany({
      where: {
        no: {
          in: outboundNos,
        },
        deleted_at: null,
      },

      include: {
        goods_outs: {
          where: {
            deleted_at: null,
          },
        },
      },
    });

    if (outbounds.length === 0) {
      return res.json({
        data: [],
      });
    }

    // ========================================================
    // remaining outbound items
    // ========================================================

    const remainRows: Array<{
      outbound_no: string;
      goods_out_item_id: number;
      product_id: number | null;
      code: string | null;
      name: string | null;
      lot_serial: string | null;
      exp: Date | null;
      remaining: number;
      key: string;
    }> = [];

    const productLotPairs = outbounds.flatMap((ob) =>
      ob.goods_outs
        .map((item) => ({
          product_id: item.product_id,
          lot_id: item.lot_id,
        }))
        .filter((x) => x.product_id != null && x.lot_id != null),
    );

    const wmsRows = await prisma.wms_mdt_goods.findMany({
      where: {
        OR: productLotPairs.map((x) => ({
          product_id: x.product_id!,
          lot_id: x.lot_id!,
        })),
      },
      select: {
        product_id: true,
        lot_id: true,
        expiration_date: true,
        lot_name: true,
        product_code: true,
      },
    });

    const wmsExpMap = new Map<string, Date | null>();

    for (const row of wmsRows) {
      wmsExpMap.set(
        buildProductLotKey(row.product_id, row.lot_id),
        row.expiration_date ?? null,
      );
    }

    for (const ob of outbounds) {
      for (const item of ob.goods_outs) {
        const qty = Number(item.qty ?? 0);
        const pick = Number(item.pick ?? 0);
        const remaining = qty - pick;

        if (remaining <= 0) continue;

        const productId = item.product_id ?? null;
        const lotId = item.lot_id ?? null;

        const expValue =
          productId != null && lotId != null
            ? (wmsExpMap.get(buildProductLotKey(productId, lotId)) ?? null)
            : null;

        const key = buildAutoLocationPackKey({
          product_id: productId,
          code: item.code,
          lot_serial: item.lot_serial,
          exp: expValue,
        });

        remainRows.push({
          outbound_no: ob.no,
          goods_out_item_id: item.id,
          product_id: productId,
          code: item.code,
          name: item.name,
          lot_serial: item.lot_serial,
          exp: expValue,
          remaining,
          key,
        });
      }
    }

    if (remainRows.length === 0) {
      return res.json({
        data: [],
      });
    }

    // ========================================================
    // load Location_Pack stocks
    // ========================================================

    const locationPackStocks = await prisma.stock.findMany({
      where: {
        quantity: {
          gt: 0,
        },
        location_name: {
          contains: "_Location_Pack",
        },
      },
    });

    // ========================================================
    // group stock qty
    // ========================================================

    const stockMap = new Map<
      string,
      {
        qty: number;
        stocks: typeof locationPackStocks;
      }
    >();

    for (const stock of locationPackStocks) {
      const key = buildAutoLocationPackKey({
        product_id: stock.product_id,
        code: stock.product_code,
        lot_serial: stock.lot_name,
        exp: stock.expiration_date,
      });

      const existing = stockMap.get(key);

      if (!existing) {
        stockMap.set(key, {
          qty: Number(stock.quantity),
          stocks: [stock],
        });
      } else {
        existing.qty += Number(stock.quantity);
        existing.stocks.push(stock);
      }
    }

    // ========================================================
    // merge result
    // ========================================================

    const resultMap = new Map<
      string,
      {
        key: string;
        product_id: number | null;
        code: string | null;
        name: string | null;
        lot_serial: string | null;
        exp: Date | null;
        available_qty: number;
        required_qty: number;
        docs: Array<{
          outbound_no: string;
          goods_out_item_id: number;
          qty: number;
          pick: number;
          remaining: number;
        }>;
      }
    >();

    for (const row of remainRows) {
      const stockInfo = stockMap.get(row.key);

      if (!stockInfo || stockInfo.qty <= 0) {
        continue;
      }

      const existing = resultMap.get(row.key);

      if (!existing) {
        resultMap.set(row.key, {
          key: row.key,
          product_id: row.product_id,
          code: row.code,
          name: row.name,
          lot_serial: row.lot_serial,
          exp: row.exp,
          available_qty: stockInfo.qty,
          required_qty: row.remaining,

          docs: [
            {
              outbound_no: row.outbound_no,
              goods_out_item_id: row.goods_out_item_id,
              qty: row.remaining,
              pick: 0,
              remaining: row.remaining,
            },
          ],
        });
      } else {
        existing.required_qty += row.remaining;

        existing.docs.push({
          outbound_no: row.outbound_no,
          goods_out_item_id: row.goods_out_item_id,
          qty: row.remaining,
          pick: 0,
          remaining: row.remaining,
        });
      }
    }

    return res.json({
      data: Array.from(resultMap.values()),
    });
  },
);

// ============================================================
// APPLY AUTO LOCATION PACK
// ============================================================

export const applyAutoLocationPack = asyncHandler(
  async (req: Request, res: Response) => {
    const itemKey = String(req.body?.item_key ?? "").trim();
    const mode = String(req.body?.mode ?? "AUTO").trim().toUpperCase();
    const outboundNo = req.body?.outbound_no
      ? String(req.body.outbound_no).trim()
      : null;

    const sourceLocationName = String(
      req.body?.source_location_name ?? "",
    ).trim();

    const outboundNos = Array.isArray(req.body?.outbound_nos)
      ? req.body.outbound_nos
          .map((x: any) => String(x ?? "").trim())
          .filter(Boolean)
      : [];

    if (!itemKey) throw badRequest("ไม่พบ item_key");
    if (!["AUTO", "DOC"].includes(mode)) throw badRequest("mode ไม่ถูกต้อง");
    if (!sourceLocationName) throw badRequest("กรุณาเลือก Location_Pack");
    if (mode === "DOC" && !outboundNo) throw badRequest("กรุณาระบุ outbound_no");

    // ✅ กัน AUTO ไปโดนเอกสารอื่นนอก Batch
    // FE ควรส่ง outbound_nos มาด้วยตอน apply
    if (mode === "AUTO" && outboundNos.length === 0) {
      throw badRequest("AUTO ต้องส่ง outbound_nos ของ Batch มาด้วย");
    }

    const result = await prisma.$transaction(async (tx) => {
      const pickedLoc = await tx.location.findFirst({
        where: {
          full_name: sourceLocationName,
          deleted_at: null,
        },
        select: {
          id: true,
          full_name: true,
        },
      });

      if (!pickedLoc) {
        throw badRequest(`ไม่พบ Location: ${sourceLocationName}`);
      }

      // ======================================================
      // Load stock เฉพาะ Location_Pack ที่ user เลือกเท่านั้น
      // ======================================================
      const stocks = await tx.stock.findMany({
        where: {
          quantity: {
            gt: 0,
          },
          location_name: sourceLocationName,
        },
        orderBy: [{ id: "asc" }],
      });

      const matchedStocks = stocks.filter((s) => {
        const key = buildAutoLocationPackKey({
          product_id: s.product_id,
          code: s.product_code,
          lot_serial: s.lot_name,
          exp: s.expiration_date,
        });

        return key === itemKey;
      });

      if (matchedStocks.length === 0) {
        throw badRequest("ไม่พบ stock Location_Pack ที่ตรงกับสินค้า");
      }

      let totalAvailable = matchedStocks.reduce(
        (sum, s) => sum + Number(s.quantity ?? 0),
        0,
      );

      if (totalAvailable <= 0) {
        throw badRequest("stock Location_Pack ไม่เพียงพอ");
      }

      // ======================================================
      // Load goods_out_item เฉพาะ Doc ที่เกี่ยวข้อง
      // ======================================================
      const goodsOutItems = await tx.goods_out_item.findMany({
        where: {
          deleted_at: null,
          outbound: {
            deleted_at: null,
            ...(mode === "DOC"
              ? { no: outboundNo! }
              : { no: { in: outboundNos } }),
          },
        },
        include: {
          outbound: true,
        },
        orderBy: [{ id: "asc" }],
      });

      if (goodsOutItems.length === 0) {
        throw badRequest("ไม่พบ goods_out_item");
      }

      // ======================================================
      // Resolve exp จาก wms_mdt_goods ด้วย product_id + lot_id
      // ======================================================
      const productLotPairs = goodsOutItems
        .map((item) => ({
          product_id: item.product_id,
          lot_id: item.lot_id,
        }))
        .filter((x) => x.product_id != null && x.lot_id != null);

      const wmsRows =
        productLotPairs.length > 0
          ? await tx.wms_mdt_goods.findMany({
              where: {
                OR: productLotPairs.map((x) => ({
                  product_id: x.product_id!,
                  lot_id: x.lot_id!,
                })),
              },
              select: {
                product_id: true,
                lot_id: true,
                expiration_date: true,
              },
            })
          : [];

      const wmsExpMap = new Map<string, Date | null>();

      for (const row of wmsRows) {
        wmsExpMap.set(
          buildProductLotKey(row.product_id, row.lot_id),
          row.expiration_date ?? null,
        );
      }

      const matchedItems = goodsOutItems
        .filter((item) => {
          const expValue =
            item.product_id != null && item.lot_id != null
              ? wmsExpMap.get(buildProductLotKey(item.product_id, item.lot_id)) ??
                null
              : null;

          const key = buildAutoLocationPackKey({
            product_id: item.product_id,
            code: item.code,
            lot_serial: item.lot_serial,
            exp: expValue,
          });

          return key === itemKey;
        })
        .map((item) => {
          const qty = Number(item.qty ?? 0);
          const pick = Number(item.pick ?? 0);

          return {
            item,
            remaining: Math.max(0, qty - pick),
          };
        })
        .filter((x) => x.remaining > 0);

      if (matchedItems.length === 0) {
        throw badRequest("ไม่พบ goods_out_item ที่ต้อง Pick");
      }

      const updatedItems: any[] = [];
      const stockCuts: any[] = [];

      // ======================================================
      // Apply pick + location_pick + cut stock
      // ======================================================
      for (const row of matchedItems) {
        if (totalAvailable <= 0) break;

        const useQty = Math.min(totalAvailable, row.remaining);
        if (useQty <= 0) continue;

        const updated = await tx.goods_out_item.update({
          where: {
            id: row.item.id,
          },
          data: {
            pick: {
              increment: useQty,
            },
            pick_time: new Date(),
          },
        });

        updatedItems.push(updated);

        // ✅ สำคัญ: ทำให้ FE แสดง Pick ใต้ Location_Pack ที่เลือกถูกต้อง
        const existingPick = await tx.goods_out_item_location_pick.findFirst({
          where: {
            goods_out_item_id: row.item.id,
            location_id: pickedLoc.id,
          },
        });

        if (existingPick) {
          await tx.goods_out_item_location_pick.update({
            where: {
              id: existingPick.id,
            },
            data: {
              qty_pick: {
                increment: useQty,
              },
              updated_at: new Date(),
            },
          });
        } else {
          await tx.goods_out_item_location_pick.create({
            data: {
              goods_out_item_id: row.item.id,
              location_id: pickedLoc.id,
              qty_pick: useQty,
            },
          });
        }

        totalAvailable -= useQty;

        let remainCut = useQty;

        for (const stock of matchedStocks) {
          if (remainCut <= 0) break;

          const stockQty = Number(stock.quantity ?? 0);
          if (stockQty <= 0) continue;

          const cutQty = Math.min(stockQty, remainCut);
          if (cutQty <= 0) continue;

          await tx.stock.update({
            where: {
              id: stock.id,
            },
            data: {
              quantity: {
                decrement: cutQty,
              },
            },
          });

          stockCuts.push({
            stock_id: stock.id,
            location_name: stock.location_name,
            cut_qty: cutQty,
          });

          remainCut -= cutQty;
          stock.quantity = new Prisma.Decimal(stockQty - cutQty);
        }
      }

      return {
        success: true,
        mode,
        source_location_name: sourceLocationName,
        updated_count: updatedItems.length,
        total_picked: updatedItems.reduce(
          (sum, item) => sum + Number(item.pick ?? 0),
          0,
        ),
        remaining_location_pack_qty: totalAvailable,
        stock_cuts: stockCuts,
      };
    });

    return res.json({
      data: result,
    });
  },
);
