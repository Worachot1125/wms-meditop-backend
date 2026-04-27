import axios, { AxiosInstance } from "axios";

interface OdooConfig {
  url: string;
  db: string;
  username: string;
  password: string;
}

interface OdooAuthResponse {
  jsonrpc: string;
  id: number;
  result: {
    uid: number;
    session_id: string;
  };
}

interface OdooSearchReadResponse {
  jsonrpc: string;
  id: number;
  result: any[];
}

export class OdooService {
  private config: OdooConfig;
  private client?: AxiosInstance;
  private uid: number | null = null;
  private sessionId: string | null = null;

  constructor() {
    this.config = {
      url: process.env.ODOO_URL || "",
      db: process.env.ODOO_DB || "",
      username: process.env.ODOO_USERNAME || "",
      password: process.env.ODOO_PASSWORD || "",
    };

    if (!this.config.url || !this.config.db || !this.config.username || !this.config.password) {
      console.warn("⚠️ Odoo Web API env not configured. OdooService disabled.");
      console.warn("💡 For database sync, use odooDbService instead.");
      // Don't throw error - allow app to start
      return;
    }

    this.client = axios.create({
      baseURL: this.config.url,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  /**
   * Authenticate with Odoo and get UID
   */
  async authenticate(): Promise<void> {
    if (!this.client) {
      throw new Error("Odoo client not initialized. Check environment variables.");
    }
    try {
      const response = await this.client.post<OdooAuthResponse>("/web/session/authenticate", {
        jsonrpc: "2.0",
        method: "call",
        params: {
          db: this.config.db,
          login: this.config.username,
          password: this.config.password,
        },
        id: Math.floor(Math.random() * 1000000),
      });

      if (response.data.result?.uid) {
        this.uid = response.data.result.uid;
        this.sessionId = response.data.result.session_id;
      } else {
        throw new Error("Odoo authentication failed: No UID returned");
      }
    } catch (error) {
      throw new Error(`Odoo authentication error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Ensure authenticated before making requests
   */
  private async ensureAuthenticated(): Promise<void> {
    if (!this.uid) {
      await this.authenticate();
    }
  }

  /**
   * Generic search_read method for Odoo models
   */
  async searchRead(
    model: string,
    domain: any[] = [],
    fields: string[] = [],
    limit?: number,
    offset?: number
  ): Promise<any[]> {
    await this.ensureAuthenticated();

    if (!this.client) {
      throw new Error("Odoo client not initialized. Check environment variables.");
    }

    try {
      const response = await this.client.post<OdooSearchReadResponse>("/web/dataset/call_kw", {
        jsonrpc: "2.0",
        method: "call",
        params: {
          model: model,
          method: "search_read",
          args: [],
          kwargs: {
            domain: domain,
            fields: fields.length > 0 ? fields : undefined,
            limit: limit,
            offset: offset,
          },
        },
        id: Math.floor(Math.random() * 1000000),
      });

      return response.data.result || [];
    } catch (error) {
      throw new Error(
        `Odoo search_read error for model ${model}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Query Odoo view with schema (for WMS master data sync)
   * Example: SELECT * FROM wms.wms_mdt_goods
   */
  async queryView(viewName: string): Promise<any[]> {
    await this.ensureAuthenticated();

    if (!this.client) {
      throw new Error("Odoo client not initialized. Check environment variables.");
    }

    try {
      // Use SQL view access in Odoo
      const response = await this.client.post("/web/dataset/call_kw", {
        jsonrpc: "2.0",
        method: "call",
        params: {
          model: viewName, // e.g., "wms.wms_mdt_goods"
          method: "search_read",
          args: [],
          kwargs: {
            domain: [],
            fields: [], // Get all fields
          },
        },
        id: Math.floor(Math.random() * 1000000),
      });

      return response.data.result || [];
    } catch (error) {
      throw new Error(
        `Odoo view query error for ${viewName}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Fetch all goods (products with full details) from Odoo
   * Uses WMS view: wms.wms_mdt_goods
   */
  async getGoods(): Promise<any[]> {
    try {
      // Try to use WMS view first
      return await this.queryView("wms.wms_mdt_goods");
    } catch (error) {
      // Fallback to product.product if view doesn't exist
      console.warn("WMS view not available, falling back to product.product");
      const results = await this.searchRead(
        "product.product",
        [["active", "in", [true, false]]], // Get both active and inactive
        [
          "id",
          "default_code",
          "name",
          "type",
          "tracking",
          "x_department_id",
          "x_department_name",
          "x_zone_id",
          "x_zone_name",
          "uom_id",
          "active"
        ]
      );

      // Map Odoo fields to our format
      return results.map((product: any) => ({
        product_id: product.id,
        code: product.default_code || "",
        name: product.name || "",
        type: product.type || "product",
        tracking: product.tracking || "none",
        department_id: product.x_department_id || 0,
        department: product.x_department_name || "",
        zone_id: product.x_zone_id || 0,
        zone: product.x_zone_name || "",
        unit: Array.isArray(product.uom_id) ? product.uom_id[1] : (product.uom_id || ""),
        active: product.active !== false,
      }));
    }
  }

  /**
   * Fetch all barcodes from Odoo
   * Uses WMS view: wms.wms_mdt_barcode
   */
  async getBarcodes(): Promise<any[]> {
    try {
      return await this.queryView("wms.wms_mdt_barcode");
    } catch (error) {
      console.warn("WMS barcode view not available");
      return [];
    }
  }

  /**
   * Fetch all zone types from Odoo
   * Uses WMS view: wms.wms_mdt_zone_type
   */
  async getZoneTypes(): Promise<any[]> {
    try {
      return await this.queryView("wms.wms_mdt_zone_type");
    } catch (error) {
      console.warn("WMS zone_type view not available");
      return [];
    }
  }

  /**
   * Fetch all departments from Odoo
   * Uses WMS view: wms.wms_mdt_department
   */
  async getDepartments(): Promise<any[]> {
    try {
      return await this.queryView("wms.wms_mdt_department");
    } catch (error) {
      // Fallback to hr.department if view doesn't exist
      console.warn("WMS department view not available, falling back to hr.department");
      const results = await this.searchRead(
        "hr.department",
        [],
        ["id", "name", "complete_name", "write_date"]
      );
      
      // Map Odoo fields to our format
      return results.map((dept: any) => ({
        id: dept.id,
        name: dept.name || "",
        code: dept.complete_name || dept.name || "",
        write_date: dept.write_date,
      }));
    }
  }

  /**
   * Fetch all stock locations from Odoo
   */
  async getLocations(): Promise<any[]> {
    return await this.searchRead(
      "stock.location",
      [],
      ["id", "name", "complete_name", "location_id", "usage", "write_date"]
    );
  }
}

// Lazy singleton instance (for Odoo Web API - not used currently)
// Use odooDbService for direct database access instead
let odooServiceInstance: OdooService | null = null;

export const getOdooService = (): OdooService => {
  if (!odooServiceInstance) {
    odooServiceInstance = new OdooService();
  }
  return odooServiceInstance;
};

// Keep old export for backward compatibility (but lazy init)
export const odooService = getOdooService();
