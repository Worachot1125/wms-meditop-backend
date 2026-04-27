import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";

import { formatOdooInbound } from "../utils/formatters/odoo_inbound.formatter";
import { formatOdooOutbound } from "../utils/formatters/odoo_outbound.formatter";
import { formatOdooAdjustment } from "../utils/formatters/adjustment.formatter";
import { formatTransferDocItem } from "../utils/formatters/transfer_item.formatter";
import {
  formatTransferMovement,
  buildInputNumberMap,
} from "../utils/formatters/transfer_movement.formatter";
import {
  buildReportDetailMaps,
  getExpFromMaps,
  getZoneTypeFromMaps,
} from "../utils/reportItemEnricher";

type ReportDetailSource =
  | "inbound"
  | "outbound"
  | "transfer_doc"
  | "transfer_movement"
  | "adjustment";

function asReportSource(v: unknown): ReportDetailSource {
  const s = String(v ?? "").trim() as ReportDetailSource;
  if (
    s !== "inbound" &&
    s !== "outbound" &&
    s !== "transfer_doc" &&
    s !== "transfer_movement" &&
    s !== "adjustment"
  ) {
    throw badRequest("source ไม่ถูกต้อง");
  }
  return s;
}

function asId(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw badRequest("id ต้องเป็นตัวเลขมากกว่า 0");
  }
  return n;
}

type UserWorkLite = {
  id: number;
  first_name: string;
  last_name: string;
  tel: string | null;
  user_level: string | null;
};

async function buildUserWorkMapFromMovement(
  row:
    | {
        movement_user_works?: Array<{
          user_id: number;
          user?: {
            id: number;
            first_name: string;
            last_name: string;
            tel: string | null;
            user_level: string | null;
          } | null;
        }>;
      }
    | null
    | undefined,
): Promise<Map<number, UserWorkLite>> {
  const list = Array.isArray(row?.movement_user_works)
    ? row!.movement_user_works
    : [];

  const directUsers = list.map((x) => x.user).filter(Boolean) as UserWorkLite[];

  const directMap = new Map<number, UserWorkLite>();
  for (const u of directUsers) {
    if (!directMap.has(u.id)) directMap.set(u.id, u);
  }

  const missingIds = list
    .map((x) => Number(x.user_id))
    .filter((id) => Number.isFinite(id) && id > 0 && !directMap.has(id));

  if (missingIds.length === 0) return directMap;

  const rows = await prisma.user.findMany({
    where: { id: { in: missingIds }, deleted_at: null },
    select: {
      id: true,
      first_name: true,
      last_name: true,
      tel: true,
      user_level: true,
    },
  });

  for (const u of rows) {
    if (!directMap.has(u.id)) directMap.set(u.id, u);
  }

  return directMap;
}

async function buildBarcodeTextMapFromMovementItems(
  items: Array<{
    product_id?: number | null;
    code?: string | null;
    lot_serial?: string | null;
  }>,
): Promise<Map<string, string | null>> {
  function normalizeLotText(v: unknown): string {
    const s = v == null ? "" : String(v).trim();
    const n = s.replace(/\s+/g, " ").toLowerCase();
    return n.length ? n : "__NULL__";
  }

  function movementGoodsKey(product_id: number, lot_serial: unknown) {
    return `p:${product_id}|lot:${normalizeLotText(lot_serial)}`;
  }

  const pairMap = new Map<
    string,
    { pid: number; lot_key: string; lot_name: string | null }
  >();

  for (const it of items) {
    const pidFromItem = Number(it.product_id ?? NaN);
    const pidFromCode = Number(String(it.code ?? "").trim());

    const pid =
      Number.isFinite(pidFromItem) && pidFromItem > 0
        ? pidFromItem
        : pidFromCode;

    if (!Number.isFinite(pid) || pid <= 0) continue;

    const lot_name =
      it.lot_serial == null ? null : String(it.lot_serial).trim() || null;
    const lot_key = normalizeLotText(lot_name);

    const k = movementGoodsKey(pid, lot_name);
    pairMap.set(k, { pid, lot_key, lot_name });
  }

  const pairs = Array.from(pairMap.values());
  const barcodeTextMap = new Map<string, string | null>();
  if (pairs.length === 0) return barcodeTextMap;

  const orWhere: any[] = [];

  for (const p of pairs) {
    if (p.lot_key === "__NULL__") {
      orWhere.push({
        product_id: p.pid,
        deleted_at: null,
        OR: [
          { lot_serial: null },
          { lot_serial: "" },
          { lot: null },
          { lot: "" },
        ],
      });
      continue;
    }

    const lot = String(p.lot_name ?? "").trim();
    orWhere.push({
      product_id: p.pid,
      lot_serial: { equals: lot, mode: "insensitive" as const },
      deleted_at: null,
    });
    orWhere.push({
      product_id: p.pid,
      lot: { equals: lot, mode: "insensitive" as const },
      deleted_at: null,
    });
  }

  const rows = await prisma.goods_in.findMany({
    where: { OR: orWhere },
    select: {
      product_id: true,
      lot_serial: true,
      lot: true,
      barcode_text: true,
      updated_at: true,
      created_at: true,
      id: true,
    },
    orderBy: [{ updated_at: "desc" }, { created_at: "desc" }, { id: "desc" }],
  });

  for (const r of rows) {
    const pid = Number(r.product_id ?? NaN);
    if (!Number.isFinite(pid) || pid <= 0) continue;

    const lotRaw = (r.lot_serial ?? r.lot) as any;
    const k = movementGoodsKey(pid, lotRaw);

    if (!barcodeTextMap.has(k)) {
      const t = String(r.barcode_text ?? "").trim();
      barcodeTextMap.set(k, t.length > 0 ? t : null);
    }
  }

  return barcodeTextMap;
}

export const getTransactionReportDetail = asyncHandler(
  async (req: Request, res: Response) => {
    const source = asReportSource(req.params.source);
    const id = asId(req.params.id);

    if (source === "inbound") {
      const row = await prisma.inbound.findUnique({
        where: { id },
        include: {
          goods_ins: {
            where: { deleted_at: null },
            include: { barcode: true },
            orderBy: { sequence: "asc" },
          },
        },
      });

      if (!row) throw notFound("ไม่พบ inbound");

      const { expMap, zoneTypeMap } = await buildReportDetailMaps(
        row.goods_ins ?? [],
      );
      const formatted = formatOdooInbound(row);

      return res.json({
        source,
        data: {
          ...formatted,
          items: formatted.items.map((item) => ({
            ...item,
            exp: getExpFromMaps(expMap, item.product_id, item.lot_id),
            zone_type: getZoneTypeFromMaps(zoneTypeMap, item.code),
          })),
        },
      });
    }

    if (source === "outbound") {
      const row = await prisma.outbound.findUnique({
        where: { id },
        include: {
          goods_outs: {
            where: { deleted_at: null },
            include: {
              barcode_ref: true,
              boxes: {
                include: { box: true },
              },
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
      });

      if (!row) throw notFound("ไม่พบ outbound");

      const { expMap, zoneTypeMap } = await buildReportDetailMaps(
        row.goods_outs ?? [],
      );

      const patchedRow = {
        ...row,
        goods_outs: (row.goods_outs ?? []).map((item: any) => ({
          ...item,
          location_picks: item.goodsOutItemLocationPicks ?? [],
        })),
      };

      const formatted = formatOdooOutbound(patchedRow as any);

      return res.json({
        source,
        data: {
          ...formatted,
          items: formatted.items.map((item) => ({
            ...item,
            exp: getExpFromMaps(expMap, item.product_id, item.lot_id),
            zone_type: getZoneTypeFromMaps(zoneTypeMap, item.code),
          })),
        },
      });
    }

    if (source === "transfer_doc") {
      const row = await prisma.transfer_doc.findUnique({
        where: { id },
        include: {
          transfer_doc_items: {
            where: { deleted_at: null },
            include: {
              transfer_doc: true,
            },
            orderBy: { sequence: "asc" },
          },
        },
      });

      if (!row) throw notFound("ไม่พบ transfer_doc");

      const { expMap, zoneTypeMap } = await buildReportDetailMaps(
        row.transfer_doc_items ?? [],
      );

      const enrichedItems = (row.transfer_doc_items ?? []).map((item: any) => ({
        ...item,
        exp: getExpFromMaps(expMap, item.product_id, item.lot_id)
          ? new Date(getExpFromMaps(expMap, item.product_id, item.lot_id)!)
          : (item.exp ?? null),
        zone_type: getZoneTypeFromMaps(zoneTypeMap, item.code),
      }));

      return res.json({
        source,
        data: {
          id: row.id,
          picking_id: row.picking_id ?? null,
          no: row.no ?? null,
          lot: row.lot ?? null,
          location_id: row.location_id ?? null,
          location: row.location ?? null,
          location_dest_id: row.location_dest_id ?? null,
          location_dest: row.location_dest ?? null,
          department_id: row.department_id ?? null,
          department: row.department,
          reference: row.reference ?? null,
          quantity: row.quantity ?? null,
          origin: row.origin ?? null,
          date: row.date.toISOString(),
          in_type: row.in_type,
          created_at: row.created_at.toISOString(),
          updated_at: row.updated_at ? row.updated_at.toISOString() : null,
          items: enrichedItems.map((item) => formatTransferDocItem(item)),
        },
      });
    }

    if (source === "transfer_movement") {
      const row = await prisma.transfer_movement.findUnique({
        where: { id },
        include: {
          user: true,
          department: true,
          items: {
            where: { deleted_at: null },
            orderBy: { sequence: "asc" },
          },
          movement_departments: {
            include: { department: true },
          },
          movement_user_works: {
            include: { user: true },
          },
        },
      });

      if (!row) throw notFound("ไม่พบ transfer_movement");

      const barcodeTextMap = await buildBarcodeTextMapFromMovementItems(
        row.items ?? [],
      );
      const inputNumberMap = await buildInputNumberMap(row.items ?? []);
      const userWorkMap = await buildUserWorkMapFromMovement(row);

      const { expMap, zoneTypeMap } = await buildReportDetailMaps(
        row.items ?? [],
      );

      const formatted = formatTransferMovement(row as any, {
        barcodeTextMap,
        inputNumberMap,
        userWorkMap,
      });

      return res.json({
        source,
        data: {
          ...formatted,
          items: formatted.items.map((item: any) => ({
            ...item,
            exp:
              getExpFromMaps(expMap, item.product_id, item.lot_id) ??
              item.exp ??
              null,
            zone_type: getZoneTypeFromMaps(zoneTypeMap, item.code),
          })),
        },
      });
    }

    if (source === "adjustment") {
      const row = await prisma.adjustment.findUnique({
        where: { id },
        include: {
          items: {
            where: { deleted_at: null },
            orderBy: { sequence: "asc" },
          },
        },
      });

      if (!row) throw notFound("ไม่พบ adjustment");

      const { expMap, zoneTypeMap } = await buildReportDetailMaps(
        row.items ?? [],
      );
      const formatted = formatOdooAdjustment(row);

      return res.json({
        source,
        data: {
          ...formatted,
          items: formatted.items.map((item) => ({
            ...item,
            exp:
              getExpFromMaps(expMap, item.product_id, item.lot_id) ??
              item.exp ??
              null,
            zone_type: getZoneTypeFromMaps(zoneTypeMap, item.code),
          })),
        },
      });
    }

    throw badRequest("source ไม่ถูกต้อง");
  },
);
