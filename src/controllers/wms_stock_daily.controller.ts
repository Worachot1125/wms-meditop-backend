import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";
import {
  formatWmsStockDaily,
  type WmsStockDailyWithLocation,
} from "../utils/formatters/wms_stock_daily.formatter";

import { formatOdooInbound } from "../utils/formatters/odoo_inbound.formatter";
import { formatOdooOutbound } from "../utils/formatters/odoo_outbound.formatter";
import { formatTransferDocItem } from "../utils/formatters/transfer_item.formatter";
import { formatTransferMovement } from "../utils/formatters/transfer_movement.formatter";
import { formatOdooAdjustment } from "../utils/formatters/adjustment.formatter";

async function buildLocationMap(locationIds: number[]) {
  const uniqueIds = [...new Set(locationIds.filter((id) => !!id))];

  const map = new Map<number, any>();
  if (uniqueIds.length === 0) return map;

  const locations = await prisma.location.findMany({
    where: {
      id: { in: uniqueIds },
    },
    include: {
      building: true,
      zone: {
        include: {
          zone_type: true,
        },
      },
    },
  });

  for (const loc of locations) {
    map.set(loc.id, loc);
  }

  return map;
}

function buildWhere(req: Request) {
  const rawSearch = req.query.search;
  const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

  const selectedColumns = parseWmsStockDailySearchColumns(req.query.columns);

  let where: any = buildWmsStockDailySearchWhere(search, selectedColumns);

  const rawSnapshotDate = req.query.snapshot_date;
  const snapshotDate =
    typeof rawSnapshotDate === "string" ? rawSnapshotDate.trim() : "";

  if (snapshotDate) {
    const d = new Date(snapshotDate);
    if (!Number.isNaN(d.getTime())) {
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");

      where = {
        AND: [
          where,
          {
            snapshot_date: {
              gte: new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`),
              lt: new Date(`${yyyy}-${mm}-${dd}T23:59:59.999Z`),
            },
          },
        ],
      };
    }
  }

  return where;
}

export const getWmsStockDailyAll = asyncHandler(
  async (req: Request, res: Response) => {
    const where = buildWhere(req);

    const rows = await prisma.wms_stock_daily.findMany({
      where,
      orderBy: [{ snapshot_date: "desc" }, { id: "desc" }],
    });

    const locationMap = await buildLocationMap(
      rows
        .map((r) => r.location_id)
        .filter((id): id is number => id !== null && id !== undefined),
    );

    const formatted = rows.map((row) =>
      formatWmsStockDaily({
        ...row,
        locationRef: row.location_id
          ? (locationMap.get(row.location_id) ?? null)
          : null,
      } as WmsStockDailyWithLocation),
    );

    return res.json(formatted);
  },
);

function parseWmsStockDailySearchColumns(raw: unknown) {
  if (typeof raw !== "string") return [];

  const allowed = new Set([
    "snapshot_date",
    "product_code",
    "product_name",
    "unit",
    "location_name",
    "building",
    "zone",
    "zone_type",
    "lot_name",
    "expiration_date",
    "quantity",
  ]);

  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => allowed.has(s));
}

function buildWmsStockDailySearchWhere(search: string, columns: string[]): any {
  if (!search) return {};

  const useAll = columns.length === 0;
  const has = (col: string) => useAll || columns.includes(col);

  const orConditions: any[] = [];

  if (has("snapshot_date")) {
    const maybeDate = new Date(search);
    if (!Number.isNaN(maybeDate.getTime())) {
      const yyyy = maybeDate.getUTCFullYear();
      const mm = String(maybeDate.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(maybeDate.getUTCDate()).padStart(2, "0");

      orConditions.push({
        snapshot_date: {
          gte: new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`),
          lt: new Date(`${yyyy}-${mm}-${dd}T23:59:59.999Z`),
        },
      });
    }
  }

  if (has("product_code")) {
    orConditions.push({
      product_code: { contains: search, mode: "insensitive" },
    });
  }

  if (has("product_name")) {
    orConditions.push({
      product_name: { contains: search, mode: "insensitive" },
    });
  }

  if (has("unit")) {
    orConditions.push({
      unit: { contains: search, mode: "insensitive" },
    });
  }

  if (has("location_name")) {
    orConditions.push({
      location_name: { contains: search, mode: "insensitive" },
    });
  }

  if (has("building")) {
    orConditions.push({
      building: { contains: search, mode: "insensitive" },
    });
  }

  if (has("zone")) {
    orConditions.push({
      zone: { contains: search, mode: "insensitive" },
    });
  }

  if (has("zone_type")) {
    orConditions.push({
      zone_type: { contains: search, mode: "insensitive" },
    });
  }

  if (has("lot_name")) {
    orConditions.push({
      lot_name: { contains: search, mode: "insensitive" },
    });
  }

  if (has("expiration_date")) {
    const maybeDate = new Date(search);
    if (!Number.isNaN(maybeDate.getTime())) {
      const yyyy = maybeDate.getUTCFullYear();
      const mm = String(maybeDate.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(maybeDate.getUTCDate()).padStart(2, "0");

      orConditions.push({
        expiration_date: {
          gte: new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`),
          lt: new Date(`${yyyy}-${mm}-${dd}T23:59:59.999Z`),
        },
      });
    }
  }

  if (has("quantity")) {
    const qty = Number(search);
    if (!Number.isNaN(qty)) {
      orConditions.push({
        quantity: { equals: qty },
      });
    }
  }

  if (orConditions.length === 0) return { id: -1 };

  return {
    OR: orConditions,
  };
}

export const getWmsStockDailyPaginated = asyncHandler(
  async (req: Request, res: Response) => {
    const page = Number(req.query.page) || 1;
    const limit =
      req.query.limit !== undefined ? Number(req.query.limit) || 10 : 10;

    if (Number.isNaN(page) || page < 1) {
      throw badRequest("page ต้องเป็นตัวเลขบวกที่มากกว่า 0");
    }

    if (Number.isNaN(limit) || limit < 1) {
      throw badRequest("limit ต้องเป็นตัวเลขบวกที่มากกว่า 0");
    }

    const skip = (page - 1) * limit;
    const where = buildWhere(req);

    const [rows, total] = await Promise.all([
      prisma.wms_stock_daily.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ snapshot_date: "desc" }, { id: "desc" }],
      }),
      prisma.wms_stock_daily.count({ where }),
    ]);

    const locationMap = await buildLocationMap(
      rows
        .map((r) => r.location_id)
        .filter((id): id is number => id !== null && id !== undefined),
    );

    const formatted = rows.map((row) =>
      formatWmsStockDaily({
        ...row,
        locationRef: row.location_id
          ? (locationMap.get(row.location_id) ?? null)
          : null,
      } as WmsStockDailyWithLocation),
    );

    return res.json({
      data: formatted,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  },
);

export const getWmsStockDailyById = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);

    if (Number.isNaN(id) || id <= 0) {
      throw badRequest("id ต้องเป็นตัวเลขที่ถูกต้อง");
    }

    const row = await prisma.wms_stock_daily.findUnique({
      where: { id },
    });

    if (!row) throw notFound("ไม่พบ wms_stock_daily");

    const locationMap = await buildLocationMap(
      row.location_id ? [row.location_id] : [],
    );

    const formatted = formatWmsStockDaily({
      ...row,
      locationRef: row.location_id
        ? (locationMap.get(row.location_id) ?? null)
        : null,
    } as WmsStockDailyWithLocation);

    return res.json(formatted);
  },
);

type SimpleReportRow = {
  source:
    | "inbound"
    | "outbound"
    | "transfer_doc"
    | "transfer_movement"
    | "adjustment"
    | "swap";
  id: number;
  no: string | null;
  created_at: string;
  type: string | null;
  location: string | null;
  location_dest: string | null;
  user_ref: string | null;
};

function buildUserRef(user: any): string | null {
  if (!user) return null;

  const firstName = String(user.first_name ?? "").trim();
  const lastName = String(user.last_name ?? "").trim();
  const username = String(user.username ?? "").trim();

  const fullName = `${firstName} ${lastName}`.trim();
  if (fullName) return fullName;
  if (username) return username;

  return null;
}

function hasSVInNo(no: unknown): boolean {
  return String(no ?? "")
    .toUpperCase()
    .includes("SV");
}

function resolveReportTypeFromNo(
  no: unknown,
  fallback: string | null | undefined,
): string {
  if (hasSVInNo(no)) return "SV";
  return fallback ?? "";
}

export const getTransactionReport = asyncHandler(
  async (req: Request, res: Response) => {
    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

    const rawPage = req.query.page;
    const rawLimit = req.query.limit;

    const page = rawPage !== undefined ? Number(rawPage) : 1;
    const limit = rawLimit !== undefined ? Number(rawLimit) : 50;

    if (Number.isNaN(page) || page < 1) {
      throw badRequest("page ต้องเป็นตัวเลขมากกว่า 0");
    }
    if (Number.isNaN(limit) || limit < 1) {
      throw badRequest("limit ต้องเป็นตัวเลขมากกว่า 0");
    }

    const rawDateFrom = req.query.date_from;
    const rawDateTo = req.query.date_to;

    const dateFrom =
      typeof rawDateFrom === "string" && rawDateFrom.trim()
        ? new Date(rawDateFrom)
        : null;

    const dateTo =
      typeof rawDateTo === "string" && rawDateTo.trim()
        ? new Date(rawDateTo)
        : null;

    if (dateFrom && Number.isNaN(dateFrom.getTime())) {
      throw badRequest("date_from ไม่ถูกต้อง");
    }
    if (dateTo && Number.isNaN(dateTo.getTime())) {
      throw badRequest("date_to ไม่ถูกต้อง");
    }

    const createdAtFilter =
      dateFrom || dateTo
        ? {
            ...(dateFrom ? { gte: dateFrom } : {}),
            ...(dateTo ? { lte: dateTo } : {}),
          }
        : undefined;

    const [inbounds, outbounds, transferDocs, transferMovements, adjustments] =
      await Promise.all([
        prisma.inbound.findMany({
          where: {
            ...(createdAtFilter ? { created_at: createdAtFilter } : {}),
            ...(search
              ? {
                  OR: [
                    { no: { contains: search, mode: "insensitive" } },
                    { location: { contains: search, mode: "insensitive" } },
                    {
                      location_dest: { contains: search, mode: "insensitive" },
                    },
                    { in_type: { contains: search, mode: "insensitive" } },
                  ],
                }
              : {}),
          },
          select: {
            id: true,
            no: true,
            created_at: true,
            in_type: true,
            location: true,
            location_dest: true,
          },
        }),

        prisma.outbound.findMany({
          where: {
            ...(createdAtFilter ? { created_at: createdAtFilter } : {}),
            ...(search
              ? {
                  OR: [
                    { no: { contains: search, mode: "insensitive" } },
                    { location: { contains: search, mode: "insensitive" } },
                    {
                      location_dest: { contains: search, mode: "insensitive" },
                    },
                    { out_type: { contains: search, mode: "insensitive" } },
                  ],
                }
              : {}),
          },
          select: {
            id: true,
            no: true,
            created_at: true,
            out_type: true,
            location: true,
            location_dest: true,
          },
        }),

        prisma.transfer_doc.findMany({
          where: {
            ...(createdAtFilter ? { created_at: createdAtFilter } : {}),
            ...(search
              ? {
                  OR: [
                    { no: { contains: search, mode: "insensitive" } },
                    { location: { contains: search, mode: "insensitive" } },
                    {
                      location_dest: { contains: search, mode: "insensitive" },
                    },
                    { in_type: { contains: search, mode: "insensitive" } },
                  ],
                }
              : {}),
          },
          select: {
            id: true,
            no: true,
            created_at: true,
            in_type: true,
            location: true,
            location_dest: true,
          },
        }),

        prisma.transfer_movement.findMany({
          where: {
            ...(createdAtFilter ? { created_at: createdAtFilter } : {}),
            ...(search
              ? {
                  OR: [
                    { no: { contains: search, mode: "insensitive" } },
                    { status: { contains: search, mode: "insensitive" } },
                    {
                      user: {
                        username: { contains: search, mode: "insensitive" },
                      },
                    },
                    {
                      user: {
                        first_name: { contains: search, mode: "insensitive" },
                      },
                    },
                    {
                      user: {
                        last_name: { contains: search, mode: "insensitive" },
                      },
                    },
                  ],
                }
              : {}),
          },
          select: {
            id: true,
            no: true,
            created_at: true,
            status: true,
            user: {
              select: {
                username: true,
                first_name: true,
                last_name: true,
              },
            },
          },
        }),

        prisma.adjustment.findMany({
          where: {
            ...(createdAtFilter ? { created_at: createdAtFilter } : {}),
            ...(search
              ? {
                  OR: [
                    { no: { contains: search, mode: "insensitive" } },
                    { type: { contains: search, mode: "insensitive" } },
                    { status: { contains: search, mode: "insensitive" } },
                    { origin: { contains: search, mode: "insensitive" } },
                    { reference: { contains: search, mode: "insensitive" } },
                  ],
                }
              : {}),
          },
          select: {
            id: true,
            no: true,
            created_at: true,
            type: true,
          },
        }),
      ]);

    const rows: SimpleReportRow[] = [
      ...inbounds.map(
        (x): SimpleReportRow => ({
          source: "inbound",
          id: x.id,
          no: x.no ?? null,
          created_at: x.created_at.toISOString(),
          type: x.in_type ?? "IN",
          location: x.location ?? null,
          location_dest: x.location_dest ?? null,
          user_ref: null,
        }),
      ),

      ...outbounds.map(
        (x): SimpleReportRow => ({
          source: "outbound",
          id: x.id,
          no: x.no ?? null,
          created_at: x.created_at.toISOString(),
          type: resolveReportTypeFromNo(x.no, x.out_type ?? "OUT"),
          location: x.location ?? null,
          location_dest: x.location_dest ?? null,
          user_ref: null,
        }),
      ),

      ...transferDocs.map(
        (x): SimpleReportRow => ({
          source: "transfer_doc",
          id: x.id,
          no: x.no ?? null,
          created_at: x.created_at.toISOString(),
          type: x.in_type ?? "TF",
          location: x.location ?? null,
          location_dest: x.location_dest ?? null,
          user_ref: null,
        }),
      ),

      ...transferMovements.map(
        (x): SimpleReportRow => ({
          source: "transfer_movement",
          id: x.id,
          no: x.no ?? null,
          created_at: x.created_at.toISOString(),
          type: "MOVE",
          location: null,
          location_dest: null,
          user_ref: buildUserRef(x.user),
        }),
      ),

      ...adjustments
        .filter((x) => !hasSVInNo(x.no))
        .map(
          (x): SimpleReportRow => ({
            source: "adjustment",
            id: x.id,
            no: x.no ?? null,
            created_at: x.created_at.toISOString(),
            type: x.type ?? "ADJ",
            location: null,
            location_dest: null,
            user_ref: null,
          }),
        ),
    ];

    rows.sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );

    const total = rows.length;
    const start = (page - 1) * limit;
    const end = start + limit;
    const pagedRows = rows.slice(start, end);

    return res.json({
      data: pagedRows,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  },
);

function parseTransactionReportSearchColumns(raw: unknown) {
  if (typeof raw !== "string") return [];

  const allowed = new Set([
    "no",
    "created_at",
    "type",
    "location",
    "location_dest",
    "user_ref",
    "status",
    "reference",
    "origin",

    // ✅ เพิ่ม search item/product
    "department",
    "product",
    "product_code",
    "code",
    "product_name",
    "name",
    "unit",
    "lot",
    "lot_serial",
    "exp",
    "zone_type",
  ]);

  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => allowed.has(s));
}

function buildDateRangeFromSearch(search: string) {
  const maybeDate = new Date(search);
  if (Number.isNaN(maybeDate.getTime())) return null;

  const yyyy = maybeDate.getUTCFullYear();
  const mm = String(maybeDate.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(maybeDate.getUTCDate()).padStart(2, "0");

  return {
    gte: new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`),
    lte: new Date(`${yyyy}-${mm}-${dd}T23:59:59.999Z`),
  };
}

function searchColumnHelper(columns: string[]) {
  const useAll = columns.length === 0;
  return (col: string) => useAll || columns.includes(col);
}

function buildInboundReportWhere(
  createdAtFilter: any,
  search: string,
  columns: string[],
) {
  const where: any = {
    ...(createdAtFilter ? { created_at: createdAtFilter } : {}),
  };

  if (!search) return where;

  const orConditions: any[] = [];

  orConditions.push({ no: { contains: search, mode: "insensitive" } });
  orConditions.push({ location: { contains: search, mode: "insensitive" } });
  orConditions.push({
    location_dest: { contains: search, mode: "insensitive" },
  });
  orConditions.push({ in_type: { contains: search, mode: "insensitive" } });

  // ✅ search item code/name/lot/barcode ผ่าน relation goods_ins
  orConditions.push({
    goods_ins: {
      some: {
        deleted_at: null,
        OR: [
          { code: { contains: search, mode: "insensitive" } },
          { name: { contains: search, mode: "insensitive" } },
          { lot: { contains: search, mode: "insensitive" } },
          { lot_serial: { contains: search, mode: "insensitive" } },
          { barcode_text: { contains: search, mode: "insensitive" } },
        ],
      },
    },
  });

  const numeric = Number(search);
  if (Number.isFinite(numeric)) {
    orConditions.push({
      goods_ins: {
        some: {
          deleted_at: null,
          OR: [
            { product_id: numeric },
            { lot_id: numeric },
            { qty: numeric },
            { quantity_receive: numeric },
            { quantity_count: numeric },
          ],
        },
      },
    });
  }

  where.OR = orConditions;
  return where;
}

function buildOutboundReportWhere(
  createdAtFilter: any,
  search: string,
  columns: string[],
) {
  const where: any = {
    ...(createdAtFilter ? { created_at: createdAtFilter } : {}),
  };

  if (!search) return where;

  const has = searchColumnHelper(columns);
  const orConditions: any[] = [];

  if (has("no")) {
    orConditions.push({ no: { contains: search, mode: "insensitive" } });
  }

  if (has("location")) {
    orConditions.push({ location: { contains: search, mode: "insensitive" } });
  }

  if (has("location_dest")) {
    orConditions.push({
      location_dest: { contains: search, mode: "insensitive" },
    });
  }

  if (has("type")) {
    orConditions.push({ out_type: { contains: search, mode: "insensitive" } });
  }

  if (has("department")) {
    orConditions.push({
      department: { contains: search, mode: "insensitive" },
    });
  }

  if (has("origin")) {
    orConditions.push({ origin: { contains: search, mode: "insensitive" } });
  }

  if (has("reference")) {
    orConditions.push({
      reference: { contains: search, mode: "insensitive" },
    });
  }

  if (has("created_at")) {
    const dateRange = buildDateRangeFromSearch(search);
    if (dateRange) orConditions.push({ created_at: dateRange });
  }

  if (has("code") || has("product_code") || has("product")) {
    orConditions.push({
      goods_outs: {
        some: {
          deleted_at: null,
          code: { contains: search, mode: "insensitive" },
        },
      },
    });
  }

  if (has("name") || has("product_name") || has("product")) {
    orConditions.push({
      goods_outs: {
        some: {
          deleted_at: null,
          name: { contains: search, mode: "insensitive" },
        },
      },
    });
  }

  if (has("unit")) {
    orConditions.push({
      goods_outs: {
        some: {
          deleted_at: null,
          unit: { contains: search, mode: "insensitive" },
        },
      },
    });
  }

  if (has("lot") || has("lot_serial")) {
    orConditions.push({
      goods_outs: {
        some: {
          deleted_at: null,
          lot_serial: { contains: search, mode: "insensitive" },
        },
      },
    });
  }

  if (orConditions.length > 0) where.OR = orConditions;
  else where.id = -1;

  return where;
}

function buildTransferDocReportWhere(
  createdAtFilter: any,
  search: string,
  columns: string[],
) {
  const where: any = {
    ...(createdAtFilter ? { created_at: createdAtFilter } : {}),
  };

  if (!search) return where;

  const has = searchColumnHelper(columns);
  const orConditions: any[] = [];

  if (has("no")) {
    orConditions.push({ no: { contains: search, mode: "insensitive" } });
  }

  if (has("location")) {
    orConditions.push({ location: { contains: search, mode: "insensitive" } });
  }

  if (has("location_dest")) {
    orConditions.push({
      location_dest: { contains: search, mode: "insensitive" },
    });
  }

  if (has("type")) {
    orConditions.push({ in_type: { contains: search, mode: "insensitive" } });
  }

  if (has("department")) {
    orConditions.push({
      department: { contains: search, mode: "insensitive" },
    });
  }

  if (has("origin")) {
    orConditions.push({ origin: { contains: search, mode: "insensitive" } });
  }

  if (has("reference")) {
    orConditions.push({
      reference: { contains: search, mode: "insensitive" },
    });
  }

  if (has("created_at")) {
    const dateRange = buildDateRangeFromSearch(search);
    if (dateRange) orConditions.push({ created_at: dateRange });
  }

  if (has("code") || has("product_code") || has("product")) {
    orConditions.push({
      transfer_doc_items: {
        some: {
          deleted_at: null,
          code: { contains: search, mode: "insensitive" },
        },
      },
    });
  }

  if (has("name") || has("product_name") || has("product")) {
    orConditions.push({
      transfer_doc_items: {
        some: {
          deleted_at: null,
          name: { contains: search, mode: "insensitive" },
        },
      },
    });
  }

  if (has("unit")) {
    orConditions.push({
      transfer_doc_items: {
        some: {
          deleted_at: null,
          unit: { contains: search, mode: "insensitive" },
        },
      },
    });
  }

  if (has("lot") || has("lot_serial")) {
    orConditions.push({
      transfer_doc_items: {
        some: {
          deleted_at: null,
          OR: [
            { lot: { contains: search, mode: "insensitive" } },
            { lot_serial: { contains: search, mode: "insensitive" } },
          ],
        },
      },
    });
  }

  if (orConditions.length > 0) where.OR = orConditions;
  else where.id = -1;

  return where;
}

function buildTransferMovementReportWhere(
  createdAtFilter: any,
  search: string,
  columns: string[],
) {
  const where: any = {
    ...(createdAtFilter ? { created_at: createdAtFilter } : {}),
  };

  if (!search) return where;

  const orConditions: any[] = [];

  // =========================
  // document
  // =========================
  orConditions.push({
    no: { contains: search, mode: "insensitive" },
  });

  orConditions.push({
    status: { contains: search, mode: "insensitive" },
  });

  // =========================
  // user
  // =========================
  orConditions.push({
    user: {
      username: { contains: search, mode: "insensitive" },
    },
  });

  orConditions.push({
    user: {
      first_name: { contains: search, mode: "insensitive" },
    },
  });

  orConditions.push({
    user: {
      last_name: { contains: search, mode: "insensitive" },
    },
  });

  // =========================
  // items
  // =========================
  orConditions.push({
    items: {
      some: {
        deleted_at: null,
        OR: [
          {
            code: {
              contains: search,
              mode: "insensitive",
            },
          },
          {
            name: {
              contains: search,
              mode: "insensitive",
            },
          },
          {
            lot_serial: {
              contains: search,
              mode: "insensitive",
            },
          },

          // ✅ location source
          {
            lock_no: {
              contains: search,
              mode: "insensitive",
            },
          },

          // ✅ location dest
          {
            lock_no_dest: {
              contains: search,
              mode: "insensitive",
            },
          },
        ],
      },
    },
  });

  // =========================
  // date
  // =========================
  const dateRange = buildDateRangeFromSearch(search);
  if (dateRange) {
    orConditions.push({
      created_at: dateRange,
    });
  }

  where.OR = orConditions;

  return where;
}

function buildAdjustmentReportWhere(
  createdAtFilter: any,
  search: string,
  columns: string[],
) {
  const where: any = {
    ...(createdAtFilter ? { created_at: createdAtFilter } : {}),
  };

  if (!search) return where;

  const has = searchColumnHelper(columns);
  const orConditions: any[] = [];

  if (has("no")) {
    orConditions.push({ no: { contains: search, mode: "insensitive" } });
  }

  if (has("type")) {
    orConditions.push({ type: { contains: search, mode: "insensitive" } });
  }

  if (has("status")) {
    orConditions.push({ status: { contains: search, mode: "insensitive" } });
  }

  if (has("origin")) {
    orConditions.push({ origin: { contains: search, mode: "insensitive" } });
  }

  if (has("reference")) {
    orConditions.push({ reference: { contains: search, mode: "insensitive" } });
  }

  if (has("department")) {
    orConditions.push({
      department: { contains: search, mode: "insensitive" },
    });
  }

  if (has("created_at")) {
    const dateRange = buildDateRangeFromSearch(search);
    if (dateRange) orConditions.push({ created_at: dateRange });
  }

  if (has("code") || has("product_code") || has("product")) {
    orConditions.push({
      items: {
        some: {
          deleted_at: null,
          code: { contains: search, mode: "insensitive" },
        },
      },
    });
  }

  if (has("name") || has("product_name") || has("product")) {
    orConditions.push({
      items: {
        some: {
          deleted_at: null,
          name: { contains: search, mode: "insensitive" },
        },
      },
    });
  }

  if (has("unit")) {
    orConditions.push({
      items: {
        some: {
          deleted_at: null,
          unit: { contains: search, mode: "insensitive" },
        },
      },
    });
  }

  if (has("lot") || has("lot_serial")) {
    orConditions.push({
      items: {
        some: {
          deleted_at: null,
          lot_serial: { contains: search, mode: "insensitive" },
        },
      },
    });
  }

  if (orConditions.length > 0) where.OR = orConditions;
  else where.id = -1;

  return where;
}

function buildSwapReportWhere(
  createdAtFilter: any,
  search: string,
  columns: string[],
) {
  const where: any = {
    ...(createdAtFilter ? { created_at: createdAtFilter } : {}),
  };

  if (!search) return where;

  const has = searchColumnHelper(columns);
  const orConditions: any[] = [];

  if (has("no")) {
    orConditions.push({ no: { contains: search, mode: "insensitive" } });
    orConditions.push({ name: { contains: search, mode: "insensitive" } });
  }

  if (has("location")) {
    orConditions.push({
      source_location: { contains: search, mode: "insensitive" },
    });
    orConditions.push({
      location_name: { contains: search, mode: "insensitive" },
    });
  }

  if (has("location_dest")) {
    orConditions.push({
      dest_location: { contains: search, mode: "insensitive" },
    });
    orConditions.push({
      location_dest_name: { contains: search, mode: "insensitive" },
    });
  }

  if (has("status")) {
    orConditions.push({ status: { contains: search, mode: "insensitive" } });
  }

  if (has("origin")) {
    orConditions.push({ origin: { contains: search, mode: "insensitive" } });
  }

  if (has("reference")) {
    orConditions.push({ reference: { contains: search, mode: "insensitive" } });
  }

  if (has("user_ref")) {
    orConditions.push({ user_ref: { contains: search, mode: "insensitive" } });
  }

  if (has("created_at")) {
    const dateRange = buildDateRangeFromSearch(search);
    if (dateRange) orConditions.push({ created_at: dateRange });
  }

  if (has("code") || has("product_code") || has("product")) {
    orConditions.push({
      swapItems: {
        some: {
          deleted_at: null,
          code: { contains: search, mode: "insensitive" },
        },
      },
    });
  }

  if (has("name") || has("product_name") || has("product")) {
    orConditions.push({
      swapItems: {
        some: {
          deleted_at: null,
          name: { contains: search, mode: "insensitive" },
        },
      },
    });
  }

  if (has("unit")) {
    orConditions.push({
      swapItems: {
        some: {
          deleted_at: null,
          unit: { contains: search, mode: "insensitive" },
        },
      },
    });
  }

  if (has("lot") || has("lot_serial")) {
    orConditions.push({
      swapItems: {
        some: {
          deleted_at: null,
          lot_serial: { contains: search, mode: "insensitive" },
        },
      },
    });
  }

  if (orConditions.length > 0) where.OR = orConditions;
  else where.id = -1;

  return where;
}

function withDeletedAtNull<T extends Record<string, any> | undefined>(
  where?: T,
) {
  return {
    deleted_at: null,
    ...(where ?? {}),
  };
}

function normalizeProductCode(v: unknown): string {
  return String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-_./]+/g, "");
}

function getGoodsInReturnQty(item: any): number {
  return Math.max(
    0,
    Math.floor(
      Number(
        item?.return ??
          item?.return_qty ??
          item?.qty_return ??
          item?.quantity_return ??
          0,
      ),
    ),
  );
}

export const getTransactionReportPaginated = asyncHandler(
  async (req: Request, res: Response) => {
    const page = Number(req.query.page) || 1;
    const limit =
      req.query.limit !== undefined ? Number(req.query.limit) || 10 : 10;

    if (Number.isNaN(page) || page < 1) {
      throw badRequest("page ต้องเป็นตัวเลขบวกที่มากกว่า 0");
    }

    if (Number.isNaN(limit) || limit < 1) {
      throw badRequest("limit ต้องเป็นตัวเลขบวกที่มากกว่า 0");
    }

    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

    const type =
      typeof req.query.type === "string"
        ? req.query.type.trim().toUpperCase()
        : "";

    const dateFrom =
      typeof req.query.date_from === "string" && req.query.date_from.trim()
        ? new Date(req.query.date_from)
        : null;

    const dateTo =
      typeof req.query.date_to === "string" && req.query.date_to.trim()
        ? new Date(req.query.date_to)
        : null;

    if (dateFrom && Number.isNaN(dateFrom.getTime())) {
      throw badRequest("date_from ไม่ถูกต้อง");
    }

    if (dateTo && Number.isNaN(dateTo.getTime())) {
      throw badRequest("date_to ไม่ถูกต้อง");
    }

    const createdAtFilter =
      dateFrom || dateTo
        ? {
            ...(dateFrom ? { gte: dateFrom } : {}),
            ...(dateTo ? { lte: dateTo } : {}),
          }
        : undefined;

    const selectedColumns = parseTransactionReportSearchColumns(
      req.query.columns,
    );

    const rawSortBy = String(req.query.sortBy ?? "created_at").trim();
    const rawSortDir = String(req.query.sortDir ?? "desc")
      .trim()
      .toLowerCase();

    type SortBy =
      | "created_at"
      | "no"
      | "code"
      | "name"
      | "type"
      | "location"
      | "location_dest"
      | "user_ref"
      | "source";

    type SortDir = "asc" | "desc";

    const allowedSortBy: SortBy[] = [
      "created_at",
      "no",
      "code",
      "name",
      "type",
      "location",
      "location_dest",
      "user_ref",
      "source",
    ];

    const sortBy: SortBy = allowedSortBy.includes(rawSortBy as SortBy)
      ? (rawSortBy as SortBy)
      : "created_at";

    const sortDir: SortDir = rawSortDir === "asc" ? "asc" : "desc";

    function normalizeText(v: unknown): string {
      return String(v ?? "")
        .trim()
        .toLowerCase();
    }

    function firstNonEmpty(...values: any[]): string | null {
      for (const value of values) {
        if (value === null || value === undefined) continue;
        const text = String(value).trim();
        if (text) return text;
      }
      return null;
    }

    function goodsExpKey(productId: unknown, lotId: unknown): string {
      return `p:${Number(productId ?? 0)}|lot:${Number(lotId ?? 0)}`;
    }

    function getItemCode(item: any): string | null {
      return firstNonEmpty(
        item?.code,
        item?.product_code,
        item?.sku,
        item?.product,
      );
    }

    function getItemName(item: any): string | null {
      return firstNonEmpty(item?.name, item?.product_name);
    }

    function withSingleItemDocument(doc: any, item: any) {
      return {
        ...doc,
        items: item ? [item] : [],
      };
    }

    function makeRowId(source: string, docId: any, item: any, index: number) {
      return [
        source,
        docId ?? "doc",
        index,
        firstNonEmpty(
          item?.id,
          item?.sequence,
          item?.product_id,
          item?.code,
          item?.lot_id,
          item?.lot_serial,
          item?.exp,
        ) ?? "item",
      ].join("-");
    }

    const [
      inbounds,
      outbounds,
      transferDocs,
      transferMovements,
      adjustments,
      swaps,
    ] = await Promise.all([
      prisma.inbound.findMany({
        where: withDeletedAtNull(
          buildInboundReportWhere(createdAtFilter, search, selectedColumns),
        ),
        include: {
          goods_ins: {
            where: { deleted_at: null },
            include: { barcode: true },
            orderBy: { id: "asc" },
          },
        },
      }),

      prisma.outbound.findMany({
        where: withDeletedAtNull(
          buildOutboundReportWhere(createdAtFilter, search, selectedColumns),
        ),
        include: {
          goods_outs: {
            where: { deleted_at: null },
            include: {
              barcode_ref: true,
              goodsOutItemLocationReturns: {
                include: { location: true },
              },
            },
            orderBy: { id: "asc" },
          },
        },
      }),

      prisma.transfer_doc.findMany({
        where: withDeletedAtNull(
          buildTransferDocReportWhere(createdAtFilter, search, selectedColumns),
        ),
        include: {
          transfer_doc_items: {
            where: { deleted_at: null },
            orderBy: { id: "asc" },
          },
        },
      }),

      prisma.transfer_movement.findMany({
        where: withDeletedAtNull(
          buildTransferMovementReportWhere(
            createdAtFilter,
            search,
            selectedColumns,
          ),
        ),
        include: {
          user: true,
          department: true,
          items: {
            where: { deleted_at: null },
            orderBy: { id: "asc" },
          },
          movement_departments: {
            include: { department: true },
          },
          movement_user_works: {
            include: { user: true },
          },
        },
      }),

      prisma.adjustment.findMany({
        where: withDeletedAtNull(
          buildAdjustmentReportWhere(createdAtFilter, search, selectedColumns),
        ),
        include: {
          items: {
            where: { deleted_at: null },
            orderBy: { id: "asc" },
          },
        },
      }),

      prisma.swap.findMany({
        where: withDeletedAtNull(
          buildSwapReportWhere(createdAtFilter, search, selectedColumns),
        ),
        include: {
          department: true,
          swapItems: {
            where: { deleted_at: null },
            orderBy: { id: "asc" },
          },
        },
      }),
    ]);

    const departmentOdooIds = Array.from(
      new Set(
        [
          ...inbounds.map((x: any) => x.department_id).filter(Boolean),
          ...outbounds.map((x: any) => x.department_id).filter(Boolean),
          ...transferDocs.map((x: any) => x.department_id).filter(Boolean),
          ...transferMovements.map((x: any) => x.department_id).filter(Boolean),
          ...swaps.map((x: any) => x.department_id).filter(Boolean),
        ].map((v) => Number(v)),
      ),
    ).filter((v) => Number.isFinite(v) && v > 0);

    const departments = departmentOdooIds.length
      ? await prisma.department.findMany({
          where: {
            odoo_id: { in: departmentOdooIds },
            deleted_at: null,
          },
          select: {
            id: true,
            odoo_id: true,
            short_name: true,
            full_name: true,
          },
        })
      : [];

    const departmentMap = new Map<
      number,
      { short_name: string | null; full_name: string | null }
    >();

    for (const d of departments) {
      if (d.odoo_id === null || d.odoo_id === undefined) continue;
      const odooId = Number(d.odoo_id);
      if (!Number.isFinite(odooId) || odooId <= 0) continue;

      departmentMap.set(odooId, {
        short_name: d.short_name ?? null,
        full_name: d.full_name ?? null,
      });
    }

    const expPairs = new Map<string, { product_id: number; lot_id: number }>();

    const collectExpPair = (productId: unknown, lotId: unknown) => {
      const p = Number(productId ?? 0);
      const l = Number(lotId ?? 0);
      if (!Number.isFinite(p) || p <= 0) return;
      if (!Number.isFinite(l) || l <= 0) return;
      expPairs.set(goodsExpKey(p, l), { product_id: p, lot_id: l });
    };

    for (const doc of inbounds as any[]) {
      for (const item of doc.goods_ins ?? []) {
        collectExpPair(item.product_id, item.lot_id);
      }
    }

    for (const doc of outbounds as any[]) {
      for (const item of doc.goods_outs ?? []) {
        collectExpPair(item.product_id, item.lot_id);
      }
    }

    for (const doc of transferDocs as any[]) {
      for (const item of doc.transfer_doc_items ?? []) {
        collectExpPair(item.product_id, item.lot_id);
      }
    }

    for (const doc of transferMovements as any[]) {
      for (const item of doc.items ?? []) {
        collectExpPair(item.product_id, item.lot_id);
      }
    }

    for (const doc of adjustments as any[]) {
      for (const item of doc.items ?? []) {
        collectExpPair(item.product_id, item.lot_id);
      }
    }

    for (const doc of swaps as any[]) {
      for (const item of doc.swapItems ?? []) {
        collectExpPair(item.product_id, item.lot_id);
      }
    }

    const expRows = expPairs.size
      ? await prisma.wms_mdt_goods.findMany({
          where: {
            OR: Array.from(expPairs.values()).map((x) => ({
              product_id: x.product_id,
              lot_id: x.lot_id,
            })),
          },
          select: {
            product_id: true,
            lot_id: true,
            expiration_date: true,
            id: true,
          },
          orderBy: { id: "desc" },
        })
      : [];

    const expMap = new Map<string, string | null>();

    for (const row of expRows) {
      const key = goodsExpKey(row.product_id, row.lot_id);
      if (!expMap.has(key)) {
        expMap.set(
          key,
          row.expiration_date ? row.expiration_date.toISOString() : null,
        );
      }
    }

    const mdtRows = await prisma.wms_mdt_goods.findMany({
      select: {
        product_code: true,
        zone_type: true,
        id: true,
      },
      orderBy: { id: "desc" },
    });

    const zoneTypeMap = new Map<string, string | null>();

    for (const row of mdtRows) {
      const key = normalizeProductCode(row.product_code);
      if (key && !zoneTypeMap.has(key)) {
        zoneTypeMap.set(key, row.zone_type ?? null);
      }
    }

    const getDepartmentName = (
      departmentOdooId: unknown,
      fallback?: string | null,
    ): string => {
      const odooId = Number(departmentOdooId ?? 0);
      const found = departmentMap.get(odooId);

      return found?.short_name || found?.full_name || fallback || "";
    };

    const getExp = (productId: unknown, lotId: unknown): string | null => {
      const p = Number(productId ?? 0);
      const l = Number(lotId ?? 0);
      if (!Number.isFinite(p) || p <= 0) return null;
      if (!Number.isFinite(l) || l <= 0) return null;
      return expMap.get(goodsExpKey(p, l)) ?? null;
    };

    const getZoneType = (code: unknown): string | null => {
      return zoneTypeMap.get(normalizeProductCode(code)) ?? null;
    };

    type ReportRow = {
      source: string;
      id: number | string;
      no: string | null;
      created_at: string;
      type: string | null;
      location: string | null;
      location_dest: string | null;
      user_ref: string | null;
      code: string | null;
      name: string | null;
      document: any;
    };

    const inboundRows: ReportRow[] = inbounds.flatMap((doc: any) => {
      const formatted = formatOdooInbound(doc);

      const items = (formatted.items ?? []).map((item: any) => ({
        ...item,
        exp: getExp(item.product_id, item.lot_id) ?? item.exp ?? null,
        zone_type: getZoneType(item.code) ?? item.zone_type ?? null,
      }));

      const department = getDepartmentName(
        doc.department_id,
        formatted.department,
      );

      if (items.length === 0) {
        return [
          {
            source: "inbound",
            id: `inbound-${formatted.id}-empty`,
            no: formatted.no,
            created_at: formatted.created_at,
            type: formatted.in_type ?? "IN",
            location: formatted.location ?? null,
            location_dest: formatted.location_dest ?? null,
            user_ref: null,
            code: null,
            name: null,
            document: { ...formatted, department, items: [] },
          },
        ];
      }

      const normalRows: ReportRow[] = items.map((item: any, index: number) => ({
        source: "inbound",
        id: makeRowId("inbound", formatted.id, item, index),
        no: formatted.no,
        created_at: formatted.created_at,
        type: formatted.in_type ?? "IN",
        location: formatted.location ?? null,
        location_dest: formatted.location_dest ?? null,
        user_ref: null,
        code: getItemCode(item),
        name: getItemName(item),
        document: withSingleItemDocument({ ...formatted, department }, item),
      }));

      const returnRows: ReportRow[] = items
        .map((item: any, index: number) => {
          const returnQty = getGoodsInReturnQty(item);
          if (returnQty <= 0) return null;

          const returnItem = {
            ...item,
            qty: returnQty,
            quantity_receive: returnQty,
            quantity_count: returnQty,
            confirmed_qty: returnQty,
            return: returnQty,
            return_qty: returnQty,
            qty_return: returnQty,
            quantity_return: returnQty,
          };

          return {
            source: "inbound_return",
            id: makeRowId("inbound-return", formatted.id, returnItem, index),
            no: formatted.no,
            created_at: formatted.created_at,
            type: "RETURN",
            location: formatted.location ?? null,
            location_dest: formatted.location_dest ?? null,
            user_ref: null,
            code: getItemCode(returnItem),
            name: getItemName(returnItem),
            document: withSingleItemDocument(
              {
                ...formatted,
                department,
                in_type: "RETURN",
                type: "RETURN",
              },
              returnItem,
            ),
          } as ReportRow;
        })
        .filter((x): x is ReportRow => x !== null);

      return [...normalRows, ...returnRows];
    });

    const outboundRows: ReportRow[] = outbounds.flatMap((doc: any) => {
      const formatted = formatOdooOutbound(doc);

      const items = (formatted.items ?? []).map((item: any) => ({
        ...item,
        exp: getExp(item.product_id, item.lot_id) ?? item.exp ?? null,
        zone_type: getZoneType(item.code) ?? item.zone_type ?? null,
      }));

      const resolvedType = resolveReportTypeFromNo(
        formatted.no,
        formatted.out_type ?? "OUT",
      );

      const department = getDepartmentName(
        doc.department_id,
        formatted.department,
      );

      const normalRows: ReportRow[] = items.map((item: any, index: number) => ({
        source: "outbound",
        id: makeRowId("outbound", formatted.id, item, index),
        no: formatted.no,
        created_at: formatted.created_at,
        type: resolvedType,
        location: formatted.location ?? null,
        location_dest: formatted.location_dest ?? null,
        user_ref: null,
        code: getItemCode(item),
        name: getItemName(item),
        document: withSingleItemDocument(
          {
            ...formatted,
            out_type: resolvedType,
            department,
          },
          item,
        ),
      }));

      const returnRows: ReportRow[] = (doc.goods_outs ?? [])
        .map((goi: any, index: number) => {
          const rows = Array.isArray(goi?.goodsOutItemLocationReturns)
            ? goi.goodsOutItemLocationReturns
            : [];

          const returnQty = rows.reduce(
            (sum: number, r: any) => sum + Math.max(0, Number(r?.return ?? 0)),
            0,
          );

          if (returnQty <= 0) return null;

          const formattedItem =
            items.find((x: any) => Number(x.id) === Number(goi.id)) ??
            items.find(
              (x: any) =>
                Number(x.product_id) === Number(goi.product_id) &&
                Number(x.lot_id ?? 0) === Number(goi.lot_id ?? 0) &&
                String(x.lot_serial ?? "") === String(goi.lot_serial ?? ""),
            ) ??
            {};

          const returnLocation = rows[0]?.location ?? null;

          const returnItem = {
            ...formattedItem,
            ...goi,
            barcode: formattedItem?.barcode ?? goi?.barcode_ref ?? null,
            barcode_ref: formattedItem?.barcode_ref ?? goi?.barcode_ref ?? null,
            barcode_text:
              formattedItem?.barcode_text ?? goi?.barcode_text ?? null,
            exp:
              getExp(goi.product_id, goi.lot_id) ??
              formattedItem?.exp ??
              goi?.exp ??
              null,
            zone_type:
              getZoneType(goi.code) ??
              formattedItem?.zone_type ??
              goi?.zone_type ??
              null,
            unit: formattedItem?.unit ?? goi?.unit ?? null,
            code: formattedItem?.code ?? goi?.code ?? null,
            name: formattedItem?.name ?? goi?.name ?? null,
            qty: returnQty,
            quantity: returnQty,
            quantity_receive: returnQty,
            quantity_count: returnQty,
            confirmed_qty: returnQty,
            in: returnQty,
            out: 0,
            return: returnQty,
            return_qty: returnQty,
            qty_return: returnQty,
            quantity_return: returnQty,
            return_locations: rows,
            return_location: returnLocation,
            location_return: returnLocation?.full_name ?? null,
          };

          return {
            source: "outbound_return",
            id: makeRowId("outbound-return", doc.id, returnItem, index),
            no: formatted.no,
            created_at: formatted.created_at,
            type: "RETURN",
            location: formatted.location_dest ?? null,
            location_dest: formatted.location ?? null,
            user_ref: null,
            code: getItemCode(returnItem),
            name: getItemName(returnItem),
            document: withSingleItemDocument(
              {
                ...formatted,
                out_type: "RETURN",
                type: "RETURN",
                department,
              },
              returnItem,
            ),
          } as ReportRow;
        })
        .filter((x: ReportRow | null): x is ReportRow => x !== null);

      return [...normalRows, ...returnRows];
    });

    const transferDocRows: ReportRow[] = transferDocs.flatMap((doc: any) => {
      const department = getDepartmentName(doc.department_id, doc.department);

      const formattedItems = (doc.transfer_doc_items ?? []).map(
        (rawItem: any) => {
          const expIso = getExp(rawItem.product_id, rawItem.lot_id);

          const formatted: any = formatTransferDocItem({
            ...rawItem,
            transfer_doc: {
              ...doc,
              department,
            },
            exp: expIso ? new Date(expIso) : (rawItem.exp ?? null),
            zone_type: getZoneType(rawItem.code) ?? rawItem.zone_type ?? null,
          } as any);

          return {
            ...formatted,
            ...rawItem,
            id: rawItem.id,
            sequence: rawItem.sequence ?? null,
            product_id: rawItem.product_id ?? null,
            code: rawItem.code ?? formatted?.code ?? null,
            name: rawItem.name ?? formatted?.name ?? null,
            unit: rawItem.unit ?? formatted?.unit ?? null,
            tracking: rawItem.tracking ?? formatted?.tracking ?? null,
            lot_id: rawItem.lot_id ?? null,
            lot: rawItem.lot ?? rawItem.lot_serial ?? formatted?.lot ?? null,
            lot_serial:
              rawItem.lot_serial ??
              rawItem.lot ??
              formatted?.lot_serial ??
              null,
            qty: rawItem.qty ?? formatted?.qty ?? null,
            quantity:
              rawItem.quantity ??
              rawItem.qty ??
              rawItem.quantity_receive ??
              formatted?.quantity ??
              null,
            quantity_receive:
              rawItem.quantity_receive ??
              rawItem.qty ??
              formatted?.quantity_receive ??
              null,
            quantity_count: rawItem.quantity_count ?? 0,
            quantity_put: rawItem.quantity_put ?? 0,
            barcode_id: rawItem.barcode_id ?? null,
            barcode_text:
              rawItem.barcode_text ?? formatted?.barcode_text ?? null,
            exp:
              expIso ??
              (rawItem.exp ? rawItem.exp.toISOString() : null) ??
              formatted?.exp ??
              null,
            zone_type:
              getZoneType(rawItem.code) ??
              rawItem.zone_type ??
              formatted?.zone_type ??
              null,
          };
        },
      );

      const formattedDoc = {
        id: doc.id,
        no: doc.no ?? null,
        lot: doc.lot ?? null,
        date: doc.date ? doc.date.toISOString() : null,
        quantity: doc.quantity ?? null,
        in_type: doc.in_type ?? "TF",
        department_id: doc.department_id ?? null,
        department,
        location: doc.location ?? null,
        location_dest: doc.location_dest ?? null,
        created_at: doc.created_at.toISOString(),
        updated_at: doc.updated_at ? doc.updated_at.toISOString() : null,
        items: formattedItems,
      };

      if (formattedItems.length === 0) {
        return [
          {
            source: "transfer_doc",
            id: `transfer_doc-${doc.id}-empty`,
            no: doc.no ?? null,
            created_at: doc.created_at.toISOString(),
            type: doc.in_type ?? "TF",
            location: doc.location ?? null,
            location_dest: doc.location_dest ?? null,
            user_ref: null,
            code: null,
            name: null,
            document: formattedDoc,
          },
        ];
      }

      return formattedItems.map((item: any, index: number) => ({
        source: "transfer_doc",
        id: makeRowId("transfer_doc", doc.id, item, index),
        no: doc.no ?? null,
        created_at: doc.created_at.toISOString(),
        type: doc.in_type ?? "TF",
        location: doc.location ?? null,
        location_dest: doc.location_dest ?? null,
        user_ref: null,
        code: getItemCode(item),
        name: getItemName(item),
        document: withSingleItemDocument(formattedDoc, item),
      }));
    });

    const transferMovementRows: ReportRow[] = transferMovements.flatMap(
      (doc: any) => {
        const formatted = formatTransferMovement(doc);

        const items = (formatted.items ?? []).map((item: any) => ({
          ...item,
          exp: getExp(item.product_id, item.lot_id) ?? item.exp ?? null,
          zone_type: getZoneType(item.code) ?? item.zone_type ?? null,
        }));

        const department = getDepartmentName(doc.department_id, null);
        const userRef = buildUserRef(doc.user);

        if (items.length === 0) {
          return [
            {
              source: "transfer_movement",
              id: `transfer_movement-${formatted.id}-empty`,
              no: formatted.no ?? null,
              created_at: formatted.created_at,
              type: "MOVE",
              location: null,
              location_dest: null,
              user_ref: userRef,
              code: null,
              name: null,
              document: {
                ...formatted,
                department,
                items: [],
              },
            },
          ];
        }

        return items.map((item: any, index: number) => ({
          source: "transfer_movement",
          id: makeRowId("transfer_movement", formatted.id, item, index),
          no: formatted.no ?? null,
          created_at: formatted.created_at,
          type: "MOVE",
          location: item.lock_no ?? item.location ?? null,
          location_dest: item.lock_no_dest ?? item.location_dest ?? null,
          user_ref: userRef,
          code: getItemCode(item),
          name: getItemName(item),
          document: withSingleItemDocument(
            {
              ...formatted,
              department,
            },
            item,
          ),
        }));
      },
    );

    const adjustmentRows: ReportRow[] = adjustments
      .filter((doc: any) => !hasSVInNo(doc.no))
      .flatMap((doc: any) => {
        const formatted = formatOdooAdjustment(doc);

        const items = (formatted.items ?? []).map((item: any) => ({
          ...item,
          exp: getExp(item.product_id, item.lot_id) ?? item.exp ?? null,
          zone_type: getZoneType(item.code) ?? item.zone_type ?? null,
        }));

        const department = getDepartmentName(
          doc.department_id,
          formatted.department,
        );

        if (items.length === 0) {
          return [
            {
              source: "adjustment",
              id: `adjustment-${formatted.id}-empty`,
              no: formatted.no,
              created_at: formatted.created_at,
              type: formatted.type ?? "ADJ",
              location: null,
              location_dest: null,
              user_ref: null,
              code: null,
              name: null,
              document: {
                ...formatted,
                department,
                items: [],
              },
            },
          ];
        }

        return items.map((item: any, index: number) => ({
          source: "adjustment",
          id: makeRowId("adjustment", formatted.id, item, index),
          no: formatted.no,
          created_at: formatted.created_at,
          type: formatted.type ?? "ADJ",
          location: null,
          location_dest: null,
          user_ref: null,
          code: getItemCode(item),
          name: getItemName(item),
          document: withSingleItemDocument(
            {
              ...formatted,
              department,
            },
            item,
          ),
        }));
      });

    const swapRows: ReportRow[] = swaps.flatMap((doc: any) => {
      const department =
        doc.department?.short_name ||
        doc.department?.full_name ||
        getDepartmentName(doc.department_id, null);

      const formattedItems = (doc.swapItems ?? []).map((item: any) => ({
        id: item.id,
        source_sequence: item.source_sequence ?? null,
        odoo_line_key: item.odoo_line_key ?? null,
        product_id: item.product_id ?? null,
        code: item.code ?? null,
        name: item.name ?? null,
        unit: item.unit ?? null,
        tracking: item.tracking ?? null,
        lot_id: item.lot_id ?? null,
        lot_serial: item.lot_serial ?? null,
        barcode_text: item.barcode_text ?? null,
        exp:
          getExp(item.product_id, item.lot_id) ??
          (item.expiration_date ? item.expiration_date.toISOString() : null),
        expiration_date: item.expiration_date
          ? item.expiration_date.toISOString()
          : null,
        zone_type: getZoneType(item.code),
        system_qty: item.system_qty ?? 0,
        executed_qty: item.executed_qty ?? 0,
        created_at: item.created_at ? item.created_at.toISOString() : null,
        updated_at: item.updated_at ? item.updated_at.toISOString() : null,
      }));

      const formattedDoc = {
        id: doc.id,
        name: doc.name ?? null,
        no: doc.no ?? null,
        picking_id: doc.picking_id ?? null,
        odoo_location_id: doc.odoo_location_id ?? null,
        source_location_id: doc.source_location_id ?? null,
        source_location: doc.source_location ?? null,
        odoo_location_dest_id: doc.odoo_location_dest_id ?? null,
        dest_location_id: doc.dest_location_id ?? null,
        dest_location: doc.dest_location ?? null,
        location_id: doc.location_id ?? null,
        location_name: doc.location_name ?? null,
        location_dest_id: doc.location_dest_id ?? null,
        location_dest_name: doc.location_dest_name ?? null,
        department_id: doc.department_id ?? null,
        department,
        status: doc.status ?? null,
        user_ref: doc.user_ref ?? null,
        remark: doc.remark ?? null,
        origin: doc.origin ?? null,
        reference: doc.reference ?? null,
        type: "SWAP",
        created_at: doc.created_at.toISOString(),
        updated_at: doc.updated_at ? doc.updated_at.toISOString() : null,
        items: formattedItems,
      };

      if (formattedItems.length === 0) {
        return [
          {
            source: "swap",
            id: `swap-${doc.id}-empty`,
            no: doc.no ?? null,
            created_at: doc.created_at.toISOString(),
            type: "SWAP",
            location: doc.source_location ?? doc.location_name ?? null,
            location_dest: doc.dest_location ?? doc.location_dest_name ?? null,
            user_ref: doc.user_ref ?? null,
            code: null,
            name: null,
            document: formattedDoc,
          },
        ];
      }

      return formattedItems.map((item: any, index: number) => ({
        source: "swap",
        id: makeRowId("swap", doc.id, item, index),
        no: doc.no ?? null,
        created_at: doc.created_at.toISOString(),
        type: "SWAP",
        location: doc.source_location ?? doc.location_name ?? null,
        location_dest: doc.dest_location ?? doc.location_dest_name ?? null,
        user_ref: doc.user_ref ?? null,
        code: getItemCode(item),
        name: getItemName(item),
        document: withSingleItemDocument(formattedDoc, item),
      }));
    });

    let rows: ReportRow[] = [
      ...inboundRows,
      ...outboundRows,
      ...transferDocRows,
      ...transferMovementRows,
      ...adjustmentRows,
      ...swapRows,
    ];

    if (type) {
      rows = rows.filter(
        (row) => String(row.type ?? "").toUpperCase() === type,
      );
    }

    if (search) {
      const s = normalizeText(search);

      rows = rows.filter((row) => {
        const item = row.document?.items?.[0] ?? {};
        const doc = row.document ?? {};

        const values = [
          row.no,
          row.type,
          row.source,
          row.location,
          row.location_dest,
          row.user_ref,
          row.code,
          row.name,

          doc.no,
          doc.department,
          doc.location,
          doc.location_dest,
          doc.origin,
          doc.reference,
          doc.in_type,
          doc.out_type,
          doc.type,
          doc.status,

          item.code,
          item.product_code,
          item.name,
          item.product_name,
          item.unit,
          item.lot,
          item.lot_serial,
          item.zone_type,
          item.exp,
          item.barcode_text,
        ];

        return values.some((v) => normalizeText(v).includes(s));
      });
    }

    rows.sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1;

      const compareText = (x: unknown, y: unknown) =>
        normalizeText(x).localeCompare(normalizeText(y), undefined, {
          numeric: true,
          sensitivity: "base",
        });

      const compareDate = (x: unknown, y: unknown) => {
        const tx = new Date(String(x ?? "")).getTime();
        const ty = new Date(String(y ?? "")).getTime();
        const ax = Number.isFinite(tx) ? tx : 0;
        const ay = Number.isFinite(ty) ? ty : 0;
        return ax - ay;
      };

      let result = 0;

      switch (sortBy) {
        case "no":
          result = compareText(a.no, b.no);
          break;
        case "code":
          result = compareText(a.code, b.code);
          break;
        case "name":
          result = compareText(a.name, b.name);
          break;
        case "type":
          result = compareText(a.type, b.type);
          break;
        case "location":
          result = compareText(a.location, b.location);
          break;
        case "location_dest":
          result = compareText(a.location_dest, b.location_dest);
          break;
        case "user_ref":
          result = compareText(a.user_ref, b.user_ref);
          break;
        case "source":
          result = compareText(a.source, b.source);
          break;
        case "created_at":
        default:
          result = compareDate(a.created_at, b.created_at);
          break;
      }

      if (result !== 0) return result * dir;

      const createdAtTie = compareDate(a.created_at, b.created_at);
      if (createdAtTie !== 0) return createdAtTie * -1;

      return compareText(a.no, b.no);
    });

    const total = rows.length;
    const totalPages = Math.ceil(total / limit);
    const skip = (page - 1) * limit;
    const data = rows.slice(skip, skip + limit);

    return res.json({
      data,
      meta: {
        page,
        limit,
        total,
        totalPages,
        sortBy,
        sortDir,
      },
    });
  },
);
