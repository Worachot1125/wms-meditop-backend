export interface CreateZoneBody {
    building_id: number;
    full_name: string;
    short_name: string;
    zone_type_id: number;
    zone_code?: string;
    remark?: string;
}

export interface UpdateZoneBody {
    building_id?: number;
    full_name?: string;
    short_name?: string;
    zone_type_id?: number;
    zone_code?: string;
    remark?: string;
    updated_at?: string;
}