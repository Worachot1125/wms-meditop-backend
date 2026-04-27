import type { location, building, zone, zone_type } from "@prisma/client";

export interface LocationFormatter {
  id: number;
  location_code?: string | null;
  full_name: string;
  lock_no: string | null;
  location_img: string | null;
  status: string;
  ignore: boolean;
  ncr_check: boolean;
  remark?: string | null;
  building: {
    id: number;
    building_code?: string | null;
    full_name: string;
    short_name: string;
    remark: string;
  };
  zone: {
    id: number;
    zone_code?: string | null;
    full_name: string;
    short_name: string;
    remark: string;
    zone_type: {
      id: number;
      zone_type_code?: string | null;
      full_name: string;
      short_name: string;
      remark: string;
    };
  } | null;
  created_at: string;
  updated_at: string | null;
  deleted_at: string | null;
}

export function formatLocation(
  s: location & { building: building; zone: zone & { zone_type: zone_type } }
): LocationFormatter {
  return {
    id: s.id,
    location_code: s.location_code,
    full_name: s.full_name,
    lock_no: s.lock_no ?? null,
    location_img: s.location_img ?? null,
    status: s.status,
    ignore: s.ignore,
    ncr_check: s.ncr_check,
    remark: s.remark ?? null,

    building: {
      id: s.building.id,
      building_code: s.building.building_code,
      full_name: s.building.full_name,
      short_name: s.building.short_name,
      remark: s.building.remark ?? "",
    },
    zone: {
      id: s.zone.id,
      zone_code: s.zone.zone_code,
      full_name: s.zone.full_name,
      short_name: s.zone.short_name,
      remark: s.zone.remark ?? "",
      zone_type: {
        id: s.zone.zone_type.id,
        zone_type_code: s.zone.zone_type.zone_type_code,
        full_name: s.zone.zone_type.full_name,
        short_name: s.zone.zone_type.short_name,
        remark: s.zone.zone_type.remark ?? "",
      },
    },

    created_at: s.created_at.toISOString(),
    updated_at: s.updated_at ? s.updated_at.toISOString() : null,
    deleted_at: s.deleted_at ? s.deleted_at.toISOString() : null,
  };
}