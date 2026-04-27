export interface CreateDepartmentBody {
    full_name: string;        // จากฟอร์ม → map เป็น department_name
    short_name: string;       // จากฟอร์ม → map เป็น department_code
    remark?: string;
}

export interface UpdateDepartmentBody {
    department_code?: string; // เก็บ ID เดิมก่อน migrate
    full_name?: string;       // จากฟอร์ม → map เป็น department_name
    short_name?: string;      // จากฟอร์ม → map เป็น department_code
    remark?: string;
    updated_at?: string;
}