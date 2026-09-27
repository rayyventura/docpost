import type { Request, Response, NextFunction } from 'express';

export function allowOptions(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
}
