import { Router } from "express";
//import { auth } from "../middleware/auth";
import {
  createInvoice,
  getInvoices,
  getInvoicesPaginated,
  getInvoiceById,
  getInvoiceByInvoiceBarcode,
  getInvoiceByGoodsOutId,
  updateInvoice,
  deleteInvoice,
} from "../controllers/invoice.controller";

import {
  getInvoiceItemById,
  updateInvoiceItemLotQty,
  // changeLotAndQtyByInvoiceItemId, // ถ้ามีปุ่ม confirm เปลี่ยน lot/qty
} from "../controllers/invoice_item.controller";

const router = Router();

router.post("/create", createInvoice);
router.get("/getAll", getInvoices);
router.get("/get", getInvoicesPaginated);
router.get("/get/:invoice_barcode", getInvoiceByInvoiceBarcode);
router.get("/get/goods_outs/:id", getInvoiceByGoodsOutId);
router.get("/get/invoice_items/:id", getInvoiceItemById);
router.patch("/update/invoice_items/:id", updateInvoiceItemLotQty);
router.get("/get/:id", getInvoiceById);
router.patch("/update/:id", updateInvoice);
router.delete("/delete/:id", deleteInvoice);

export default router;
