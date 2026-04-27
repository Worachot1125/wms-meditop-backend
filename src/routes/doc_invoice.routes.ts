import { Router } from "express";
//import { auth } from "../middleware/auth";
import {
  createDocInvoice,
  getDocInvoices,
  getDocInvoicesPaginated,
  getDocInvoiceById,
  getDocInvoiceByDocBarcode,
  updateDocInvoice,
  deleteDocInvoice,
} from "../controllers/doc_invoice.controller";

const router = Router();

router.post("/create", createDocInvoice);
router.get("/getAll", getDocInvoices);
router.get("/get", getDocInvoicesPaginated);
router.get("/get/:doc_barcode", getDocInvoiceByDocBarcode);
router.get("/get/:id", getDocInvoiceById);
router.patch("/update/:id", updateDocInvoice);
router.delete("/delete/:id", deleteDocInvoice);

export default router;
