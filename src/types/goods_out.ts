export interface CreateGoodsOutBody {
    id: string;
    sku: string;
    barcode: string;
    name: string;
    lock_no: string;
    lock_name: string;
    lot_no: string;
    box_ids?: string[];
}

export interface UpdateGoodsOutBody {
    id?: string;
    sku?: string;
    barcode?: string;
    name?: string;
    lock_no?: string;
    lock_name?: string;
    lot_no?: string;
    box_ids?: string[];
    updated_at?: string;
}