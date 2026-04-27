import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { CreateLocationBody, UpdateLocationBody } from "../types/location";
import { uploadFixedPath } from "../utils/storage";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";
import { formatLocation } from "../utils/formatters/locaion.formatter";

const parseBoolean = (value: unknown): boolean => {
  if (typeof value === "boolean") return value;

  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
  }

  return false;
};

// CREATE Location
export const createLocation = asyncHandler(
  async (req: Request<{}, {}, CreateLocationBody>, res: Response) => {
    const data = req.body;

    const building_id =
      typeof data.building_id === "string"
        ? parseInt(data.building_id, 10)
        : data.building_id;

    const zone_id =
      typeof data.zone_id === "string"
        ? parseInt(data.zone_id, 10)
        : data.zone_id;

    const ncr_check = parseBoolean(data.ncr_check);
    const ignore = parseBoolean(data.ignore);

    if (
      !data.full_name ||
      typeof building_id !== "number" ||
      isNaN(building_id) ||
      typeof zone_id !== "number" ||
      isNaN(zone_id) ||
      !data.status
    ) {
      throw badRequest("ข้อมูลไม่ครบถ้วน");
    }

    const singleFile = req.file as Express.Multer.File | undefined;
    const files = req.files as
      | { location_img?: Express.Multer.File[] }
      | undefined;
    const img = singleFile ?? files?.location_img?.[0];

    const location = await prisma.location.create({
      data: {
        location_code:
          data.location_code !== undefined ? String(data.location_code) : null,
        full_name: String(data.full_name),
        lock_no: data.lock_no !== undefined ? String(data.lock_no) : null,
        building_id,
        zone_id,
        ignore,
        ncr_check,
        ...(img ? { location_img: "" } : {}),
        status: String(data.status),
        remark: data.remark !== undefined ? String(data.remark) : null,
      },
    });

    if (img) {
      const locationImgUrl = await uploadFixedPath(
        `locations/${location.id}`,
        img
      );

      await prisma.location.update({
        where: { id: location.id },
        data: { location_img: locationImgUrl, updated_at: new Date() },
      });
    }

    const locationUpdated = await prisma.location.findUnique({
      where: { id: location.id },
      include: {
        building: true,
        zone: {
          include: {
            zone_type: true,
          },
        },
      },
    });

    return res.status(201).json(formatLocation(locationUpdated!));
  }
);

// GET ALL Locations
export const getLocations = asyncHandler(
  async (req: Request, res: Response) => {
    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

    const baseWhere: Prisma.locationWhereInput = {
      deleted_at: null,
    };

    let where: Prisma.locationWhereInput = baseWhere;
    if (search) {
      const searchCondition: Prisma.locationWhereInput = {
        OR: [
          { location_code: { contains: search, mode: "insensitive" } },
          { full_name: { contains: search, mode: "insensitive" } },
          { lock_no: { contains: search, mode: "insensitive" } },
          { status: { contains: search, mode: "insensitive" } },
          { remark: { contains: search, mode: "insensitive" } },
        ],
      };
      where = { AND: [baseWhere, searchCondition] };
    }

    const locations = await prisma.location.findMany({
      where,
      orderBy: { id: "asc" },
      include: {
        building: true,
        zone: {
          include: {
            zone_type: true,
          },
        },
      },
    });

    return res.json(locations.map(formatLocation));
  }
);

export const getLocationsBorBosSer = asyncHandler(
  async (req: Request, res: Response) => {
    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

    const baseWhere: Prisma.locationWhereInput = {
      deleted_at: null,
      lock_no: {
        in: ["BOR", "BOS", "SER"],
      },
    };

    let where: Prisma.locationWhereInput = baseWhere;

    if (search) {
      const searchCondition: Prisma.locationWhereInput = {
        OR: [
          { location_code: { contains: search, mode: "insensitive" } },
          { full_name: { contains: search, mode: "insensitive" } },
          { lock_no: { contains: search, mode: "insensitive" } },
          { status: { contains: search, mode: "insensitive" } },
          { remark: { contains: search, mode: "insensitive" } },
        ],
      };

      where = {
        AND: [baseWhere, searchCondition],
      };
    }

    const locations = await prisma.location.findMany({
      where,
      orderBy: { id: "asc" },
      include: {
        building: true,
        zone: {
          include: {
            zone_type: true,
          },
        },
      },
    });

    return res.json(locations.map(formatLocation));
  }
);

// GET PAGINATED Locations
export const getLocationsPaginated = asyncHandler(
  async (req: Request, res: Response) => {
    const page = Number(req.query.page) || 1;
    const limit =
      req.query.limit !== undefined ? Number(req.query.limit) || 10 : 10;

    if (Number.isNaN(page) || page < 1) {
      throw badRequest("page ต้องเป็นตัวเลขบวกที่มีค่ามากกว่า 0");
    }

    const skip = (page - 1) * limit;

    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

    const baseWhere: Prisma.locationWhereInput = {
      deleted_at: null,
    };

    let where: Prisma.locationWhereInput = baseWhere;
    if (search) {
      const searchCondition: Prisma.locationWhereInput = {
        OR: [
          { location_code: { contains: search, mode: "insensitive" } },
          { full_name: { contains: search, mode: "insensitive" } },
          { lock_no: { contains: search, mode: "insensitive" } },
          { status: { contains: search, mode: "insensitive" } },
          { remark: { contains: search, mode: "insensitive" } },
        ],
      };
      where = { AND: [baseWhere, searchCondition] };
    }

    const [locations, total] = await Promise.all([
      prisma.location.findMany({
        where,
        skip,
        take: limit,
        orderBy: { id: "asc" },
        include: {
          building: true,
          zone: {
            include: {
              zone_type: true,
            },
          },
        },
      }),
      prisma.location.count({ where }),
    ]);

    return res.json({
      data: locations.map(formatLocation),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  }
);

// GET BY ID Location
export const getLocationById = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const idParam = Array.isArray(req.params.id)
      ? req.params.id[0]
      : req.params.id;

    const id = parseInt(idParam, 10);
    if (isNaN(id)) throw badRequest("id ต้องเป็นตัวเลข");

    const location = await prisma.location.findUnique({
      where: { id },
      include: {
        building: true,
        zone: {
          include: {
            zone_type: true,
          },
        },
      },
    });

    if (!location) throw notFound("ไม่พบสถานที่");

    return res.json(formatLocation(location));
  }
);

// UPDATE Location
export const updateLocation = asyncHandler(
  async (
    req: Request<{ id: string }, {}, UpdateLocationBody>,
    res: Response
  ) => {
    const idParam = req.params.id?.trim();
    const id = parseInt(idParam, 10);
    if (isNaN(id)) throw badRequest("id ต้องเป็นตัวเลข");

    const old = await prisma.location.findUnique({ where: { id } });
    if (!old) throw notFound("ไม่พบสถานที่");
    if (old.deleted_at) throw badRequest("สถานที่ถูกลบไปแล้ว");

    const data = req.body;

    if (data.lock_no && String(data.lock_no) !== old.lock_no) {
      const duplicateLockNo = await prisma.location.findFirst({
        where: {
          lock_no: String(data.lock_no),
          deleted_at: null,
          id: { not: id },
        },
      });
      if (duplicateLockNo) {
        throw badRequest("Lock No นี้ถูกใช้ไปแล้ว");
      }
    }

    const updateData: Prisma.locationUpdateInput = {
      updated_at: new Date(),
    };

    if (data.location_code !== undefined) {
      updateData.location_code =
        data.location_code === null ? null : String(data.location_code);
    }

    if (data.full_name !== undefined) {
      updateData.full_name = String(data.full_name);
    }

    if (data.lock_no !== undefined) {
      updateData.lock_no = String(data.lock_no);
    }

    if (data.building_id !== undefined) {
      const building_id = parseInt(String(data.building_id), 10);
      if (isNaN(building_id)) throw badRequest("building_id ต้องเป็นตัวเลข");
      updateData.building = { connect: { id: building_id } };
    }

    if (data.zone_id !== undefined) {
      const zone_id = parseInt(String(data.zone_id), 10);
      if (isNaN(zone_id)) throw badRequest("zone_id ต้องเป็นตัวเลข");
      updateData.zone = { connect: { id: zone_id } };
    }

    if (data.status !== undefined) {
      updateData.status = String(data.status);
    }

    if (data.ignore !== undefined) {
      updateData.ignore = parseBoolean(data.ignore);
    }

    if (data.ncr_check !== undefined) {
      updateData.ncr_check = parseBoolean(data.ncr_check);
    }

    if (data.remark !== undefined) {
      updateData.remark = data.remark === null ? null : String(data.remark);
    }

    const singleFile = req.file as Express.Multer.File | undefined;
    const files = req.files as
      | { location_img?: Express.Multer.File[] }
      | undefined;
    const img = singleFile ?? files?.location_img?.[0];

    if (img) {
      updateData.location_img = await uploadFixedPath(`locations/${id}`, img);
    }

    const updated = await prisma.location.update({
      where: { id },
      data: updateData,
      include: {
        building: true,
        zone: { include: { zone_type: true } },
      },
    });

    return res.json(formatLocation(updated));
  }
);

// DELETE Location (soft delete)
export const deleteLocation = asyncHandler(
  async (req: Request<{ id: string }>, res: Response) => {
    const idParam = req.params.id?.trim();
    const id = parseInt(idParam, 10);
    if (isNaN(id)) throw badRequest("id ต้องเป็นตัวเลข");

    const old = await prisma.location.findUnique({ where: { id } });
    if (!old) throw notFound("ไม่พบสถานที่");
    if (old.deleted_at) throw badRequest("สถานที่ถูกลบไปแล้ว");

    await prisma.location.update({
      where: { id },
      data: { deleted_at: new Date(), updated_at: new Date() },
    });

    return res.json({ message: "ลบสถานที่เรียบร้อยแล้ว" });
  }
);