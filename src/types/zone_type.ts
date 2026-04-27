export interface CreateZoneTypeBody {
    full_name: string;
    short_name: string;
    zone_type_code?: string;
    remark?: string;
}

export interface UpdateZoneTypeBody {
    full_name?: string;
    short_name?: string;
    zone_type_code?: string;
    remark?: string;
    updated_at?: string;
}