export interface CreateGoodsOutBoxBody {
    id: string;
    goods_out_id: string;
    box_id: string;
    quantity?: number;
}

export interface UpdateGoodsOutBoxBody {
    id?: string;
    goods_out_id?: string;
    box_id?: string;
    quantity?: number;
}