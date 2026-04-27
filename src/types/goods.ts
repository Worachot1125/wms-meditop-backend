export interface CreateGoodsBody {
    id: string;
    sku: string;
    name: string;
    lot: string;
    exp_date_start: string;
    exp_date_end: string;
    department_id: number;
    zone_type_id: number;
    unit: string;
    remark?: string;
}

export interface UpdateGoodsBody {
    id?: string;
    sku?: string;
    name?: string;
    lot?: string;
    exp_date_start?: string;
    exp_date_end?: string;
    department_id?: number;
    zone_type_id?: number;
    unit?: string;
    remark?: string;
    updated_at?: string;
}