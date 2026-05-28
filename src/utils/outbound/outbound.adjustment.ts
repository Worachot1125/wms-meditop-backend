import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";

async function resolveAdjustmentItemExp(
  tx: Prisma.TransactionClient,
  item: {
    product_id: number | null;
    lot_id: number | null;
    lot_serial: string | null;
    exp: Date | null;
  },
) {
  if (item.exp) return item.exp;
  if (typeof item.product_id !== "number") return null;

  if (typeof item.lot_id === "number") {
    const row = await tx.wms_mdt_goods.findFirst({
      where: {
        product_id: item.product_id,
        lot_id: item.lot_id,
      },
      select: {
        expiration_date: true,
      },
      orderBy: {
        id: "desc",
      },
    });

    if (row?.expiration_date) return row.expiration_date;
  }

  const lotSerial = String(item.lot_serial ?? "").trim();

  if (lotSerial) {
    const row = await tx.wms_mdt_goods.findFirst({
      where: {
        product_id: item.product_id,
        lot_name: lotSerial,
      },
      select: {
        expiration_date: true,
      },
      orderBy: {
        id: "desc",
      },
    });

    if (row?.expiration_date) return row.expiration_date;
  }

  return null;
}

export async function createCompletedAutoAdjustmentFromTransfer(
  tx: Prisma.TransactionClient,
  input: {
    no: string;
    picking_id?: number | null;
    location_id?: number | null;
    location?: string | null;
    location_dest_id?: number | null;
    location_dest?: string | null;
    location_owner?: string | null;
    location_owner_display?: string | null;
    location_dest_owner?: string | null;
    location_dest_owner_display?: string | null;
    department_id?: string | null;
    department?: string | null;
    reference?: string | null;
    status?: "completed" | "waiting";
    waiting_reason?: string | null;
    origin?: string | null;
    type: string;
    items: Array<{
      sequence: number | null;
      product_id: number | null;
      code: string | null;
      name: string | null;
      unit: string | null;
      tracking: string | null;
      lot_id: number | null;
      lot_serial: string | null;
      qty: number;
      exp: Date | null;
      barcode_payload?: string | null;
    }>;
  },
) {
  const existing = await tx.adjustment.findFirst({
    where: { no: input.no, deleted_at: null },
    select: { id: true },
  });

  let adjustmentId: number;

  if (existing) {
    const updated = await tx.adjustment.update({
      where: { id: existing.id },
      data: {
        inventory_id: null,
        picking_id: input.picking_id ?? null,
        picking_no: input.no,
        department_id: input.department_id ?? null,
        department: input.department ?? "",
        reference: input.reference ?? null,
        origin: input.origin ?? null,
        level: "post-process",
        type: input.type,
        status: input.status ?? "completed",
        is_system_generated: true,
        date: new Date(),
        updated_at: new Date(),
      },
      select: { id: true },
    });

    adjustmentId = updated.id;

    await tx.adjustment_item.updateMany({
      where: {
        adjustment_id: adjustmentId,
        deleted_at: null,
      },
      data: {
        deleted_at: new Date(),
        updated_at: new Date(),
      } as any,
    });
  } else {
    const created = await tx.adjustment.create({
      data: {
        no: input.no,
        inventory_id: null,
        picking_id: input.picking_id ?? null,
        picking_no: input.no,
        department_id: input.department_id ?? null,
        department: input.department ?? "",
        reference: input.reference ?? null,
        origin: input.origin ?? null,
        level: "post-process",
        type: input.type,
        status: input.status ?? "completed",
        is_system_generated: true,
        date: new Date(),
      },
      select: { id: true },
    });

    adjustmentId = created.id;
  }

  if (input.items.length > 0) {
    const itemRows = await Promise.all(
      input.items.map(async (item) => {
        const resolvedExp = await resolveAdjustmentItemExp(tx, {
          product_id: item.product_id,
          lot_id: item.lot_id,
          lot_serial: item.lot_serial,
          exp: item.exp ?? null,
        });

        return {
          adjustment_id: adjustmentId,
          sequence: item.sequence,
          product_id: item.product_id,
          code: item.code,
          name: item.name ?? "",
          unit: item.unit ?? "",
          location_id: input.location_id ?? null,
          location: input.location_owner ?? input.location ?? null,

          location_owner: input.location_owner ?? null,
          location_owner_display: input.location_owner_display ?? null,

          location_dest_id: input.location_dest_id ?? null,
          location_dest: input.location_dest ?? null,

          location_dest_owner: input.location_dest_owner ?? null,
          location_dest_owner_display:
            input.location_dest_owner_display ?? null,

          tracking: item.tracking ?? null,
          lot_id: item.lot_id ?? null,
          lot_serial: item.lot_serial ?? null,
          qty: item.qty,
          exp: resolvedExp,
          barcode_payload: item.barcode_payload ?? null,
          qty_pick: item.qty,
        };
      }),
    );

    await tx.adjustment_item.createMany({
      data: itemRows,
    });
  }
}

export type RawLotAdjustmentLine = {
  lot_id?: number | string | null;
  lot_serial?: string | null;
  qty?: number | string | null;
};

export type NormalizedLotAdjustmentLine = {
  lot_id: number | null;
  lot_serial: string | null;
  qty: number;
};

export type GoodsOutItemRowForAdjustment = {
  id: number;
  outbound_id: number;
  sequence: number | null;
  product_id: number | null;
  code: string | null;
  name: string | null;
  unit: string | null;
  tracking: string | null;
  lot_id: number | null;
  lot_serial: string | null;
  qty: number | null;
  pick: number | null;
  pack: number | null;
  status: string | null;
  barcode_text: string | null;
  source_item_id: number | null;
  lot_adjustment_id: number | null;
  is_split_generated: boolean | null;
  updated_at: Date | null;
};

export async function enrichLotLinesWithResolvedLotId(args: {
  product_id: number | null | undefined;
  lines: Array<{
    lot_id: number | null;
    lot_serial: string | null;
    qty: number;
  }>;
}) {
  const productId =
    typeof args.product_id === "number" ? args.product_id : null;

  if (!productId) {
    return args.lines;
  }

  const missingLotSerials = Array.from(
    new Set(
      args.lines
        .filter((line) => line.lot_id == null && line.lot_serial)
        .map((line) => String(line.lot_serial).trim())
        .filter(Boolean),
    ),
  );

  if (missingLotSerials.length === 0) {
    return args.lines;
  }

  const goodsRows = await prisma.wms_mdt_goods.findMany({
    where: {
      product_id: productId,
      lot_name: { in: missingLotSerials },
    },
    select: {
      id: true,
      lot_id: true,
      lot_name: true,
      product_id: true,
    },
    orderBy: { id: "desc" },
  });

  const lotIdByLotName = new Map<string, number | null>();

  for (const row of goodsRows) {
    const key = String(row.lot_name ?? "").trim();
    if (!key) continue;

    if (!lotIdByLotName.has(key)) {
      lotIdByLotName.set(key, row.lot_id ?? null);
    }
  }

  return args.lines.map((line) => {
    if (line.lot_id != null) return line;

    const lotSerial = String(line.lot_serial ?? "").trim();
    const resolvedLotId = lotIdByLotName.get(lotSerial) ?? null;

    return {
      ...line,
      lot_id: resolvedLotId,
    };
  });
}
