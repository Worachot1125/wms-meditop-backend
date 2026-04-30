import { Prisma } from "@prisma/client";
import { parseDateInput } from "./parseDate";

export const WMS_MDT_GOODS_FIELD_MAPPING: Record<string, string> = {
  product_id: "product_id",
  product_code: "product_code",
  product_name: "product_name",
  lot_id: "lot_id",
  lot_name: "lot_name",
  expiration_date: "expiration_date",
  expiration_date_end: "expiration_date",
  department_id: "department_id",
  department_code: "department_code",
  department_name: "department_name",
  zone_id: "zone_id",
  zone_type: "zone_type",
  unit: "unit",
  remark: "user_manaul_url",
};

export const WMS_MDT_GOODS_ALLOWED_COLUMNS = new Set(
  Object.keys(WMS_MDT_GOODS_FIELD_MAPPING),
);

const numericFields = new Set([
  "product_id",
  "lot_id",
  "department_id",
  "zone_id",
]);

const textFields = new Set([
  "product_code",
  "product_name",
  "lot_name",
  "department_code",
  "department_name",
  "zone_type",
  "unit",
  "user_manaul_url",
]);

const dateFields = new Set(["expiration_date"]);

export const parseSearchColumns = (rawColumns: unknown): string[] => {
  if (Array.isArray(rawColumns)) {
    return rawColumns
      .flatMap((x) => String(x).split(","))
      .map((s) => s.trim())
      .filter(Boolean);
  }

  if (typeof rawColumns === "string") {
    return rawColumns
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return [];
};

const buildDateRange = (search: string): { gte: Date; lt: Date } | null => {
  const raw = search.trim();
  if (!raw) return null;

  try {
    const date = parseDateInput(raw, "expiration_date");
    const gte = new Date(date);
    gte.setHours(0, 0, 0, 0);

    const lt = new Date(gte);
    lt.setDate(lt.getDate() + 1);

    return { gte, lt };
  } catch {
    return null;
  }
};

export const buildWmsMdtGoodsWhere = (params: {
  search: string;
  columns: string[];
}): Prisma.wms_mdt_goodsWhereInput | null => {
  const { search, columns } = params;

  if (!search) return {};

  const isNumericSearch = /^\d+$/.test(search);
  const dateRange = buildDateRange(search);

  const columnsToSearch =
    columns.length === 0
      ? Array.from(WMS_MDT_GOODS_ALLOWED_COLUMNS)
      : columns.filter((c) => WMS_MDT_GOODS_ALLOWED_COLUMNS.has(c));

  const orConditions: Prisma.wms_mdt_goodsWhereInput[] = [];

  for (const col of columnsToSearch) {
    const dbField = WMS_MDT_GOODS_FIELD_MAPPING[col];
    if (!dbField) continue;

    if (numericFields.has(dbField)) {
      if (isNumericSearch) {
        orConditions.push({
          [dbField]: { equals: Number(search) },
        } as Prisma.wms_mdt_goodsWhereInput);
      }
      continue;
    }

    if (dateFields.has(dbField)) {
      if (dateRange) {
        orConditions.push({
          [dbField]: {
            gte: dateRange.gte,
            lt: dateRange.lt,
          },
        } as Prisma.wms_mdt_goodsWhereInput);
      }
      continue;
    }

    if (textFields.has(dbField)) {
      orConditions.push({
        [dbField]: {
          contains: search,
          mode: "insensitive",
        },
      } as Prisma.wms_mdt_goodsWhereInput);
    }
  }

  if (orConditions.length === 0) return null;

  return { OR: orConditions };
};