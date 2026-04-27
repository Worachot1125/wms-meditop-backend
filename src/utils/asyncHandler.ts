import type {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import type { ParamsDictionary } from "express-serve-static-core";
import type { ParsedQs } from "qs";

export const asyncHandler =
  <
    P = ParamsDictionary,
    ResBody = any,
    ReqBody = any,
    ReqQuery = ParsedQs,
    Locals extends Record<string, any> = Record<string, any>
  >(
    fn: (
      req: Request<P, ResBody, ReqBody, ReqQuery, Locals>,
      res: Response<ResBody, Locals>,
      next: NextFunction
    ) => Promise<any>
  ): RequestHandler<P, ResBody, ReqBody, ReqQuery, Locals> =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
