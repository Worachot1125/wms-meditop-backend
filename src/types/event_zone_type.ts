export interface OdooZoneTypeEventItem {
  event: "C" | "U" | "D" | "create" | "update" | "delete";
  station_id: number;
  station_name?: string;
  sequence?: number;
  description?: string;
  notes?: string;
  temp_min?: number;
  temp_max?: number;
  humidity_min?: number;
  humidity_max?: number;
}

export interface EventZoneTypeRequestBody {
  zone_types?: OdooZoneTypeEventItem[];
  params?: {
    zone_types?: OdooZoneTypeEventItem[];
  };
}
