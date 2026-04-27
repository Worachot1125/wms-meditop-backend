export interface CreateUserBody {
  first_name: string;
  last_name: string;
  tel: string;
  email: string;
  username: string;
  password: string;
  user_level: string;
  department_ids: number[];
  status: string;
  remark?: string;
  pin?: string;
}

export interface UpdateUserBody {
  first_name?: string;
  last_name?: string;
  tel?: string;
  email?: string;
  username?: string;
  password?: string;
  user_level?: string;
  department_ids?: number[];
  status?: string;
  remark?: string;
  pin?: string;
  updated_at?: string;
}
