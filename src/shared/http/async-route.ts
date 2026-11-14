import type { NextFunction, Request, Response } from 'express';

/** Wraps an async handler so rejected promises reach the error middleware. */
export function route<T>(handler: (req: Request, res: Response) => Promise<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}
