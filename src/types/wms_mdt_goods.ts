export interface WmsMdtGoodsResponse {
  id: number;
  product_id: number;
  product_code: string | null;
  product_name: string | null;
  lot_id: number | null;
  lot_name: string | null;
  expiration_date: string | null;
  expiration_date_end: string | null;
  department_code: string | null;
  unit: string | null;
  zone_type: string | null;
  input_number: boolean;
}
