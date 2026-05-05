import app from "./app";
import { prisma } from "./lib/prisma";
import { initializeScheduler } from "./schedulers/odoo.sync.scheduler";

import http from "http";
import { Server } from "socket.io";

const PORT = Number(process.env.PORT || 7000);

// ✅ สร้าง http server เพื่อให้ socket.io attach ได้
const httpServer = http.createServer(app);

// ✅ กัน request sync นาน ๆ โดน Node ตัด
const TWENTY_MINUTES = 20 * 60 * 1000;

httpServer.setTimeout(TWENTY_MINUTES);
httpServer.keepAliveTimeout = TWENTY_MINUTES;
httpServer.headersTimeout = TWENTY_MINUTES + 5000;
httpServer.requestTimeout = TWENTY_MINUTES;

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

  socket.on("join", (room: string) => {
    if (!room || typeof room !== "string") return;

    const normalizedRoom = room.trim();
    if (!normalizedRoom) return;

    socket.join(normalizedRoom);
    console.log(`👉 ${socket.id} joined ${normalizedRoom}`);
  });

  socket.on("leave", (room: string) => {
    if (!room || typeof room !== "string") return;

    const normalizedRoom = room.trim();
    if (!normalizedRoom) return;

    socket.leave(normalizedRoom);
    console.log(`👈 ${socket.id} left ${normalizedRoom}`);
  });

  socket.on("join_transfer_movement", (no: string) => {
    const normalizedNo = String(no ?? "").trim();
    if (!normalizedNo) return;

    const room = `tm:${normalizedNo}`;
    socket.join(room);
    console.log(`🚚 ${socket.id} joined ${room}`);
  });

  socket.on("leave_transfer_movement", (no: string) => {
    const normalizedNo = String(no ?? "").trim();
    if (!normalizedNo) return;

    const room = `tm:${normalizedNo}`;
    socket.leave(room);
    console.log(`🚚 ${socket.id} left ${room}`);
  });

  // =========================================
  // ✅ PACK PRODUCT SOCKET ROOMS
  // FE จะใช้ event นี้เพื่อเข้า room ตาม packProduct
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
  // =========================================
  socket.on(
    "transfer_doc:join",
    (payload: { no?: string; id?: number | string } | string) => {
      let noRaw: string | undefined;
      let idRaw: number | string | undefined;

      if (typeof payload === "string") {
        noRaw = payload;
      } else if (payload && typeof payload === "object") {
        noRaw = payload.no;
        idRaw = payload.id;
      }

      const no = String(noRaw ?? "").trim();
      const docId = Number(idRaw);

      if (no) {
        const roomNo = `transfer_doc:${no}`;
        socket.join(roomNo);
        console.log(`📄 ${socket.id} joined ${roomNo}`);
      }

      if (Number.isFinite(docId) && docId > 0) {
        const roomId = `transfer_doc-id:${docId}`;
        socket.join(roomId);
        console.log(`📄 ${socket.id} joined ${roomId}`);
      }
    },
  );

  socket.on(
    "transfer_doc:leave",
    (payload: { no?: string; id?: number | string } | string) => {
      let noRaw: string | undefined;
      let idRaw: number | string | undefined;

      if (typeof payload === "string") {
        noRaw = payload;
      } else if (payload && typeof payload === "object") {
        noRaw = payload.no;
        idRaw = payload.id;
      }

      const no = String(noRaw ?? "").trim();
      const docId = Number(idRaw);

      if (no) {
        const roomNo = `transfer_doc:${no}`;
        socket.leave(roomNo);
        console.log(`📄 ${socket.id} left ${roomNo}`);
      }

      if (Number.isFinite(docId) && docId > 0) {
        const roomId = `transfer_doc-id:${docId}`;
        socket.leave(roomId);
        console.log(`📄 ${socket.id} left ${roomId}`);
      }
    },
  );

  socket.on("disconnect", () => {
    console.log("🔴 socket disconnected:", socket.id);
  });

  socket.on("ping", () => socket.emit("pong"));
});

app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", database: "connected" });
  } catch (error) {
    console.error("❌ Database health check failed:", error);
    res.status(500).json({ status: "error", database: "disconnected" });
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
