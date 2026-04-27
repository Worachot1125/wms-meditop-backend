export interface UpdateInvoiceItemLotQtyBody {
  lot_no: string;        // lot ใหม่ของ goods_out
  quantity: number;
  pick: number;
  pack: number;
}
