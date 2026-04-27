export class AppError extends Error {
  statusCode: number;
  code?: string;
  field?: string;
  details?: unknown;

  constructor(
    statusCode: number,
    message: string,
    opts?: { code?: string; field?: string; details?: unknown }
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = opts?.code;
    this.field = opts?.field;
    this.details = opts?.details;
  }
}

// helpers
export const badRequest = (message: string, opts?: any) =>
  new AppError(400, message, { code: "BAD_REQUEST", ...opts });

export const notFound = (message: string, opts?: any) =>
  new AppError(404, message, { code: "NOT_FOUND", ...opts });

export const conflict = (message: string, opts?: any) =>
  new AppError(409, message, { code: "CONFLICT", ...opts });
