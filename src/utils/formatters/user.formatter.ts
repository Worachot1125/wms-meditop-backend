import type { user, department, user_department  } from "@prisma/client";

export interface UserFormatter {
  id: number;
  first_name: string;
  last_name: string;
  tel: string;
  email: string;
  username: string;
  user_level: string;
  user_img: string | null;
  status: string;
  remark: string | null;
  departments: {
    id: number;
    full_name: string;
    short_name: string;
    remark: string;
    department_code: string | null;
  }[];
  created_at: string;
  updated_at: string | null;
  deleted_at: string | null;
}

export function formatUser(
  s: user & { departments: (user_department & { department: department })[] }
): UserFormatter {
  return {
    id: s.id,
    first_name: s.first_name,
    last_name: s.last_name,
    tel: s.tel,
    email: s.email,
    username: s.username,
    user_level: s.user_level,
    user_img: s.user_img ?? null,
    status: s.status,
    remark: s.remark ?? null,

    departments: s.departments.map((x) => ({
      id: x.department.id,
      full_name: x.department.full_name,
      short_name: x.department.short_name,
      remark: x.department.remark ?? "",
      department_code: x.department.department_code ?? null,
    })),

    created_at: s.created_at.toISOString(),
    updated_at: s.updated_at ? s.updated_at.toISOString() : null,
    deleted_at: s.deleted_at ? s.deleted_at.toISOString() : null,
  };
}

