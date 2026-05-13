import app from "./app";
import { prisma } from "./lib/prisma";
import { initializeScheduler } from "./schedulers/odoo.sync.scheduler";

import http from "http";
import { Server, Socket } from "socket.io";

const PORT = Number(process.env.PORT || 7000);

// ✅ Create HTTP server so Socket.IO can attach to it.
const httpServer = http.createServer(app);

// ✅ Prevent long sync requests from being cut by Node timeout.
const TWENTY_MINUTES = 20 * 60 * 1000;

httpServer.setTimeout(TWENTY_MINUTES);
httpServer.keepAliveTimeout = TWENTY_MINUTES;
httpServer.headersTimeout = TWENTY_MINUTES + 5000;
httpServer.requestTimeout = TWENTY_MINUTES;

type DocRoomPayload =
  | {
      no?: string;
      id?: number | string;
    }
  | string;

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function joinDocRoom(socket: Socket, prefix: string, payload: DocRoomPayload) {
  let noRaw: string | undefined;
  let idRaw: number | string | undefined;

  if (typeof payload === "string") {
    noRaw = payload;
  } else if (payload && typeof payload === "object") {
    noRaw = payload.no;
    idRaw = payload.id;
  }

  const no = normalizeText(noRaw);
  const docId = Number(idRaw);

  if (no) {
    const roomNo = `${prefix}:${no}`;
    socket.join(roomNo);
    console.log(`✅ ${socket.id} joined ${roomNo}`);
  }

  if (Number.isFinite(docId) && docId > 0) {
    const roomId = `${prefix}-id:${docId}`;
    socket.join(roomId);
    console.log(`✅ ${socket.id} joined ${roomId}`);
  }
}

function leaveDocRoom(socket: Socket, prefix: string, payload: DocRoomPayload) {
  let noRaw: string | undefined;
  let idRaw: number | string | undefined;

  if (typeof payload === "string") {
    noRaw = payload;
  } else if (payload && typeof payload === "object") {
    noRaw = payload.no;
    idRaw = payload.id;
  }

  const no = normalizeText(noRaw);
  const docId = Number(idRaw);

  if (no) {
    const roomNo = `${prefix}:${no}`;
    socket.leave(roomNo);
    console.log(`👈 ${socket.id} left ${roomNo}`);
  }

  if (Number.isFinite(docId) && docId > 0) {
    const roomId = `${prefix}-id:${docId}`;
    socket.leave(roomId);
    console.log(`👈 ${socket.id} left ${roomId}`);
  }
}

// ✅ สร้าง io และกำหนด CORS ให้ตรง FE ของคุณ
export const io = new Server(httpServer, {
  path: "/socket.io",
  cors: {
    origin: ["http://localhost:5173", ...(process.env.CORS_ORIGIN ? [process.env.CORS_ORIGIN] : [])],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    credentials: true,
  },
});

io.on("connection", (socket) => {
  console.log("🟢 socket connected:", socket.id);

  // =========================================
  // ✅ GENERIC ROOM
  // ใช้ได้กับ room ทั่วไป
  // =========================================
  socket.on("join", (room: string) => {
    const normalizedRoom = normalizeText(room);
    if (!normalizedRoom) return;

    socket.join(normalizedRoom);
    console.log(`👉 ${socket.id} joined ${normalizedRoom}`);
  });

  socket.on("leave", (room: string) => {
    const normalizedRoom = normalizeText(room);
    if (!normalizedRoom) return;

    socket.leave(normalizedRoom);
    console.log(`👈 ${socket.id} left ${normalizedRoom}`);
  });

  // =========================================
  // ✅ INBOUND SOCKET ROOMS
  // room:
  // inbound:<no>
  // inbound-id:<id>
  // =========================================
  socket.on("inbound:join", (payload: DocRoomPayload) => {
    joinDocRoom(socket, "inbound", payload);
  });

  socket.on("inbound:leave", (payload: DocRoomPayload) => {
    leaveDocRoom(socket, "inbound", payload);
  });

  // =========================================
  // ✅ OUTBOUND SOCKET ROOMS
  // room:
  // outbound:<no>
  // outbound-id:<id>
  // =========================================
  socket.on("outbound:join", (payload: DocRoomPayload) => {
    joinDocRoom(socket, "outbound", payload);
  });

  socket.on("outbound:leave", (payload: DocRoomPayload) => {
    leaveDocRoom(socket, "outbound", payload);
  });

  // =========================================
  // ✅ ADJUSTMENT SOCKET ROOMS
  // room:
  // adjustment:<no>
  // adjustment-id:<id>
  // =========================================
  socket.on("adjustment:join", (payload: DocRoomPayload) => {
    joinDocRoom(socket, "adjustment", payload);
  });

  socket.on("adjustment:leave", (payload: DocRoomPayload) => {
    leaveDocRoom(socket, "adjustment", payload);
  });

  // =========================================
  // ✅ BORROW STOCK SOCKET ROOMS
  // room:
  // borrow_stock:<no>
  // borrow_stock-id:<id>
  // =========================================
  socket.on("borrow_stock:join", (payload: DocRoomPayload) => {
    joinDocRoom(socket, "borrow_stock", payload);
  });

  socket.on("borrow_stock:leave", (payload: DocRoomPayload) => {
    leaveDocRoom(socket, "borrow_stock", payload);
  });

  // =========================================
  // ✅ TRANSFER MOVEMENT SOCKET ROOMS
  // เดิมใช้ room tm:<no>
  // คงไว้เพื่อไม่ให้ FE เดิมพัง
  // =========================================
  socket.on("join_transfer_movement", (no: string) => {
    const normalizedNo = normalizeText(no);
    if (!normalizedNo) return;

    const room = `tm:${normalizedNo}`;
    socket.join(room);
    console.log(`🚚 ${socket.id} joined ${room}`);
  });

  socket.on("leave_transfer_movement", (no: string) => {
    const normalizedNo = normalizeText(no);
    if (!normalizedNo) return;

    const room = `tm:${normalizedNo}`;
    socket.leave(room);
    console.log(`🚚 ${socket.id} left ${room}`);
  });

  // ✅ เพิ่มชื่อ event แบบใหม่ไว้ด้วย ถ้าภายหลังอยากใช้ pattern เดียวกัน
  socket.on("transfer_movement:join", (payload: DocRoomPayload) => {
    joinDocRoom(socket, "transfer_movement", payload);
  });

  socket.on("transfer_movement:leave", (payload: DocRoomPayload) => {
    leaveDocRoom(socket, "transfer_movement", payload);
  });

  // =========================================
  // ✅ PACK PRODUCT SOCKET ROOMS
  // =========================================
  socket.on(
    "pack_product:join",
    (payload: { packProductId?: number | string } | number | string) => {
      const raw =
        typeof payload === "object" && payload !== null
          ? payload.packProductId
          : payload;

      const packProductId = Number(raw);
      if (!Number.isFinite(packProductId) || packProductId <= 0) return;

      const room = `pack-product:${packProductId}`;
      socket.join(room);
      console.log(`📦 ${socket.id} joined ${room}`);
    },
  );

  socket.on(
    "pack_product:leave",
    (payload: { packProductId?: number | string } | number | string) => {
      const raw =
        typeof payload === "object" && payload !== null
          ? payload.packProductId
          : payload;

      const packProductId = Number(raw);
      if (!Number.isFinite(packProductId) || packProductId <= 0) return;

      const room = `pack-product:${packProductId}`;
      socket.leave(room);
      console.log(`📦 ${socket.id} left ${room}`);
    },
  );

  socket.on(
    "pack_product:box_join",
    (
      payload:
        | { packProductId?: number | string; boxId?: number | string }
        | string,
    ) => {
      let packProductIdRaw: number | string | undefined;
      let boxIdRaw: number | string | undefined;

      if (typeof payload === "object" && payload !== null) {
        packProductIdRaw = payload.packProductId;
        boxIdRaw = payload.boxId;
      }

      const packProductId = Number(packProductIdRaw);
      const boxId = Number(boxIdRaw);

      if (!Number.isFinite(packProductId) || packProductId <= 0) return;
      if (!Number.isFinite(boxId) || boxId <= 0) return;

      const room = `pack-product:${packProductId}:box:${boxId}`;
      socket.join(room);
      console.log(`📦 ${socket.id} joined ${room}`);
    },
  );

  socket.on(
    "pack_product:box_leave",
    (
      payload:
        | { packProductId?: number | string; boxId?: number | string }
        | string,
    ) => {
      let packProductIdRaw: number | string | undefined;
      let boxIdRaw: number | string | undefined;

      if (typeof payload === "object" && payload !== null) {
        packProductIdRaw = payload.packProductId;
        boxIdRaw = payload.boxId;
      }

      const packProductId = Number(packProductIdRaw);
      const boxId = Number(boxIdRaw);

      if (!Number.isFinite(packProductId) || packProductId <= 0) return;
      if (!Number.isFinite(boxId) || boxId <= 0) return;

      const room = `pack-product:${packProductId}:box:${boxId}`;
      socket.leave(room);
      console.log(`📦 ${socket.id} left ${room}`);
    },
  );

  // =========================================
  // ✅ TRANSFER DOC SOCKET ROOMS
  // ใช้ร่วมกันทั้งหน้า PICK และ PUT
  // room:
  // transfer_doc:<no>
  // transfer_doc-id:<id>
  // =========================================
  socket.on("transfer_doc:join", (payload: DocRoomPayload) => {
    joinDocRoom(socket, "transfer_doc", payload);
  });

  socket.on("transfer_doc:leave", (payload: DocRoomPayload) => {
    leaveDocRoom(socket, "transfer_doc", payload);
  });

  // =========================================
  // ✅ BASIC EVENTS
  // =========================================
  socket.on("ping", () => socket.emit("pong"));

  socket.on("disconnect", () => {
    console.log("🔴 socket disconnected:", socket.id);
  });
});

app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;

    res.json({
      status: "ok",
      database: "connected",
    });
  } catch (error) {
    console.error("❌ Database health check failed:", error);

    res.status(500).json({
      status: "error",
      database: "disconnected",
    });
  }
});

async function startServer() {
  try {
    await prisma.$connect();
    console.log("✅ Database connected successfully");

    initializeScheduler();

    httpServer.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server running at http://localhost:${PORT}`);
      console.log(`🧩 Socket.IO ready at ws://localhost:${PORT}/socket.io`);
    });
  } catch (error) {
    console.error("❌ Failed to connect to database");
    console.error(error);
    process.exit(1);
  }
}

startServer();