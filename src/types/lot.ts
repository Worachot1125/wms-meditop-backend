export interface CreateLotBody {
    no: string;
    name?: string;
}

export interface UpdateLotBody {
    no?: string;
    name?: string;
    updated_at?: string;
}