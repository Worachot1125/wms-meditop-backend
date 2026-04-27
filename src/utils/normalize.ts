import { badRequest } from "./appError";

type NormalizeOptions = {
  field?: string;
  minLength?: number;
  pad2IfNumeric?: boolean; // ✅ แปลง "1" -> "01"
};

export function normalizeStringArray(
  value: unknown,
  opts: NormalizeOptions = {}
): string[] {
  const field = opts.field ?? "department_ids";
  const minLength = opts.minLength ?? 1;
  const pad2 = opts.pad2IfNumeric ?? true;

  const finalize = (arr: unknown[]) => {
    const out = arr
      .map(String)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (pad2 && /^\d$/.test(s) ? s.padStart(2, "0") : s)); // ✅ 1->01

    if (out.length < minLength) {
      throw badRequest(`${field} ต้องมีอย่างน้อย ${minLength} ค่า`, { field });
    }
    return out;
  };

  // ✅ case: array อยู่แล้ว (เช่น key ซ้ำ หรือ JSON body)
  if (Array.isArray(value)) return finalize(value);

  // ✅ case: string (เช่น form-data)
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) throw badRequest(`${field} ต้องมีอย่างน้อย ${minLength} ค่า`, { field });

    // JSON string: '["01","02"]'
    if (raw.startsWith("[") && raw.endsWith("]")) {
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error("not array");
        return finalize(parsed);
      } catch {
        throw badRequest(`${field} ต้องเป็น JSON array string เช่น ["01","02"]`, { field });
      }
    }

    // single value
    return finalize([raw]);
  }

  throw badRequest(`${field} ต้องเป็น array`, { field });
}

export function normalizeNumberArray(
  value: unknown,
  opts: NormalizeOptions = {}
): number[] {
  const field = opts.field ?? "ids";
  const minLength = opts.minLength ?? 1;

  const finalize = (arr: unknown[]) => {
    const out = arr
      .map((v) => {
        const num = Number(v);
        if (Number.isNaN(num)) {
          throw badRequest(`${field} ต้องเป็นตัวเลขทั้งหมด`, { field });
        }
        return num;
      })
      .filter((n) => !Number.isNaN(n));

    if (out.length < minLength) {
      throw badRequest(`${field} ต้องมีอย่างน้อย ${minLength} ค่า`, { field });
    }
    return out;
  };

  // ✅ case: array อยู่แล้ว
  if (Array.isArray(value)) return finalize(value);

  // ✅ case: string
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) throw badRequest(`${field} ต้องมีอย่างน้อย ${minLength} ค่า`, { field });

    // JSON string: '[1,2,3]'
    if (raw.startsWith("[") && raw.endsWith("]")) {
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error("not array");
        return finalize(parsed);
      } catch {
        throw badRequest(`${field} ต้องเป็น JSON array เช่น [1,2,3]`, { field });
      }
    }

    // single value
    return finalize([raw]);
  }

  // ✅ case: number
  if (typeof value === "number") return finalize([value]);

  throw badRequest(`${field} ต้องเป็น array`, { field });
}
