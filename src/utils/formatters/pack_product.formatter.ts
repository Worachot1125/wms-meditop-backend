import type {
  pack_product,
  pack_product_box,
  pack_product_box_item,
  outbound,
  goods_out_item,
  barcode,
  box,
} from "@prisma/client";
import {
  formatOdooOutbound,
  type OdooOutboundFormatter,
} from "./odoo_outbound.formatter";

export interface PackProductBoxItemFormatter {
  id: number;
  goods_out_item_id: number;
  quantity: number;
  goods_out_item: {
    id: number;
    outbound_id: number;
    code: string | null;
    name: string;
    lot_serial: string | null;
    qty: number | null;
    pick: number;
    pack: number;
    status: string;
  } | null;
}

export interface PackProductBoxFormatter {
  id: number;
  box_no: number;
  box_max: number;
  box_label: string;
  box_code: string;
  status: string;
  created_at: string;
  updated_at: string | null;
  items: PackProductBoxItemFormatter[];
}

export interface PackProductSummaryFormatter {
  total_outbounds: number;
  total_items: number;
  completed_items: number;
  incomplete_items: number;
  total_qty: number;
  total_pack: number;
  progress_percent: number;
  total_boxes: number;
  distinct_box_count: number;
  max_box: number;
  open_box_count: number;
  closed_box_count: number;
  missing_box_nos: number[];
  can_finalize: boolean;
}

export interface GroupedPackProductBoxDetailFormatter {
  box_id: number;
  box_no: number;
  box_label: string;
  box_code: string;
  qty: number;
}

export interface GroupedPackProductItemFormatter {
  code: string | null;
  name: string;
  lot_serial: string | null;
  qty: number;
  pick: number;
  pack: number;
  status: string;
  outbound_ids: number[];
  outbound_nos: string[];
  grouped_item_ids: number[];
  box_ids: number[];
  box_nos: number[];
  box_labels: string[];
  box_codes: string[];
  box_details: GroupedPackProductBoxDetailFormatter[];
  box_display: string | null;
  sample_item: any | null;
}

export interface PackProductFormatter {
  id: number;
  name: string;
  scan_prefix: string;
  max_box: number;
  status: string;
  remark: string | null;
  batch_name: string | null;
  created_at: string;
  updated_at: string | null;
  outbounds: OdooOutboundFormatter[];
  grouped_items: GroupedPackProductItemFormatter[];
  boxes: PackProductBoxFormatter[];
  summary: PackProductSummaryFormatter;
}

function normalizeKey(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

function sortNumberAsc(arr: number[]) {
  return [...arr].sort((a, b) => a - b);
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function uniqueNumbers(values: number[]) {
  return Array.from(new Set(values.filter((v) => Number.isFinite(v))));
}

function pickGroupedStatus(current: string, incoming: string) {
  const c = String(current ?? "").toLowerCase();
  const i = String(incoming ?? "").toLowerCase();

  if (c === i) return current;

  if (c === "completed" && i !== "completed") return incoming;
  if (i === "completed" && c !== "completed") return current;

  if (c === "packed" || i === "packed") return c === "packed" ? current : incoming;
  if (c === "picked" || i === "picked") return c === "picked" ? current : incoming;

  return current || incoming;
}

type PackBoxWithItems = pack_product_box & {
  items?: Array<
    pack_product_box_item & {
      goods_out_item?: goods_out_item | null;
    }
  >;
};

type ItemBoxMapValue = {
  box_ids: number[];
  box_nos: number[];
  box_labels: string[];
  box_codes: string[];
  box_details: GroupedPackProductBoxDetailFormatter[];
};

function mergeBoxDetails(
  current: GroupedPackProductBoxDetailFormatter[],
  incoming: GroupedPackProductBoxDetailFormatter[],
) {
  const map = new Map<number, GroupedPackProductBoxDetailFormatter>();

  for (const row of current) {
    map.set(Number(row.box_id), {
      box_id: Number(row.box_id),
      box_no: Number(row.box_no),
      box_label: String(row.box_label ?? ""),
      box_code: String(row.box_code ?? ""),
      qty: Number(row.qty ?? 0),
    });
  }

  for (const row of incoming) {
    const key = Number(row.box_id);
    const existing = map.get(key);

    if (!existing) {
      map.set(key, {
        box_id: Number(row.box_id),
        box_no: Number(row.box_no),
        box_label: String(row.box_label ?? ""),
        box_code: String(row.box_code ?? ""),
        qty: Number(row.qty ?? 0),
      });
      continue;
    }

    existing.qty += Number(row.qty ?? 0);
    existing.box_no = Number(row.box_no ?? existing.box_no);
    existing.box_label = String(row.box_label ?? existing.box_label);
    existing.box_code = String(row.box_code ?? existing.box_code);
  }

  return Array.from(map.values()).sort((a, b) => a.box_no - b.box_no);
}

function buildBoxDisplay(details: GroupedPackProductBoxDetailFormatter[]) {
  if (!details.length) return null;

  return details
    .map((d) => `${d.box_label} (จำนวน ${d.qty})`)
    .join(", ");
}

function buildItemBoxMap(boxes: PackBoxWithItems[]) {
  const map = new Map<number, ItemBoxMapValue>();

  for (const packBox of boxes ?? []) {
    for (const item of packBox.items ?? []) {
      const goodsOutItemId = Number(item.goods_out_item_id);
      if (!Number.isFinite(goodsOutItemId)) continue;

      const existing = map.get(goodsOutItemId) ?? {
        box_ids: [],
        box_nos: [],
        box_labels: [],
        box_codes: [],
        box_details: [],
      };

      existing.box_ids = uniqueNumbers([...existing.box_ids, Number(packBox.id)]);
      existing.box_nos = uniqueNumbers([...existing.box_nos, Number(packBox.box_no)]);
      existing.box_labels = uniqueStrings([
        ...existing.box_labels,
        String(packBox.box_label ?? ""),
      ]);
      existing.box_codes = uniqueStrings([
        ...existing.box_codes,
        String(packBox.box_code ?? ""),
      ]);

      existing.box_details = mergeBoxDetails(existing.box_details, [
        {
          box_id: Number(packBox.id),
          box_no: Number(packBox.box_no),
          box_label: String(packBox.box_label ?? ""),
          box_code: String(packBox.box_code ?? ""),
          qty: Number(item.quantity ?? 0),
        },
      ]);

      map.set(goodsOutItemId, existing);
    }
  }

  return map;
}

function groupItemsBySkuAndLot(
  outbounds: OdooOutboundFormatter[],
  boxes: PackBoxWithItems[],
): GroupedPackProductItemFormatter[] {
  const map = new Map<string, GroupedPackProductItemFormatter>();
  const itemBoxMap = buildItemBoxMap(boxes);

  for (const outbound of outbounds ?? []) {
    for (const item of outbound.items ?? []) {
      const code = item.code ?? null;
      const lotSerial = item.lot_serial ?? null;
      const key = `${normalizeKey(code)}__${normalizeKey(lotSerial)}`;

      const itemBoxInfo = itemBoxMap.get(Number(item.id)) ?? {
        box_ids: [],
        box_nos: [],
        box_labels: [],
        box_codes: [],
        box_details: [],
      };

      if (!map.has(key)) {
        map.set(key, {
          code,
          name: item.name,
          lot_serial: lotSerial,
          qty: Number(item.qty ?? 0),
          pick: Number(item.pick ?? 0),
          pack: Number(item.pack ?? 0),
          status: item.status,
          outbound_ids: uniqueNumbers([Number(item.outbound_id ?? 0)]),
          outbound_nos: uniqueStrings([String(item.outbound_no ?? "")]),
          grouped_item_ids: uniqueNumbers([Number(item.id ?? 0)]),
          box_ids: [...itemBoxInfo.box_ids],
          box_nos: [...itemBoxInfo.box_nos],
          box_labels: [...itemBoxInfo.box_labels],
          box_codes: [...itemBoxInfo.box_codes],
          box_details: [...itemBoxInfo.box_details],
          box_display: buildBoxDisplay(itemBoxInfo.box_details),
          sample_item: item,
        });
        continue;
      }

      const existing = map.get(key)!;
      existing.qty += Number(item.qty ?? 0);
      existing.pick += Number(item.pick ?? 0);
      existing.pack += Number(item.pack ?? 0);
      existing.status = pickGroupedStatus(existing.status, item.status);
      existing.outbound_ids = uniqueNumbers([
        ...existing.outbound_ids,
        Number(item.outbound_id ?? 0),
      ]);
      existing.outbound_nos = uniqueStrings([
        ...existing.outbound_nos,
        String(item.outbound_no ?? ""),
      ]);
      existing.grouped_item_ids = uniqueNumbers([
        ...existing.grouped_item_ids,
        Number(item.id ?? 0),
      ]);
      existing.box_ids = uniqueNumbers([
        ...existing.box_ids,
        ...itemBoxInfo.box_ids,
      ]);
      existing.box_nos = uniqueNumbers([
        ...existing.box_nos,
        ...itemBoxInfo.box_nos,
      ]);
      existing.box_labels = uniqueStrings([
        ...existing.box_labels,
        ...itemBoxInfo.box_labels,
      ]);
      existing.box_codes = uniqueStrings([
        ...existing.box_codes,
        ...itemBoxInfo.box_codes,
      ]);
      existing.box_details = mergeBoxDetails(
        existing.box_details,
        itemBoxInfo.box_details,
      );
      existing.box_display = buildBoxDisplay(existing.box_details);
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    const codeA = String(a.code ?? "");
    const codeB = String(b.code ?? "");
    if (codeA !== codeB) return codeA.localeCompare(codeB);
    return String(a.lot_serial ?? "").localeCompare(String(b.lot_serial ?? ""));
  });
}

function buildPackSummary(input: {
  packProduct: pack_product & {
    outbounds?: Array<{
      outbound?: (outbound & {
        goods_outs?: (goods_out_item & {
          barcode_ref?: barcode | null;
          boxes?: Array<{
            box: box;
            quantity: number | null;
            deleted_at?: Date | null;
          }>;
        })[];
      }) | null;
    }>;
    boxes?: Array<
      pack_product_box & {
        items?: Array<
          pack_product_box_item & {
            goods_out_item?: goods_out_item | null;
          }
        >;
      }
    >;
  };
}) {
  const { packProduct } = input;

  const boxes = Array.isArray(packProduct.boxes) ? packProduct.boxes : [];
  const outbounds = Array.isArray(packProduct.outbounds) ? packProduct.outbounds : [];

  const allItems = outbounds.flatMap((row) =>
    (row.outbound?.goods_outs ?? []).map((item) => ({
      qty: Number(item.qty ?? 0),
      pack: Number(item.pack ?? 0),
    })),
  );

  const maxBox = Number(packProduct.max_box ?? 0);

  const distinctBoxNos = sortNumberAsc(
    Array.from(
      new Set(
        boxes
          .map((b) => Number(b.box_no))
          .filter((n) => Number.isFinite(n) && n > 0),
      ),
    ) as number[],
  );

  const openBoxes = boxes.filter(
    (b) => String(b.status ?? "").toLowerCase() === "open",
  );
  const closedBoxes = boxes.filter(
    (b) => String(b.status ?? "").toLowerCase() === "closed",
  );

  const missingBoxNos: number[] = [];
  for (let i = 1; i <= maxBox; i++) {
    if (!distinctBoxNos.includes(i)) missingBoxNos.push(i);
  }

  const completedItems = allItems.filter(
    (item) => item.qty > 0 && item.pack >= item.qty,
  );
  const incompleteItems = allItems.filter(
    (item) => item.qty > 0 && item.pack < item.qty,
  );

  const totalQty = allItems.reduce((sum, x) => sum + x.qty, 0);
  const totalPack = allItems.reduce((sum, x) => sum + x.pack, 0);

  const progressPercent =
    totalQty > 0 ? Math.min(100, Math.round((totalPack / totalQty) * 100)) : 0;

  return {
    total_outbounds: outbounds.length,
    total_items: allItems.length,
    completed_items: completedItems.length,
    incomplete_items: incompleteItems.length,
    total_qty: totalQty,
    total_pack: totalPack,
    progress_percent: progressPercent,
    total_boxes: boxes.length,
    distinct_box_count: distinctBoxNos.length,
    max_box: maxBox,
    open_box_count: openBoxes.length,
    closed_box_count: closedBoxes.length,
    missing_box_nos: missingBoxNos,
    can_finalize:
      openBoxes.length === 0 &&
      missingBoxNos.length === 0 &&
      incompleteItems.length === 0,
  };
}

export function formatPackProduct(
  row: pack_product & {
    outbounds?: Array<{
      outbound?: (outbound & {
        goods_outs?: (goods_out_item & {
          deleted_at?: Date | null;
          barcode_ref?: barcode | null;
          boxes?: any[];
          barcode_text?: string | null;
          location_picks?: Array<{
            location_id: number;
            qty_pick: number;
            location?: {
              id: number;
              full_name: string;
            } | null;
          }>;
        })[];
        department_code?: string | null;
        department_raw?: string | null;
      }) | null;
    }>;
    boxes?: Array<
      pack_product_box & {
        items?: Array<
          pack_product_box_item & {
            goods_out_item?: goods_out_item | null;
          }
        >;
      }
    >;
  },
): PackProductFormatter {
  const formattedOutbounds: OdooOutboundFormatter[] = (row.outbounds ?? [])
    .map((x) => x.outbound)
    .filter(Boolean)
    .map((ob) => formatOdooOutbound(ob as any));

  const formattedBoxes: PackProductBoxFormatter[] = (row.boxes ?? []).map(
    (packBox) => ({
      id: packBox.id,
      box_no: packBox.box_no,
      box_max: packBox.box_max,
      box_label: packBox.box_label,
      box_code: packBox.box_code,
      status: packBox.status,
      created_at: packBox.created_at.toISOString(),
      updated_at: packBox.updated_at ? packBox.updated_at.toISOString() : null,
      items: (packBox.items ?? []).map((item) => ({
        id: item.id,
        goods_out_item_id: item.goods_out_item_id,
        quantity: item.quantity,
        goods_out_item: item.goods_out_item
          ? {
              id: item.goods_out_item.id,
              outbound_id: item.goods_out_item.outbound_id,
              code: item.goods_out_item.code ?? null,
              name: item.goods_out_item.name,
              lot_serial: item.goods_out_item.lot_serial ?? null,
              qty: item.goods_out_item.qty ?? null,
              pick: item.goods_out_item.pick,
              pack: item.goods_out_item.pack,
              status: item.goods_out_item.status,
            }
          : null,
      })),
    }),
  );

  const groupedItems = groupItemsBySkuAndLot(
    formattedOutbounds,
    (row.boxes ?? []) as PackBoxWithItems[],
  );

  return {
    id: row.id,
    name: row.name,
    scan_prefix: row.scan_prefix,
    max_box: row.max_box,
    status: row.status,
    batch_name: row.batch_name ?? null,
    remark: row.remark ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at ? row.updated_at.toISOString() : null,
    outbounds: formattedOutbounds,
    grouped_items: groupedItems,
    boxes: formattedBoxes,
    summary: buildPackSummary({ packProduct: row }),
  };
}