export interface CreateTransportBKKBody {
    full_name: string;
    barcode_text: string;
}

export interface UpdateTransportBKKBody {
    full_name?: string;
    barcode_text?: string;
    updated_at?: string;
}