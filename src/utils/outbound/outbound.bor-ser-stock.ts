import { Prisma } from "@prisma/client";
import { badRequest } from "../appError";
import type {
  BorSerInternalLine,
  BorSerStockTable,
  DeductMergedItem,
  ReplaceMergedItem,
} from "./outbound.type";
import {
  normalizeExpDate,
  sameExpDate,
  toDateOnlyKey,
} from "./outbound.parse";

export const BOR_SER_DEDUCT_TYPES = new Set(["GA", "BOS", "SV", "BOCR/DO"]);
export const BOR_SER_REPLACE_TYPES = new Set(["EX", "BOA"]);

export function resolveBorSerTargetFromText(v: string | null | undefined) {
  const s = String(v ?? "").toUpperCase();
  if (s.includes("BOR")) return "BOR" as const;
  if (s.includes("SER")) return "SER" as const;
  return null;
}

export async function resolveBorSerTargetFromDest(
  tx: Prisma.TransactionClient,
  transfer: { location_dest?: string | null; location_dest_id?: number | null },
) {
  const direct = resolveBorSerTargetFromText(transfer.location_dest);
  if (direct) return direct;

  if (typeof transfer.location_dest_id === "number") {
    const loc = await tx.location.findUnique({
      where: { id: transfer.location_dest_id },
      select: { full_name: true, deleted_at: true },
    });
    if (loc && !loc.deleted_at) {
      return resolveBorSerTargetFromText(loc.full_name);
    }
  }

  return null;
}

export async function resolveBorSerTargetFromSource(
  tx: Prisma.TransactionClient,
  transfer: { location?: string | null; location_id?: number | null },
) {
  const direct = resolveBorSerTargetFromText(transfer.location);
  if (direct) return direct;

  if (typeof transfer.location_id === "number") {
    const loc = await tx.location.findUnique({
      where: { id: transfer.location_id },
      select: { full_name: true, deleted_at: true },
    });

    if (loc && !loc.deleted_at) {
      return resolveBorSerTargetFromText(loc.full_name);
    }
  }

  return null;
}

export async function resolveExpFromWmsMdtGoods(
  tx: Prisma.TransactionClient,
  input: {
    product_id: number | null | undefined;
    lot_id?: number | null | undefined;
    lot_serial?: string | null | undefined;
    exp?: Date | null | undefined;
  },
): Promise<Date | null> {
  const inputExp = normalizeExpDate(input.exp ?? null);
  if (inputExp) return inputExp;

  if (typeof input.product_id !== "number") return null;

  if (typeof input.lot_id === "number") {
    const row = await tx.wms_mdt_goods.findFirst({
      where: {
        product_id: input.product_id,
        lot_id: input.lot_id,
      },
      select: {
        expiration_date: true,
      },
      orderBy: { lot_id: "desc" },
    });

    const resolved = normalizeExpDate(row?.expiration_date ?? null);
    if (resolved) return resolved;
  }

  const lotName = String(input.lot_serial ?? "").trim();
  if (lotName) {
    const row = await tx.wms_mdt_goods.findFirst({
      where: {
        product_id: input.product_id,
        lot_name: lotName,
      },
      select: {
        expiration_date: true,
      },
      orderBy: { lot_id: "desc" },
    });

    const resolved = normalizeExpDate(row?.expiration_date ?? null);
    if (resolved) return resolved;
  }

  return null;
}

export async function resolveEffectiveExp(
  tx: Prisma.TransactionClient,
  input: {
    product_id: number | null | undefined;
    lot_id?: number | null | undefined;
    lot_serial?: string | null | undefined;
    exp?: Date | null | undefined;
  },
): Promise<Date | null> {
  return (
    normalizeExpDate(input.exp ?? null) ??
    (await resolveExpFromWmsMdtGoods(tx, input)) ??
    null
  );
}

export function buildBorSerWhereBase(input: {
  product_id: number | null | undefined;
  lot_id?: number | null | undefined;
  lot_serial?: string | null | undefined;
  location_name?: string | null | undefined;
}) {
  const where: any = {
    product_id: input.product_id ?? null,
    lot_name: input.lot_serial ?? null,
  };

  if (typeof input.lot_id === "number") {
    where.lot_id = input.lot_id;
  }

  if (input.location_name != null) {
    where.location_name = input.location_name;
  }

  return where;
}

export async function decrementBorSerStocksForGaBosSv(
  tx: Prisma.TransactionClient,
  args: {
    outType: string;
    transfer: {
      no: string;
      location_id?: number | null;
      location?: string | null;
      location_dest_id?: number | null;
      location_dest?: string | null;
    };
    mergedItems: DeductMergedItem[];
  },
) {
  const { outType, transfer, mergedItems } = args;

  const target =
    (await resolveBorSerTargetFromSource(tx, {
      location: transfer.location ?? null,
      location_id: transfer.location_id ?? null,
    })) ??
    (await resolveBorSerTargetFromDest(tx, {
      location_dest: transfer.location_dest ?? null,
      location_dest_id: transfer.location_dest_id ?? null,
    }));

  if (!target) {
    throw badRequest(
      `type (${outType}) ต้องมี BOR/SER ใน location หรือ location_dest (ตอนนี้ location=${transfer.location ?? "-"} location_id=${transfer.location_id ?? "null"} location_dest=${transfer.location_dest ?? "-"} location_dest_id=${transfer.location_dest_id ?? "null"})`,
    );
  }

  for (const it of mergedItems) {
    if (!it.product_id) continue;

    const qty = Math.floor(Number(it.qty ?? 0));
    if (!Number.isFinite(qty) || qty <= 0) continue;

    const effectiveExp = await resolveEffectiveExp(tx, {
      product_id: it.product_id,
      lot_id: it.lot_id ?? null,
      lot_serial: it.lot_serial ?? null,
      exp: it.exp ?? null,
    });

    const whereBase = buildBorSerWhereBase({
      product_id: it.product_id,
      lot_id: it.lot_id ?? null,
      lot_serial: it.lot_serial ?? null,
    });

    const model = target === "SER" ? tx.ser_stock : tx.bor_stock;
    const stockName = target === "SER" ? "ser_stock" : "bor_stock";

    const rows = await (model as any).findMany({
      where: whereBase,
      select: {
        id: true,
        quantity: true,
        expiration_date: true,
        lot_id: true,
        lot_name: true,
      },
      orderBy: { id: "desc" },
    });

    const row =
      rows.find((r: any) => sameExpDate(r.expiration_date, effectiveExp)) ??
      null;

    if (!row) {
      throw badRequest(
        `ไม่พบ ${stockName} สำหรับตัด (product_id=${it.product_id}, lot_id=${it.lot_id ?? "null"}, lot_serial=${it.lot_serial ?? "null"}, exp=${toDateOnlyKey(effectiveExp) ?? "null"})`,
      );
    }

    const current = Number(row.quantity ?? 0);
    if (current < qty) {
      throw badRequest(
        `${stockName} ไม่พอ (need=${qty}, have=${current}) product_id=${it.product_id} lot_id=${it.lot_id ?? "null"} lot_serial=${it.lot_serial ?? "null"} exp=${toDateOnlyKey(effectiveExp) ?? "null"}`,
      );
    }

    const remain = current - qty;
    if (remain <= 0) {
      await (model as any).delete({ where: { id: row.id } });
    } else {
      await (model as any).update({
        where: { id: row.id },
        data: {
          quantity: { decrement: new Prisma.Decimal(qty) },
          updated_at: new Date(),
        },
      });
    }
  }
}

export async function replaceBorSerStocksForExBoa(
  tx: Prisma.TransactionClient,
  args: {
    outType: string;
    transfer: {
      no: string;
      location_dest_id: number | null;
      location_dest: string | null;
      department_id?: string | null;
      department?: string | null;
      location_owner?: string | null;
      location_owner_display?: string | null;
      location_dest_owner?: string | null;
      location_dest_owner_display?: string | null;
    };
    mergedItems: ReplaceMergedItem[];
  },
) {
  const { outType, transfer, mergedItems } = args;

  const target = await resolveBorSerTargetFromDest(tx, {
    location_dest: transfer.location_dest,
    location_dest_id: transfer.location_dest_id,
  });

  if (!target) {
    throw badRequest(
      `type (${outType}) ต้องมี BOR/SER ใน location_dest หรือ location_dest_id (ตอนนี้ location_dest=${transfer.location_dest ?? "-"} location_dest_id=${transfer.location_dest_id ?? "null"})`,
    );
  }

  const now = new Date();

  for (const it of mergedItems) {
    if (!it.product_id) continue;

    const qty = Number(it.qty ?? 0);
    if (!Number.isFinite(qty)) continue;

    const finalQty = new Prisma.Decimal(qty);
    const shouldDelete = Number(qty) <= 0;

    const effectiveExp = await resolveEffectiveExp(tx, {
      product_id: it.product_id,
      lot_id: it.lot_id ?? null,
      lot_serial: it.lot_serial ?? null,
      exp: it.exp ?? null,
    });

    const whereBase = buildBorSerWhereBase({
      product_id: it.product_id,
      lot_id: it.lot_id ?? null,
      lot_serial: it.lot_serial ?? null,
    });

    const model = target === "SER" ? tx.ser_stock : tx.bor_stock;

    const rows = await (model as any).findMany({
      where: whereBase,
      select: {
        id: true,
        expiration_date: true,
        lot_id: true,
        lot_name: true,
      },
      orderBy: { id: "desc" },
    });

    const row =
      rows.find((r: any) => sameExpDate(r.expiration_date, effectiveExp)) ??
      null;

    if (shouldDelete) {
      if (row?.id) await (model as any).delete({ where: { id: row.id } });
      continue;
    }

    if (row?.id) {
      await (model as any).update({
        where: { id: row.id },
        data: {
          snapshot_date: now,
          no: transfer.no ?? null,
          quantity: finalQty,
          updated_at: now as any,
          expiration_date: effectiveExp,
          department_id: transfer.department_id ?? null,
          department_name: transfer.department ?? null,
          location_owner: transfer.location_owner ?? null,
          location_owner_display: transfer.location_owner_display ?? null,
          location_dest_owner: transfer.location_dest_owner ?? null,
          location_dest_owner_dispalay:
            transfer.location_dest_owner_display ?? null,
        } as any,
      });
    } else {
      await (model as any).create({
        data: {
          snapshot_date: now,
          no: transfer.no ?? null,
          product_id: it.product_id,
          product_code: it.code ?? null,
          product_name: it.name ?? null,
          unit: it.unit ?? null,
          location_id: transfer.location_dest_id ?? null,
          location_name: transfer.location_dest ?? null,
          department_id: transfer.department_id ?? null,
          department_name: transfer.department ?? null,
          location_owner: transfer.location_owner ?? null,
          location_owner_display: transfer.location_owner_display ?? null,
          location_dest_owner: transfer.location_dest_owner ?? null,
          location_dest_owner_dispalay:
            transfer.location_dest_owner_display ?? null,
          lot_id: it.lot_id ?? null,
          lot_name: it.lot_serial ?? null,
          expiration_date: effectiveExp,
          product_last_modified_date: null,
          source: "wms",
          quantity: finalQty,
          active: true,
        } as any,
      });
    }
  }
}

export async function decrementSourceBorSerStockByLocationId(
  tx: Prisma.TransactionClient,
  args: {
    table: BorSerStockTable;
    location_id: number | null;
    location_name: string;
    item: BorSerInternalLine;
  },
) {
  const { table, location_name, item } = args;

  if (!item.product_id) {
    throw badRequest("item.product_id is required");
  }

  const needQty = Math.max(0, Math.floor(Number(item.qty ?? 0)));
  if (needQty <= 0) return;

  const effectiveExp = await resolveEffectiveExp(tx, {
    product_id: item.product_id,
    lot_id: item.lot_id ?? null,
    lot_serial: item.lot_serial ?? null,
    exp: item.exp ?? null,
  });

  const baseWhere: any = {
    product_id: item.product_id,
    lot_id: item.lot_id ?? null,
    location_name,
  };

  const model = table === "SER" ? tx.ser_stock : tx.bor_stock;
  const stockName = table === "SER" ? "ser_stock" : "bor_stock";

  const rows = await (model as any).findMany({
    where: baseWhere,
    select: {
      id: true,
      quantity: true,
      expiration_date: true,
      lot_id: true,
      location_name: true,
    },
    orderBy: { id: "desc" },
  });

  const row =
    rows.find((x: any) => sameExpDate(x.expiration_date, effectiveExp)) ??
    null;

  if (!row) {
    throw badRequest(
      `ไม่พบ ${stockName} ต้นทาง (location_name=${location_name}, product_id=${item.product_id}, lot_id=${item.lot_id ?? "null"}, exp=${toDateOnlyKey(effectiveExp) ?? "null"})`,
    );
  }

  const currentQty = Number(row.quantity ?? 0);
  if (currentQty < needQty) {
    throw badRequest(
      `${stockName} ต้นทางไม่พอ (location_name=${location_name}, product_id=${item.product_id}, lot_id=${item.lot_id ?? "null"}, need=${needQty}, have=${currentQty}, exp=${toDateOnlyKey(effectiveExp) ?? "null"})`,
    );
  }

  const remain = currentQty - needQty;
  if (remain <= 0) {
    await (model as any).delete({ where: { id: row.id } });
  } else {
    await (model as any).update({
      where: { id: row.id },
      data: {
        quantity: { decrement: new Prisma.Decimal(needQty) },
        updated_at: new Date(),
      } as any,
    });
  }
}

export async function incrementDestBorSerStockByLocationId(
  tx: Prisma.TransactionClient,
  args: {
    table: BorSerStockTable;
    no: string;
    location_id: number | null;
    location_name: string;
    department_id?: string | null;
    department?: string | null;
    location_owner?: string | null;
    location_owner_display?: string | null;
    location_dest_owner?: string | null;
    location_dest_owner_display?: string | null;
    item: BorSerInternalLine;
  },
) {
  const {
    table,
    no,
    location_id,
    location_name,
    department_id,
    department,
    location_owner,
    location_owner_display,
    location_dest_owner,
    location_dest_owner_display,
    item,
  } = args;

  if (!item.product_id) {
    throw badRequest("item.product_id is required");
  }

  const addQty = Math.max(0, Math.floor(Number(item.qty ?? 0)));
  if (addQty <= 0) return;

  const now = new Date();

  const effectiveExp = await resolveEffectiveExp(tx, {
    product_id: item.product_id,
    lot_id: item.lot_id ?? null,
    lot_serial: item.lot_serial ?? null,
    exp: item.exp ?? null,
  });

  const baseWhere: any = {
    product_id: item.product_id,
    lot_id: item.lot_id ?? null,
    location_name,
  };

  const model = table === "SER" ? tx.ser_stock : tx.bor_stock;

  const rows = await (model as any).findMany({
    where: baseWhere,
    select: {
      id: true,
      expiration_date: true,
    },
    orderBy: { id: "desc" },
  });

  const row =
    rows.find((x: any) => sameExpDate(x.expiration_date, effectiveExp)) ??
    null;

  if (row?.id) {
    await (model as any).update({
      where: { id: row.id },
      data: {
        no,
        location_id,
        location_name,
        department_id: department_id ?? null,
        department_name: department ?? null,
        location_owner: location_owner ?? null,
        location_owner_display: location_owner_display ?? null,
        location_dest_owner: location_dest_owner ?? null,
        location_dest_owner_dispalay: location_dest_owner_display ?? null,
        quantity: { increment: new Prisma.Decimal(addQty) },
        expiration_date: effectiveExp,
        updated_at: now,
      } as any,
    });
    return;
  }

  await (model as any).create({
    data: {
      snapshot_date: now,
      no,
      product_id: item.product_id,
      product_code: item.code ?? null,
      product_name: item.name ?? null,
      unit: item.unit ?? null,
      location_id,
      location_name,
      department_id: department_id ?? null,
      department_name: department ?? null,
      location_owner: location_owner ?? null,
      location_owner_display: location_owner_display ?? null,
      location_dest_owner: location_dest_owner ?? null,
      location_dest_owner_dispalay: location_dest_owner_display ?? null,
      lot_id: item.lot_id ?? null,
      lot_name: item.lot_serial ?? null,
      expiration_date: effectiveExp,
      product_last_modified_date: null,
      source: "wms",
      quantity: new Prisma.Decimal(addQty),
      active: true,
    } as any,
  });
}