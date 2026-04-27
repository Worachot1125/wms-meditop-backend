import type { building, zone, zone_type } from "@prisma/client";

export interface ZoneFormatter {
  id: number;
  zone_code?: string | null;
  full_name: string;
  short_name: string;
  remark: string | null;
  building: {
    id: number;
    building_code?: string | null;
    full_name: string;
    short_name: string;
    remark: string | null;
  };
  zone_type: {
    id: number;
    zone_type_code?: string | null;
    full_name: string;
    short_name: string;
    remark: string | null;
  };
  created_at: string;
  updated_at: string | null;
  deleted_at: string | null;
}

export function formatZone(
  s: zone & { building: building; zone_type: zone_type }
): ZoneFormatter {
  return {
    id: s.id,
    zone_code: s.zone_code,
    full_name: s.full_name,
    short_name: s.short_name,
    remark: s.remark ?? null,
    building: {
      id: s.building.id,
      building_code: s.building.building_code,
      full_name: s.building.full_name,
      short_name: s.building.short_name,
      remark: s.building.remark ?? null,
    },
    zone_type: {
      id: s.zone_type.id,
      zone_type_code: s.zone_type.zone_type_code,
      full_name: s.zone_type.full_name,
      short_name: s.zone_type.short_name,
      remark: s.zone_type.remark ?? null,
    },
    created_at: s.created_at.toISOString(),
    updated_at: s.updated_at ? s.updated_at.toISOString() : null,
    deleted_at: s.deleted_at ? s.deleted_at.toISOString() : null,
  };
}
