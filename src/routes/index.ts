import { Router } from "express";
import authRoutes from "./auth.routes";
import userRoutes from "./user.routes";
import departmentRoutes from "./department.routes";
import buildingRoutes from "./building.routes";
import zoneTypeRoutes from "./zone_type.routes";
import locationRoutes from "./location.routes";
import zoneRoutes from "./zone.routes";
import barcodeRoutes from "./barcode.routes";
import stockRoutes from "./stock.routes";
import stockBalanceRoutes from "./stock_balance.routes";
import inboundRoutes from "./inbound.routes";
import goodsInRoutes from "./goods_in.routes";
import logsRoutes from "./logs.routes";
import outboundRoutes from "./outbound.routes";
import syncRoutes from "./sync.routes";
import eventGoodsRoutes from "./event_goods.routes";
import eventBarcodesRoutes from "./event_barcodes.routes";
import eventZoneTypeRoutes from "./event_zone_type.routes";
import { receiveFromOdoo } from "../controllers/inbound.odoo.controller";
import { receiveOutboundFromOdoo } from "../controllers/outbound.odoo.controller";
import { receiveAdjustFromOdoo } from "../controllers/adjust.odoo.controller";
import adjustRoutes from "./adjust.routes";
import barcodeCountDepartmentRoutes from "./barcode_count_department.routes";
import batchOutboundRoutes from "./batch_outbound.routes";
import transferRoutes from "./transfer.routes"
import transferMoveMentRoutes from "./transfer_movement.routes"
import borrowStockRoutes from "./borrow_stocks.routes"
import stockDairyRoutes from "./stockdairy.routes"
import swapRoutes from "./swap.routes"
import reportAllRoutes from "./reportall.route"
import goodsRoutes from "./goods.routes";
import localPrintRoutes from "./local_print.routes";
import {
  cancelAdjustment,
  confirmAdjustment,
  getAdjustmentDetail,
  listCombinedAdjustments,
  processAdjustment,
  receiveOdooAdjustments,
} from "../controllers/adjust.controller";

const router = Router();

router.get("/Adjust", listCombinedAdjustments);
router.get("/Adjust/:id", getAdjustmentDetail);
// ✅ 4 transitions as POST actions
router.post("/Adjust/:id/process", processAdjustment); // pending -> in-progress
router.post("/Adjust/:id/confirm", confirmAdjustment); // in-progress -> completed
router.post("/Adjust/:id/cancel", cancelAdjustment); // pending/in-progress -> cancelled
router.post("/Adjust", receiveOdooAdjustments); // Odoo webhook

// Odoo webhook endpoints (direct paths)
router.post("/Inbound", receiveFromOdoo);
router.post("/Outbound", receiveOutboundFromOdoo);
router.post("/AdjustManual", receiveAdjustFromOdoo);

// Event Goods routes (includes /EventGoods and /goods/sync)
router.use("/", eventGoodsRoutes);

// Event Barcodes routes (includes /EventBarcodes)
router.use("/", eventBarcodesRoutes);

// Event ZoneType routes (includes /EventZoneType)
router.use("/", eventZoneTypeRoutes);

router.use("/auth", authRoutes);
router.use("/users", userRoutes);
router.use("/departments", departmentRoutes);
router.use("/buildings", buildingRoutes);
router.use("/zone-types", zoneTypeRoutes);
router.use("/locations", locationRoutes);
router.use("/zones", zoneRoutes);
router.use("/barcodes", barcodeRoutes);
router.use("/stocks", stockRoutes);
router.use("/stock-balances", stockBalanceRoutes);
router.use("/inbounds", inboundRoutes);
router.use("/goods-ins", goodsInRoutes);
router.use("/logs", logsRoutes);
router.use("/outbounds", outboundRoutes);
router.use("/sync", syncRoutes);
router.use("/Adjust", adjustRoutes);
router.use("/barcode-count-departments", barcodeCountDepartmentRoutes);
router.use("/batch-outbounds", batchOutboundRoutes);
router.use("/transfers", transferRoutes);
router.use("/transfers-movements", transferMoveMentRoutes);
router.use("/borrow-stocks", borrowStockRoutes);
router.use("/reports", stockDairyRoutes);
router.use("/swaps", swapRoutes);
router.use("/all", reportAllRoutes);
router.use("/goods", goodsRoutes);
router.use("/local-print", localPrintRoutes);
export default router;
