export interface CreateLocationBody {
  full_name: string;
  lock_no?: string;
  building_id: number | string;
  zone_id: number | string;
  location_img?: string;
  status: string;
  location_code?: string;
  ignore?: boolean | string;
  ncr_check?: boolean | string;
  remark?: string;
}

export interface UpdateLocationBody {
  building_id?: number | string;
  full_name?: string;
  lock_no?: string;
  zone_id?: number | string;
  location_img?: string;
  status?: string;
  location_code?: string;
  remark?: string;
  ignore?: boolean | string;
  ncr_check?: boolean | string;
  updated_at?: string;
}