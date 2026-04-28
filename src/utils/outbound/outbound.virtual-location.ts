import type { Prisma } from "@prisma/client";
import { badRequest } from "../appError";
import { normalizeNullableText, toNullableInt } from "./outbound.parse";

export function extractVirtualLockFromLocationDest(value: any): "BOR" | "BOS" | null {
  const s = String(value ?? "")
    .trim()
    .toUpperCase();

  const m = s.match(/^WH\/X?(BOR|BOS)(?:\/|$)/i);
  if (!m) return null;

  const code = String(m[1] ?? "").toUpperCase();
  return code === "BOR" || code === "BOS" ? code : null;
}

export function isVirtualBorrowDest(value: any): boolean {
  return extractVirtualLockFromLocationDest(value) !== null;
}

export async function findOrCreateVirtualBuildingAndZone(
  tx: Prisma.TransactionClient,
) {
  let building = await tx.building.findFirst({
    where: {
      OR: [{ short_name: "BOR/BOS" }, { full_name: "Borrow" }],
    },
    select: { id: true, full_name: true, short_name: true },
  });

  if (!building) {
    building = await tx.building.create({
      data: {
        full_name: "Borrow",
        short_name: "BOR/BOS",
        remark: "Auto created virtual building for BOR/BOS location",
      },
      select: { id: true, full_name: true, short_name: true },
    });
  }

  let zone = await tx.zone.findFirst({
    where: {
      building_id: building.id,
      OR: [{ short_name: "F01" }, { full_name: "F01" }],
    },
    select: { id: true, full_name: true, short_name: true },
  });

  if (!zone) {
    let zoneType = await tx.zone_type.findFirst({
      where: {
        OR: [{ short_name: "NORMAL" }, { full_name: "NORMAL" }],
      },
      select: { id: true },
    });

    if (!zoneType) {
      zoneType = await tx.zone_type.create({
        data: {
          full_name: "NORMAL",
          short_name: "NORMAL",
          remark: "Auto created zone_type for virtual BOR/BOS location",
        },
        select: { id: true },
      });
    }

    zone = await tx.zone.create({
      data: {
        full_name: "F01",
        short_name: "F01",
        building_id: building.id,
        zone_type_id: zoneType.id,
        remark: "Auto created virtual zone for BOR/BOS location",
      },
      select: { id: true, full_name: true, short_name: true },
    });
  }

  return {
    building_id: building.id,
    zone_id: zone.id,
  };
}

export async function upsertVirtualLocationFromOdoo(
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
    throw badRequest("virtual location ต้องมี location_dest_id");
  }

  const lockNo = extractVirtualLockFromLocationDest(input.location_dest);
  if (!lockNo) return null;

  const fullName = normalizeNullableText(input.location_dest_owner);
  if (!fullName) {
    throw badRequest("virtual location ต้องมี location_dest_owner");
  }

  const { building_id, zone_id } = await findOrCreateVirtualBuildingAndZone(tx);

  const remarkParts = [
    "AUTO-VIRTUAL-LOCATION",
    normalizeNullableText(input.location_dest),
    normalizeNullableText(input.location_dest_owner_display),
  ].filter(Boolean);

  const existingByOdoo = await tx.location.findFirst({
    where: { odoo_id: odooLocationId },
    select: {
      id: true,
      full_name: true,
      odoo_id: true,
    },
  });

  if (existingByOdoo) {
    return tx.location.update({
      where: { id: existingByOdoo.id },
      data: {
        full_name: fullName,
        building_id,
        zone_id,
        lock_no: lockNo,
        location_code: normalizeNullableText(input.location_dest),
        status: "Activate",
        remark: remarkParts.join(" | "),
        ncr_check: false,
        deleted_at: null,
        updated_at: new Date(),
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

  const existingByName = await tx.location.findFirst({
    where: {
      full_name: fullName,
      deleted_at: null,
    },
    select: {
      id: true,
      odoo_id: true,
    },
  });

  if (existingByName) {
    return tx.location.update({
      where: { id: existingByName.id },
      data: {
        odoo_id: existingByName.odoo_id ?? odooLocationId,
        full_name: fullName,
        building_id,
        zone_id,
        lock_no: lockNo,
        location_code: normalizeNullableText(input.location_dest),
        status: "Activate",
        remark: remarkParts.join(" | "),
        ncr_check: false,
        deleted_at: null,
        updated_at: new Date(),
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

  return tx.location.create({
    data: {
      odoo_id: odooLocationId,
      full_name: fullName,
      building_id,
      zone_id,
      lock_no: lockNo,
      location_code: normalizeNullableText(input.location_dest),
      status: "Activate",
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

export async function upsertSwapBorSerLocationByName(
  tx: Prisma.TransactionClient,
  input: {
    full_name: string | null | undefined;
    lock: "BOR" | "BOS" | "SER";
    location_code?: string | null | undefined;
  },
) {
  const fullName = normalizeNullableText(input.full_name);
  if (!fullName) return null;

  const { building_id, zone_id } = await findOrCreateVirtualBuildingAndZone(tx);

  const existing = await tx.location.findFirst({
    where: {
      full_name: fullName,
    },
    select: {
      id: true,
      full_name: true,
      deleted_at: true,
    },
  });

  if (existing) {
    return tx.location.update({
      where: { id: existing.id },
      data: {
        full_name: fullName,
        building_id,
        zone_id,
        lock_no: input.lock,
        location_code: normalizeNullableText(input.location_code),
        status: "Activate",
        remark: [
          "AUTO-SWAP-LOCATION",
          normalizeNullableText(input.location_code),
        ]
          .filter(Boolean)
          .join(" | "),
        ncr_check: false,
        deleted_at: null,
        updated_at: new Date(),
      },
      select: {
        id: true,
        full_name: true,
        lock_no: true,
        building_id: true,
        zone_id: true,
      },
    });
  }

  return tx.location.create({
    data: {
      full_name: fullName,
      building_id,
      zone_id,
      lock_no: input.lock,
      location_code: normalizeNullableText(input.location_code),
      status: "Activate",
      remark: [
        "AUTO-SWAP-LOCATION",
        normalizeNullableText(input.location_code),
      ]
        .filter(Boolean)
        .join(" | "),
      ncr_check: false,
    },
    select: {
      id: true,
      full_name: true,
      lock_no: true,
      building_id: true,
      zone_id: true,
    },
  });
}