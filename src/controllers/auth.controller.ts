import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma";
import { signToken } from "../lib/jwt";
import { logger } from "../lib/logger";
import { badRequest, notFound } from "../utils/appError";

// POST /api/auth/login
// body: { usernameOrEmail: string, password: string }
export const login = async (req: Request, res: Response) => {
  const { usernameOrEmail, password } = req.body;

  if (!usernameOrEmail || !password) {
    throw badRequest("usernameOrEmail และ password ห้ามว่าง");
  }

  // หา user จาก username หรือ email
  const user = await prisma.user.findFirst({
    where: {
      deleted_at: null,
      OR: [{ username: usernameOrEmail }, { email: usernameOrEmail }],
    },
  });

  if (!user) {
    throw notFound("ไม่พบผู้ใช้");
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    throw badRequest("ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง");
  }

  const token = signToken({
    empId: user.id,
  });

  const { password: _pw, ...safeUser } = user;

  return res.json({
    token,
    user: safeUser,
  });
};

// GET /api/login (for Odoo webhook integration)
// Query params: ?username=xxx&password=xxx
export const loginByQuery = async (req: Request, res: Response) => {
  const { username, password } = req.query;

  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    throw badRequest("username และ password ห้ามว่าง");
  }

  // หา user จาก username
  const user = await prisma.user.findFirst({
    where: {
      deleted_at: null,
      username: username,
    },
  });

  if (!user) {
    throw notFound("ไม่พบผู้ใช้");
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    throw badRequest("ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง");
  }

  const token = signToken({
    empId: user.id,
  });

  const { password: _pw, ...safeUser } = user;

  return res.json({
    token,
    user: safeUser,
  });
};

// POST /api/auth/logout
export const logout = async (_req: Request, res: Response) => {
  return res.json({ message: "Logged out" });
};

// POST /api/auth/forgot-password/verify-user
export const verifyUserForForgotPassword = async (
  req: Request,
  res: Response
) => {
  const { usernameOrEmail } = req.body;

  if (!usernameOrEmail) {
    throw badRequest("usernameOrEmail ห้ามว่าง");
  }

  const user = await prisma.user.findFirst({
    where: {
      deleted_at: null,
      OR: [{ username: usernameOrEmail }, { email: usernameOrEmail }],
    },
  });

  if (!user) {
    logger.warn(
      `[POST /auth/forgot-password/verify-user] ไม่พบผู้ใช้: ${usernameOrEmail}`
    );
    return res.status(404).json({ message: "ไม่พบผู้ใช้" });
  }

  const responseBody = {
    data: {
      id: user.id,
      username: user.username,
      email: user.email,
    },
    message: "Account verified",
  };

  logger.info(
    `[POST /auth/forgot-password/verify-user] verified user ${user.username} (${user.id})`
  );
  return res.status(200).json(responseBody);
};

export const updatePasswordByForgotFlow = async (
  req: Request,
  res: Response
) => {
  const { userId, newPassword } = req.body;

  if (!userId || !newPassword) {
    throw badRequest("userId และ newPassword ห้ามว่าง");
  }

  const user = await prisma.user.findUnique({
    where: {
      deleted_at: null,
      id: Number(userId),
    },
  });

  if (!user) {
    throw notFound("ไม่พบผู้ใช้");
  }

  const hashed = await bcrypt.hash(newPassword, 10);

  await prisma.user.update({
    where: { id: Number(userId) },
    data: { password: hashed },
  });

  const responseBody = {
    data: {
      id: user.id,
      username: user.username,
      email: user.email,
    },
    message: "Password updated successfully",
  };

  return res.status(200).json(responseBody);
};
