import jwt, { SignOptions } from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "your_jwt_secret_key";

export interface JwtEmployeePayload {
  empId: number;
  user_level?: string; // Admin, Operator, Supervisor, UAT
}

export function signToken(payload: JwtEmployeePayload): string {
  const expiresIn = (process.env.JWT_EXPIRES_IN || "1d") as SignOptions["expiresIn"];

  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

export function verifyToken(token: string): JwtEmployeePayload {
  return jwt.verify(token, JWT_SECRET) as JwtEmployeePayload;
}