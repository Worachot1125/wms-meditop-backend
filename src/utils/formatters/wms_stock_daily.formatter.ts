import type {
  wms_stock_daily,
  location,
  building,
  zone,
  zone_type,
} from "@prisma/client";

export interface WmsStockDailyBuildingFormatter {
  id: number;
  full_name: string;
  short_name: string;
  remark: string | null;
  building_code: string | null;
}

export interface WmsStockDailyZoneTypeFormatter {
  id: number;
  full_name: string;
  short_name: string;
  remark: string | null;
  zone_type_code: string | null;
}

export interface WmsStockDailyZoneFormatter {
  id: number;
  full_name: string;
  short_name: string;
  remark: string | null;
  zone_code: string | null;
  zone_type: WmsStockDailyZoneTypeFormatter | null;
}

export interface WmsStockDailyLocationFormatter {
  id: number;
  full_name: string;
  lock_no: string | null;
  location_img: string | null;
  status: string;
  remark: string | null;
  location_code: string | null;
  ncr_check: boolean;
  building_id: number;
  zone_id: number;
  building: WmsStockDailyBuildingFormatter | null;
  zone: WmsStockDailyZoneFormatter | null;
}

export interface WmsStockDailyFormatter {
  id: number;
  snapshot_date: string;
  bucket_key: string;

  product_id: number;
  product_code: string | null;
  product_name: string | null;
  unit: string | null;

  location_id: number | null;
  location_name: string | null;
  location: WmsStockDailyLocationFormatter | null;

  lot_id: number | null;
  lot_name: string | null;
  expiration_date: string | null;

  quantity: number;
  created_at: string;
}

export type WmsStockDailyWithLocation = wms_stock_daily & {
  locationRef?: (location & {
    building: building | null;
    zone: (zone & {
      zone_type: zone_type | null;
    }) | null;
  }) | null;
};

export function formatWmsStockDaily(
  row: WmsStockDailyWithLocation,
): WmsStockDailyFormatter {
  return {
    id: row.id,
    snapshot_date: row.snapshot_date.toISOString(),
    bucket_key: row.bucket_key,

    product_id: row.product_id,
    product_code: row.product_code ?? null,
    product_name: row.product_name ?? null,
    unit: row.unit ?? null,

    location_id: row.location_id ?? null,
    location_name: row.location_name ?? null,
    location: row.locationRef
      ? {
          id: row.locationRef.id,
          full_name: row.locationRef.full_name,
          lock_no: row.locationRef.lock_no ?? null,
          location_img: row.locationRef.location_img ?? null,
          status: row.locationRef.status,
          remark: row.locationRef.remark ?? null,
          location_code: row.locationRef.location_code ?? null,
          ncr_check: row.locationRef.ncr_check,
          building_id: row.locationRef.building_id,
          zone_id: row.locationRef.zone_id,
          building: row.locationRef.building
            ? {
                id: row.locationRef.building.id,
                full_name: row.locationRef.building.full_name,
                short_name: row.locationRef.building.short_name,
                remark: row.locationRef.building.remark ?? null,
                building_code: row.locationRef.building.building_code ?? null,
              }
            : null,
          zone: row.locationRef.zone
            ? {
                id: row.locationRef.zone.id,
                full_name: row.locationRef.zone.full_name,
                short_name: row.locationRef.zone.short_name,
                remark: row.locationRef.zone.remark ?? null,
                zone_code: row.locationRef.zone.zone_code ?? null,
                zone_type: row.locationRef.zone.zone_type
                  ? {
                      id: row.locationRef.zone.zone_type.id,
                      full_name: row.locationRef.zone.zone_type.full_name,
                      short_name: row.locationRef.zone.zone_type.short_name,
                      remark: row.locationRef.zone.zone_type.remark ?? null,
                      zone_type_code:
                        row.locationRef.zone.zone_type.zone_type_code ?? null,
                    }
                  : null,
              }
            : null,
        }
      : null,

    lot_id: row.lot_id ?? null,
    lot_name: row.lot_name ?? null,
    expiration_date: row.expiration_date
      ? row.expiration_date.toISOString()
      : null,

    quantity: Number(row.quantity),
    created_at: row.created_at.toISOString(),
  };
}