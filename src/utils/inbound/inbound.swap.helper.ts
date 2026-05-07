import { prisma } from "../../lib/prisma";
import { Prisma } from "@prisma/client";
import { badRequest } from "../appError";
import { NormalizedInboundItem } from "./inbound.normalize.helper";
import { swapItemKey } from "./inbound.key.helper";
import { buildWmsGoodsExpMap, resolveInboundExp } from "./inbound.wms.helper";

export async function handleSwapTransfer(input: {
  picking_id: any;
  number: string;
  location_id: any;
  location: any;
  location_dest_id: any;
  location_dest: any;
  location_dest_owner: any;
  location_dest_owner_display?: any;
  department_id: any;
  department: any;
  reference: any;
  origin: any;
  mergedItems: NormalizedInboundItem[];
}) {
  const {
    picking_id,
    number,
    location_id,
    location,
    location_dest_id,
    location_dest,
    location_dest_owner,
    location_dest_owner_display,
    department_id,
    department,
    reference,
    origin,
    mergedItems,
  } = input;

  const convertedReference =
    typeof reference === "boolean"
      ? reference
        ? "true"
        : null
      : normalizeNullableText(reference);

  const convertedOrigin =
    typeof origin === "string" ? origin : origin ? String(origin) : null;

  const header = await prisma.$transaction(async (tx) => {
    const masterLocation = await upsertSwapLocationMasterFromOdoo(tx, {
      location_dest_id,
      location_dest,
      location_dest_owner,
      location_dest_owner_display,
    });

    let localDepartmentId: number | null = null;
    const deptOdooId = toNullableInt(department_id);

    if (deptOdooId) {
      const deptRow = await tx.department.findFirst({
        where: { odoo_id: deptOdooId as any },
        select: { id: true },
      });

      if (deptRow) {
        localDepartmentId = deptRow.id;
      }
    }

    const existingHeader = await tx.swap.findFirst({
      where: {
        no: number,
        deleted_at: null,
      },
      select: { id: true },
    });

    const headerData: any = {
      no: number,
      name: number,
      picking_id: toNullableInt(picking_id),
      odoo_location_id: toNullableInt(location_dest_id),
      source_location_id: toNullableInt(location_id),
      source_location: normalizeNullableText(location),
      location_id: masterLocation?.id ?? null,
      location_name:
        masterLocation?.full_name ?? String(location_dest_owner ?? "").trim(),
      department_id: localDepartmentId,
      reference: convertedReference,
      origin: convertedOrigin,
      status: "pending",
      remark:
        normalizeNullableText(location_dest_owner_display) ??
        "Auto upsert from Odoo",
      updated_at: new Date(),
      deleted_at: null,
    };

    const swapHeader = existingHeader
      ? await tx.swap.update({
          where: { id: existingHeader.id },
          data: headerData,
        })
      : await tx.swap.create({
          data: headerData,
        });

    const existingItems = await tx.swap_item.findMany({
      where: {
        swap_id: swapHeader.id,
        deleted_at: null,
      },
      select: {
        id: true,
        odoo_line_key: true,
        product_id: true,
        lot_serial: true,
      },
    });

    const existingByOdooLineKey = new Map<
      string,
      (typeof existingItems)[number]
    >();
    const existingByProductLot = new Map<
      string,
      (typeof existingItems)[number]
    >();

    for (const row of existingItems) {
      if (row.odoo_line_key) {
        existingByOdooLineKey.set(row.odoo_line_key, row);
      }

      existingByProductLot.set(
        swapItemKey({
          product_id: row.product_id ?? null,
          lot_serial: row.lot_serial ?? null,
        }),
        row,
      );
    }

    const wmsExpMap = await buildWmsGoodsExpMap(tx, mergedItems);

    for (let i = 0; i < mergedItems.length; i++) {
      const item = mergedItems[i];

      if (item.product_id == null) {
        throw badRequest(`Odoo item missing product_id (swap: ${number})`);
      }

      const finalSeq = item.sequence ?? i + 1;
      const lineKey = `${number}-${finalSeq}`;
      const productLotKey = swapItemKey({
        product_id: item.product_id,
        lot_serial: item.lot_serial ?? null,
      });

      const existing =
        existingByOdooLineKey.get(lineKey) ??
        existingByProductLot.get(productLotKey);

      const itemData: any = {
        source_sequence: finalSeq,
        odoo_line_key: lineKey,
        product_id: item.product_id,
        code: item.code ?? "",
        name: item.name ?? null,
        unit: item.unit ?? null,
        tracking: item.tracking ?? null,
        lot_id: item.lot_id ?? null,
        lot_serial: item.lot_serial ?? "",
        barcode_text: item.barcode_text ?? null,
        expiration_date: resolveInboundExp(item, wmsExpMap),
        system_qty: Number(item.qty ?? 0),
        updated_at: new Date(),
        deleted_at: null,
      };

      if (existing?.id) {
        await tx.swap_item.update({
          where: { id: existing.id },
          data: itemData,
        });
      } else {
        await tx.swap_item.create({
          data: {
            swap_id: swapHeader.id,
            executed_qty: 0,
            ...itemData,
          },
        });
      }
    }

    return swapHeader;
  });

  return prisma.swap.findUnique({
    where: { id: header.id },
    include: {
      location: true,
      department: true,
      swapItems: {
        where: { deleted_at: null },
        orderBy: { source_sequence: "asc" },
      },
    },
  });
}

export async function upsertSwapLocationMasterFromOdoo(
  tx: Prisma.TransactionClient,
  input: {
    location_dest_id: any;
    location_dest: any;
    location_dest_owner: any;
    location_dest_owner_display?: any;
  },
) {
  const odooLocationId = toNullableInt(input.location_dest_id);
  if (!odooLocationId) {
    throw badRequest("BOR/BOS transfer ต้องมี location_dest_id");
  }

  const lockNo = extractBorrowLockFromLocation(input.location_dest);
  if (!lockNo) {
    throw badRequest(
      `location_dest ไม่ใช่ BOR/BOS ที่รองรับ: ${String(input.location_dest ?? "-")}`,
    );
  }

  const fullName = normalizeNullableText(input.location_dest_owner);
  if (!fullName) {
    throw badRequest("BOR/BOS transfer ต้องมี location_dest_owner");
  }

  const building = await tx.building.findFirst({
    where: { short_name: "BOR/BOS" as any },
    select: { id: true },
  });

  if (!building) {
    throw badRequest('ไม่พบ building ที่ short_name = "BOR/BOS"');
  }

  const zone = await tx.zone.findFirst({
    where: { short_name: "F01" as any },
    select: { id: true },
  });

  if (!zone) {
    throw badRequest('ไม่พบ zone ที่ short_name = "F01"');
  }

  const remarkParts = [
    "Auto upsert from Odoo BOR/BOS transfer",
    normalizeNullableText(input.location_dest),
    normalizeNullableText(input.location_dest_owner_display),
  ].filter(Boolean);

  const existing = await tx.location.findFirst({
    where: { odoo_id: odooLocationId },
    select: { id: true },
  });

  if (existing) {
    await tx.location.update({
      where: { id: existing.id },
      data: {
        full_name: fullName,
        building_id: building.id,
        zone_id: zone.id,
        lock_no: lockNo,
        location_code: normalizeNullableText(input.location_dest),
        status: "Activate",
        remark: remarkParts.join(" | "),
        ncr_check: false,
        deleted_at: null,
        updated_at: new Date(),
      },
    });

    return tx.location.findUnique({
      where: { id: existing.id },
      select: {
        id: true,
        odoo_id: true,
        full_name: true,
        lock_no: true,
        building_id: true,
        zone_id: true,
      },
    });
  }

  return tx.location.create({
    data: {
      odoo_id: odooLocationId,
      full_name: fullName,
      building_id: building.id,
      zone_id: zone.id,
      lock_no: lockNo,
      location_code: normalizeNullableText(input.location_dest),
      status: "ACTIVE",
      remark: remarkParts.join(" | "),
      ncr_check: false,
    },
    select: {
      id: true,
      odoo_id: true,
      full_name: true,
      lock_no: true,
      building_id: true,
      zone_id: true,
    },
  });
}

export function isBorrowStoreTransferLike(input: {
  location?: any;
  location_dest?: any;
  location_dest_owner?: any;
}) {
  const srcLock = extractBorrowLockFromLocation(input.location);
  const destLock = extractBorrowLockFromLocation(input.location_dest);
  const owner = String(input.location_dest_owner ?? "").trim();

  return Boolean(srcLock && destLock && owner);
}

export function extractBorrowLockFromLocation(
  value: any,
): "BOR" | "BOS" | null {
  const s = String(value ?? "")
    .trim()
    .toUpperCase();

  const m = s.match(/^WH\/X?(BOR|BOS)(?:\/|$)/i);
  if (!m) return null;

  const code = String(m[1] ?? "").toUpperCase();
  return code === "BOR" || code === "BOS" ? code : null;
}

export function normalizeNullableText(v: any): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

export function toNullableInt(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
