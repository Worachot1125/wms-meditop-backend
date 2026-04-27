export interface CreateBuildingBody {
    full_name: string;
    short_name: string;
    building_code?: string;
    remark?: string;
}

export interface UpdateBuildingBody {
    full_name?: string;
    short_name?: string;
    building_code?: string;
    remark?: string;
    updated_at?: string;
}