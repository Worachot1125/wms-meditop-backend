import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { badRequest, notFound } from "../appError";

export async function resolveLocationByFullNameBasic(full_name: string) {
  const loc = await prisma.location.findFirst({
    where: { full_name, deleted_at: null },
    select: {
      id: true,
      full_name: true,
    },
  });

  if (!loc) throw badRequest(`ไม่พบ location full_name: ${full_name}`);
  return loc;
}

export async function resolveLocationByFullNameWithZone(full_name: string) {
  const loc = await prisma.location.findFirst({
    where: { full_name, deleted_at: null },
    select: {
      id: true,
      full_name: true,
      ignore: true,
      zone: {
        select: {
          id: true,
          short_name: true,
          full_name: true,
          zone_type: {
            select: {
              id: true,
              short_name: true,
              full_name: true,
            },
          },
        },
      },
    },
  });

  if (!loc) throw badRequest(`ไม่พบ location full_name: ${full_name}`);
  return loc;
}

type BasicDoc = {
  id: number;
  no: string;
  deleted_at: Date | null;
};

type HandleScanLocationCommonArgs<TLocation, TDetail, TPayload> = {
  docNo: string;
  locationFullName: string;
  loadDocument: () => Promise<BasicDoc | null>;
  resolveLocation: (fullName: string) => Promise<TLocation>;
  beforeBuildDetail?: (args: {
    doc: BasicDoc;
    location: TLocation;
  }) => Promise<void>;
  buildDetail: (args: {
    doc: BasicDoc;
    location: TLocation;
  }) => Promise<TDetail>;
  buildPayload: (args: {
    doc: BasicDoc;
    location: TLocation;
    detail: TDetail;
  }) => TPayload;
  emitRealtime?: (payload: TPayload, doc: BasicDoc, location: TLocation) => void;
  notFoundMessage?: string;
};

export async function handleScanLocationCommon<
  TLocation,
  TDetail,
  TPayload,
>(
  args: HandleScanLocationCommonArgs<TLocation, TDetail, TPayload>,
): Promise<TPayload> {
  const locationFullName = String(args.locationFullName ?? "").trim();
  if (!locationFullName) throw badRequest("กรุณาส่ง location_full_name");

  const doc = await args.loadDocument();
  if (!doc || doc.deleted_at) {
    throw notFound(args.notFoundMessage ?? `ไม่พบเอกสาร: ${args.docNo}`);
  }

  const location = await args.resolveLocation(locationFullName);

  if (args.beforeBuildDetail) {
    await args.beforeBuildDetail({ doc, location });
  }

  const detail = await args.buildDetail({ doc, location });

  const payload = args.buildPayload({
    doc,
    location,
    detail,
  });

  if (args.emitRealtime) {
    args.emitRealtime(payload, doc, location);
  }

  return payload;
}