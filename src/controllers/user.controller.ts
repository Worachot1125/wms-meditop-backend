import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import bcrypt from "bcryptjs";
import { CreateUserBody, UpdateUserBody } from "../types/user";
import { hasThai } from "../utils/parse";
import { uploadFixedPath } from "../utils/storage";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound, conflict } from "../utils/appError";
import { formatUser } from "../utils/formatters/user.formatter";
import { normalizeStringArray, normalizeNumberArray } from "../utils/normalize";

// ===== PIN helpers =====
function normalizePin(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (raw === null) return null;
  const s = String(raw).trim();
  return s.length ? s : null;
}

function assertPin6Alnum(pin: string) {
  if (!/^[A-Za-z0-9]{6}$/.test(pin)) {
    throw badRequest("PIN ต้องมี 6 ตัวอักษรหรือตัวเลข", { field: "pin" });
  }
}

// CREATE User
export const createUser = asyncHandler(
  async (req: Request<{}, {}, CreateUserBody>, res: Response) => {
    const data = req.body;

    if (
      !data.first_name ||
      !data.last_name ||
      !data.tel ||
      !data.username ||
      !data.password ||
      !data.user_level ||
      !data.status
    ) {
      throw badRequest("ข้อมูลไม่ครบถ้วน");
    }

    // ✅ รับเป็น array จริง (JSON) หรือ JSON-string (form-data)
    const departmentIds = normalizeNumberArray(
      (data as any).department_ids ?? (data as any)["department_ids[]"],
      { field: "department_ids" },
    );

    if (hasThai(String(data.username)))
      throw badRequest("username ห้ามมีตัวอักษรภาษาไทย", { field: "username" });
    if (hasThai(String(data.email)))
      throw badRequest("email ห้ามมีตัวอักษรภาษาไทย", { field: "email" });
    if (hasThai(String(data.password)))
      throw badRequest("password ห้ามมีตัวอักษรภาษาไทย", { field: "password" });

    const emailExists = await prisma.user.findFirst({
      where: { email: String(data.email) },
    });
    if (emailExists) throw conflict("email นี้ถูกใช้แล้ว", { field: "email" });

    const usernameExists = await prisma.user.findFirst({
      where: { username: String(data.username) },
    });
    if (usernameExists)
      throw conflict("username นี้ถูกใช้แล้ว", { field: "username" });

    // validate departments
    const deps = await prisma.department.findMany({
      where: { id: { in: departmentIds } },
    });
    if (deps.length !== departmentIds.length)
      throw badRequest("มี department_id บางตัวไม่ถูกต้อง", {
        field: "department_ids",
      });
    if (deps.some((d) => d.deleted_at))
      throw badRequest("มีแผนกที่ถูกลบอยู่ในรายการ", {
        field: "department_ids",
      });

    const pinRaw = normalizePin((data as any).pin);
    let hashedPin: string | null = null;

    if (pinRaw) {
      assertPin6Alnum(pinRaw);
      hashedPin = await bcrypt.hash(pinRaw, 10);
    }

    const hashed = await bcrypt.hash(String(data.password), 10);

    // ✅ รับไฟล์ได้ทั้ง req.file หรือ req.files.user_img[0]
    const singleFile = req.file as Express.Multer.File | undefined;
    const files = req.files as { user_img?: Express.Multer.File[] } | undefined;
    const img = singleFile ?? files?.user_img?.[0];

    const created = await prisma.user.create({
      data: {
        first_name: String(data.first_name),
        last_name: String(data.last_name),
        tel: String(data.tel),
        email: String(data.email),
        username: String(data.username),
        password: hashed,
        user_level: String(data.user_level),
        user_img: "",
        status: String(data.status),
        pin: hashedPin,
        remark: data.remark !== undefined ? String(data.remark) : null,

        // ✅ many-to-many mapping
        departments: {
          create: departmentIds.map((depId) => ({ department_id: depId })),
        },
      },
      include: { departments: { include: { department: true } } },
    });

    // อัปโหลดรูปถ้ามี
    if (img) {
      const userImgUrl = await uploadFixedPath(`users/${created.id}`, img);

      const user = await prisma.user.update({
        where: { id: created.id },
        data: { user_img: userImgUrl, updated_at: new Date() },
        include: { departments: { include: { department: true } } },
      });

      return res.status(201).json(formatUser(user));
    }

    return res.status(201).json(formatUser(created));
  },
);

// GET ALL Users
export const getUsers = asyncHandler(async (req: Request, res: Response) => {
  const rawSearch = req.query.search;
  const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

  const baseWhere: Prisma.userWhereInput = { deleted_at: null };

  let where: Prisma.userWhereInput = baseWhere;

  if (search) {
    const searchCondition: Prisma.userWhereInput = {
      OR: [
        { first_name: { contains: search, mode: "insensitive" } },
        { last_name: { contains: search, mode: "insensitive" } },
        { tel: { contains: search, mode: "insensitive" } },
        { username: { contains: search, mode: "insensitive" } },
        { remark: { contains: search, mode: "insensitive" } },

        // ✅ search ผ่าน relation departments ได้ด้วย
        {
          departments: {
            some: {
              department: {
                OR: [
                  { full_name: { contains: search, mode: "insensitive" } },
                  { short_name: { contains: search, mode: "insensitive" } },
                  {
                    department_code: { contains: search, mode: "insensitive" },
                  },
                ],
              },
            },
          },
        },
      ],
    };

    where = { AND: [baseWhere, searchCondition] };
  }

  const users = await prisma.user.findMany({
    where,
    orderBy: { id: "asc" },
    include: { departments: { include: { department: true } } },
  });

  return res.json(users.map(formatUser));
});

export const getUsersPaginated = asyncHandler(
  async (req: Request, res: Response) => {
    const page = Number(req.query.page) || 1;
    const limit =
      req.query.limit !== undefined ? Number(req.query.limit) || 10 : 10;
    if (Number.isNaN(page) || page < 1)
      throw badRequest("page ต้องเป็นตัวเลขบวกที่มีค่ามากกว่า 0");

    const skip = (page - 1) * limit;

    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

    const baseWhere: Prisma.userWhereInput = { deleted_at: null };
    let where: Prisma.userWhereInput = baseWhere;

    if (search) {
      const searchCondition: Prisma.userWhereInput = {
        OR: [
          { first_name: { contains: search, mode: "insensitive" } },
          { last_name: { contains: search, mode: "insensitive" } },
          { tel: { contains: search, mode: "insensitive" } },
          { username: { contains: search, mode: "insensitive" } },
          { remark: { contains: search, mode: "insensitive" } },
          {
            departments: {
              some: {
                department: {
                  OR: [
                    { full_name: { contains: search, mode: "insensitive" } },
                    { short_name: { contains: search, mode: "insensitive" } },
                    {
                      department_code: {
                        contains: search,
                        mode: "insensitive",
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
      };
      where = { AND: [baseWhere, searchCondition] };
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { id: "asc" },
        include: { departments: { include: { department: true } } },
      }),
      prisma.user.count({ where }),
    ]);

    return res.json({
      data: users.map(formatUser),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  },
);

// GET BY ID User
export const getUserById = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) throw badRequest("id ต้องเป็นตัวเลข");

    const user = await prisma.user.findUnique({
      where: { id },
      include: { departments: { include: { department: true } } },
    });
    if (!user) throw notFound("ไม่พบผู้ใช้");

    return res.json(formatUser(user));
  },
);

// UPDATE User
export const updateUser = asyncHandler(
  async (req: Request<{ id: string }, {}, UpdateUserBody>, res: Response) => {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) throw badRequest("id ต้องเป็นตัวเลข");

    const old = await prisma.user.findUnique({ where: { id } });
    if (!old) throw notFound("ไม่พบผู้ใช้");
    if (old.deleted_at) throw badRequest("ผู้ใช้ถูกลบไปแล้ว");

    const data = req.body;
    const updateData: any = { updated_at: new Date() };

    if (data.first_name !== undefined)
      updateData.first_name = String(data.first_name);
    if (data.last_name !== undefined)
      updateData.last_name = String(data.last_name);
    if (data.tel !== undefined) updateData.tel = String(data.tel);
    if (data.user_level !== undefined)
      updateData.user_level = String(data.user_level);
    if (data.status !== undefined) updateData.status = String(data.status);
    if (data.remark !== undefined)
      updateData.remark = data.remark === null ? null : String(data.remark);
    if ((data as any).pin !== undefined) {
      const pinRaw = normalizePin((data as any).pin);

      if (pinRaw === null) {
        // ถ้าส่ง null/"" มา = เคลียร์ pin
        updateData.pin = null;
      } else {
        assertPin6Alnum(pinRaw);
        updateData.pin = await bcrypt.hash(pinRaw, 10);
      }
    }

    if (data.email !== undefined) {
      if (hasThai(String(data.email)))
        throw badRequest("email ห้ามมีตัวอักษรภาษาไทย", {
          field: "email",
        });

      const exists = await prisma.user.findFirst({
        where: { email: String(data.email), NOT: { id } },
      });
      if (exists) throw conflict("email นี้ถูกใช้แล้ว", { field: "email" });

      updateData.email = String(data.email);
    }

    if (data.username !== undefined) {
      if (hasThai(String(data.username)))
        throw badRequest("username ห้ามมีตัวอักษรภาษาไทย", {
          field: "username",
        });

      const exists = await prisma.user.findFirst({
        where: { username: String(data.username), NOT: { id } },
      });
      if (exists)
        throw conflict("username นี้ถูกใช้แล้ว", { field: "username" });

      updateData.username = String(data.username);
    }

    if (data.password !== undefined) {
      if (hasThai(String(data.password)))
        throw badRequest("password ห้ามมีตัวอักษรภาษาไทย", {
          field: "password",
        });

      updateData.password = await bcrypt.hash(String(data.password), 10);
    }

    // ✅ อัปโหลดรูป (ถ้ามี)
    const singleFile = req.file as Express.Multer.File | undefined;
    const files = req.files as { user_img?: Express.Multer.File[] } | undefined;
    const img = singleFile ?? files?.user_img?.[0];
    if (img) {
      updateData.user_img = await uploadFixedPath(`users/${id}`, img);
    }

    // ✅ ถ้ามี department_ids ส่งมา → replace mapping
    const incomingDept =
      (data as any).department_ids ?? (data as any)["department_ids[]"];

    if (incomingDept !== undefined) {
      const departmentIds = normalizeNumberArray(incomingDept, {
        field: "department_ids",
      });

      const deps = await prisma.department.findMany({
        where: { id: { in: departmentIds } },
      });
      if (deps.length !== departmentIds.length)
        throw badRequest("มี department_id บางตัวไม่ถูกต้อง", {
          field: "department_ids",
        });
      if (deps.some((d) => d.deleted_at))
        throw badRequest("มีแผนกที่ถูกลบอยู่ในรายการ", {
          field: "department_ids",
        });

      await prisma.user_department.deleteMany({ where: { user_id: id } });
      await prisma.user_department.createMany({
        data: departmentIds.map((depId) => ({
          user_id: id,
          department_id: depId,
        })),
        skipDuplicates: true,
      });
    }

    const user = await prisma.user.update({
      where: { id },
      data: updateData,
      include: { departments: { include: { department: true } } },
    });

    return res.json(formatUser(user));
  },
);


// PATCH /users/pin/:id
export const updateUserPin = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const pin = String(req.body?.pin ?? "").trim();

  if (!Number.isFinite(id)) throw badRequest("invalid user id");
  if (!/^\d{6}$/.test(pin)) throw badRequest("PIN ต้องเป็นตัวเลข 6 หลัก");

  const user = await prisma.user.update({
    where: { id },
    data: { pin },
    select: { id: true, pin: true },
  });

  res.json({ message: "PIN updated", data: user });
});

// DELETE User (soft delete)
export const deleteUser = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) throw badRequest("id ต้องเป็นตัวเลข");

    const old = await prisma.user.findUnique({ where: { id } });
    if (!old) throw notFound("ไม่พบผู้ใช้");
    if (old.deleted_at) throw badRequest("ผู้ใช้ถูกลบไปแล้ว");

    await prisma.user.update({
      where: { id },
      data: { deleted_at: new Date(), updated_at: new Date() },
    });

    return res.json({ message: "ลบผู้ใช้เรียบร้อยแล้ว" });
  },
);
