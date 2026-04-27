export interface CreateTransferDocBody {
  no: string;
  lot: string;
  date: string;
  quantity: number;
  in_type: "TF";
  department: string;
  remark?: string | null;
}

export interface UpdateTransferDocBody {
  no?: string;
  lot?: string;
  date?: string;
  quantity?: number;
  in_type?: "TF";
  department?: string;
  reference?: string | null;
  origin?: string | null;
  updated_at?: string;
}
