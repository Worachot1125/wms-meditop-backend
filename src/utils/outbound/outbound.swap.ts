import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { badRequest, notFound } from "../appError";
import type { BorSerInternalLine, MasterLocationLite } from "./outbound.type";
import { normalizeNullableText, toNullableInt } from "./outbound.parse";
import { upsertSwapBorSerLocationByName } from "./outbound.virtual-location";
import {
  decrementSourceBorSerStockByLocationId,
  incrementDestBorSerStockByLocationId,
} from "./outbound.bor-ser-stock";
import { resolveDepartmentShortNameByOdooId } from "./outbound.department";

export function extractBorSerLockFromLocation(
  value: any,
): "BOR" | "BOS" | "SER" | null {
  const s = String(value ?? "")
    .trim()
    .toUpperCase();

  const m = s.match(/^WH\/X?(BOR|BOS|SER)(?:\/|$)/i);
  if (!m) return null;

  const code = String(m[1] ?? "").toUpperCase();
  if (code === "BOR" || code === "BOS" || code === "SER") return code;

  return null;
}

export function resolveBorSerTableFromLock(lock: "BOR" | "BOS" | "SER") {
  return lock === "SER" ? "SER" : "BOR";
}

export function isBorSerInternalTransferLike(input: {
  location?: any;
  location_dest?: any;
  location_owner?: any;
  location_dest_owner?: any;
}) {
  const srcLock = extractBorSerLockFromLocation(input.location);
  const destLock = extractBorSerLockFromLocation(input.location_dest);
  const srcOwner = String(input.location_owner ?? "").trim();
  const destOwner = String(input.location_dest_owner ?? "").trim();

  return Boolean(srcLock && destLock && srcOwner && destOwner);
}

export function isSwapTransferLike(input: {
  location?: any;
  location_dest?: any;
  location_owner?: any;
  location_dest_owner?: any;
}) {
  const srcLock = extractBorSerLockFromLocation(input.location);
  const destLock = extractBorSerLockFromLocation(input.location_dest);
  const srcOwner = String(input.location_owner ?? "").trim();
  const destOwner = String(input.location_dest_owner ?? "").trim();

  return Boolean(srcLock && destLock && srcOwner && destOwner);
}

export async function resolveActiveLocationById(
  tx: Prisma.TransactionClient,
  id: number | null | undefined,
): Promise<MasterLocationLite | null> {
  if (typeof id !== "number") return null;

  const row = await tx.location.findUnique({
    where: { id },
    select: {
      id: true,
      full_name: true,
      deleted_at: true,
    },
  });

  if (!row || row.deleted_at) return null;

  return {
    id: row.id,
    full_name: row.full_name,
  };
}

export async function resolveLocationByFullNameExact(
  tx: Prisma.TransactionClient,
  fullName: string | null | undefined,
): Promise<MasterLocationLite | null> {
  const exact = String(fullName ?? "").trim();
  if (!exact) return null;

  const row = await tx.location.findFirst({
    where: {
      deleted_at: null,
      full_name: exact,
    },
    select: {
      id: true,
      full_name: true,
    },
  });

  if (!row) return null;

  return {
    id: row.id,
    full_name: row.full_name,
  };
}

export async function handleBorSerInternalTransferOutbound(input: {
  no: string;
  picking_id?: any;

  location_id?: any;
  location: any;
  location_dest_id?: any;
  location_dest: any;

  location_owner: any;
  location_owner_display?: any;
  location_dest_owner: any;
  location_dest_owner_display?: any;

  department_id?: any;
  department?: any;
  reference?: any;
  origin?: any;

  mergedItems: BorSerInternalLine[];
}) {
  const {
    no,
    picking_id,
    location_id,
    location,
    location_dest_id,
    location_dest,
    location_owner,
    location_dest_owner,
    department_id,
    reference,
    origin,
    mergedItems,
  } = input;

  const sourceLock = extractBorSerLockFromLocation(location);
  const destLock = extractBorSerLockFromLocation(location_dest);

  if (!sourceLock || !destLock) {
    throw badRequest("location / location_dest ต้องเป็น BOR/BOS/SER");
  }

  const sourceOwner = normalizeNullableText(location_owner);
  const destOwner = normalizeNullableText(location_dest_owner);

  if (!sourceOwner) throw badRequest("กรุณาส่ง location_owner");
  if (!destOwner) throw badRequest("กรุณาส่ง location_dest_owner");

  const convertedReference =
    typeof reference === "boolean"
      ? reference
        ? "true"
        : null
      : normalizeNullableText(reference);

  const convertedOrigin =
    typeof origin === "boolean"
      ? origin
        ? "true"
        : null
      : normalizeNullableText(origin);

  const odooSourceLocationId = toNullableInt(location_id);
  const odooDestLocationId = toNullableInt(location_dest_id);
  const numericPickingId = toNullableInt(picking_id);
  const numericDepartmentId = toNullableInt(department_id);

  const result = await prisma.$transaction(async (tx) => {
    const existingSourceLoc =
      (await resolveActiveLocationById(tx, odooSourceLocationId)) ??
      (await resolveLocationByFullNameExact(tx, sourceOwner));

    let existingDestLoc =
      (await resolveActiveLocationById(tx, odooDestLocationId)) ??
      (await resolveLocationByFullNameExact(tx, destOwner));

    if (!existingDestLoc && destLock) {
      existingDestLoc = await upsertSwapBorSerLocationByName(tx, {
        full_name: destOwner,
        lock: destLock,
        location_code: normalizeNullableText(location_dest),
      });
    }

    const existingSwap = await tx.swap.findFirst({
      where: {
        no,
        deleted_at: null,
      },
      select: { id: true },
    });

    const swapPayload = {
      name: no,
      no,
      picking_id: numericPickingId,

      odoo_location_id: odooSourceLocationId,
      source_location_id: odooSourceLocationId,
      source_location: normalizeNullableText(location),

      location_id: existingSourceLoc?.id ?? null,
      location_name: sourceOwner,

      odoo_location_dest_id: odooDestLocationId,
      dest_location_id: odooDestLocationId,
      dest_location: normalizeNullableText(location_dest),

      location_dest_id: existingDestLoc?.id ?? null,
      location_dest_name: destOwner,

      department_id: numericDepartmentId,
      origin: convertedOrigin,
      reference: convertedReference,

      status: "pending",
      deleted_at: null,
      updated_at: new Date(),
    };

    const swapDoc = existingSwap
      ? await tx.swap.update({
          where: { id: existingSwap.id },
          data: swapPayload,
        })
      : await tx.swap.create({
          data: {
            ...swapPayload,
            created_at: new Date(),
          },
        });

    await tx.swap_item.updateMany({
      where: {
        swap_id: swapDoc.id,
        deleted_at: null,
      },
      data: {
        deleted_at: new Date(),
        updated_at: new Date(),
      },
    });

    if (mergedItems.length > 0) {
      await tx.swap_item.createMany({
        data: mergedItems.map((item, index) => ({
          swap_id: swapDoc.id,
          source_sequence: item.sequence ?? index + 1,
          odoo_line_key: `${no}-${item.sequence ?? index + 1}`,

          product_id: item.product_id ?? null,
          code: item.code ?? null,
          name: item.name ?? null,
          unit: item.unit ?? null,
          tracking: item.tracking ?? null,

          lot_id: item.lot_id ?? null,
          lot_serial: item.lot_serial ?? null,
          barcode_text: item.barcode_text ?? null,
          expiration_date: item.exp ?? null,

          system_qty: Math.max(0, Math.floor(Number(item.qty ?? 0))),
          executed_qty: 0,
        })),
      });
    }

    const applyResult = await applyPendingSwapStockMove(tx, swapDoc.id);

    const finalSwap = await tx.swap.findUnique({
      where: { id: swapDoc.id },
      include: {
        swapItems: {
          where: { deleted_at: null },
          orderBy: { id: "asc" },
        },
      },
    });

    return {
      swap_id: swapDoc.id,
      no,
      source_location_name: sourceOwner,
      dest_location_name: destOwner,
      apply_result: applyResult,
      swap: finalSwap,
    };
  });

  return result;
}

export async function applyPendingSwapStockMove(
  tx: Prisma.TransactionClient,
  swapId: number,
) {
  const swapDoc = await tx.swap.findUnique({
    where: { id: swapId },
    include: {
      swapItems: {
        where: { deleted_at: null },
        orderBy: { id: "asc" },
      },
    },
  });

  if (!swapDoc || swapDoc.deleted_at) {
    throw notFound(`ไม่พบ swap: ${swapId}`);
  }

  const sourceLock = extractBorSerLockFromLocation(swapDoc.source_location);
  const destLock = extractBorSerLockFromLocation(swapDoc.dest_location);

  if (!sourceLock || !destLock) {
    throw badRequest("SWAP ต้องมี source/dest lock เป็น BOR/BOS/SER");
  }

  const sourceTable = resolveBorSerTableFromLock(sourceLock);
  const destTable = resolveBorSerTableFromLock(destLock);

  let existingDestLoc =
    (await resolveActiveLocationById(tx, swapDoc.location_dest_id ?? null)) ??
    (await resolveLocationByFullNameExact(
      tx,
      normalizeNullableText(swapDoc.location_dest_name),
    ));

  if (!existingDestLoc && destLock) {
    existingDestLoc = await upsertSwapBorSerLocationByName(tx, {
      full_name: normalizeNullableText(swapDoc.location_dest_name),
      lock: destLock,
      location_code: normalizeNullableText(swapDoc.dest_location),
    });
  }

  if (!existingDestLoc) {
    await tx.swap.update({
      where: { id: swapDoc.id },
      data: {
        status: "error",
        updated_at: new Date(),
      } as any,
    });

    return {
      processed: false,
      reason: "DEST_LOCATION_NOT_FOUND",
    };
  }

  const sourceLocationName = normalizeNullableText(swapDoc.location_name);
  if (!sourceLocationName) {
    throw badRequest("swap.location_name is required");
  }

  const departmentShortName = await resolveDepartmentShortNameByOdooId(
    tx,
    swapDoc.department_id ?? null,
  );

  const mergedSwapItems: BorSerInternalLine[] = (swapDoc.swapItems ?? []).map(
    (item) => ({
      sequence: item.source_sequence ?? null,
      product_id: item.product_id ?? null,
      code: item.code ?? null,
      name: item.name ?? null,
      unit: item.unit ?? null,
      tracking: item.tracking ?? null,
      lot_id: item.lot_id ?? null,
      lot_serial: item.lot_serial ?? null,
      qty: Math.max(0, Math.floor(Number(item.system_qty ?? 0))),
      barcode_text: item.barcode_text ?? null,
      exp: item.expiration_date ?? null,
    }),
  );

  for (const item of mergedSwapItems) {
    if (!item.product_id) continue;
    if (Number(item.qty ?? 0) <= 0) continue;

    await decrementSourceBorSerStockByLocationId(tx, {
      table: sourceTable,
      location_id: null,
      location_name: sourceLocationName,
      item,
    });

    await incrementDestBorSerStockByLocationId(tx, {
      table: destTable,
      no: String(swapDoc.no ?? ""),
      location_id: existingDestLoc.id,
      location_name: existingDestLoc.full_name,
      department_id:
        swapDoc.department_id != null ? String(swapDoc.department_id) : null,
      department: departmentShortName,

      location_owner: normalizeNullableText(swapDoc.location_name),
      location_owner_display: null,
      location_dest_owner: normalizeNullableText(swapDoc.location_dest_name),
      location_dest_owner_display: null,

      item,
    });
  }

  await tx.swap.update({
    where: { id: swapDoc.id },
    data: {
      status: "done",
      location_dest_id: existingDestLoc.id,
      location_dest_name: existingDestLoc.full_name,
      updated_at: new Date(),
    } as any,
  });

  return {
    processed: true,
    reason: null,
  };
}

export async function retryPendingSwapsByDestFullName(fullName: string) {
  const exact = String(fullName ?? "").trim();
  if (!exact) return;

  const pendingSwaps = await prisma.swap.findMany({
    where: {
      deleted_at: null,
      status: "error",
      location_dest_name: exact,
    },
    select: {
      id: true,
    },
    orderBy: { id: "asc" },
  });

  for (const row of pendingSwaps) {
    await prisma.$transaction(async (tx) => {
      await applyPendingSwapStockMove(tx, row.id);
    });
  }
}