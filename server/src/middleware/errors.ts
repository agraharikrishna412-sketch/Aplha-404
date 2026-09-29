/** Consistent error envelope for every endpoint + typed error class. */
import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { redactSecrets } from '../services/crypto.js';
import { AIError } from '../services/ai/errors.js';

export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;
  hint?: string;

  constructor(status: number, message: string, code = 'error', details?: unknown, hint?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.hint = hint;
  }
}

export function badRequest(message: string, details?: unknown): HttpError {
  return new HttpError(400, message, 'bad_request', details);
}

export function notFound(message = 'Not found'): HttpError {
  return new HttpError(404, message, 'not_found');
}

/** Validates a request payload and throws a 400 with field-level details. */
export function parseBody<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'body',
      message: issue.message,
    }));
    throw new HttpError(400, issues[0]?.message ?? 'Invalid request.', 'validation_error', issues);
  }
  return result.data;
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: { message: 'That endpoint does not exist.', code: 'not_found' } });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const path = req.path;

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        message: err.issues[0]?.message ?? 'Invalid request.',
        code: 'validation_error',
        details: err.issues.map((i) => ({ field: i.path.join('.') || 'body', message: i.message })),
      },
    });
    return;
  }

  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: {
        message: err.message,
        code: err.code,
        details: err.details,
        hint: err.hint,
      },
    });
    return;
  }

  if (err instanceof AIError) {
    // AI failures are expected operational events, not server faults.
    res.status(503).json({
      error: {
        message: redactSecrets(err.message),
        code: err.kind,
        hint: err.policy.userMessage,
      },
    });
    return;
  }

  const message = err instanceof Error ? redactSecrets(err.message) : 'Unexpected server error.';
  // Never log request bodies (they can carry pasted notes / keys in edge cases).
  console.error(`[vroqn] ${req.method} ${path} failed: ${message}`);
  res.status(500).json({
    error: { message: 'Something went wrong on our side. Please try again.', code: 'server_error' },
  });
}

/** Wraps async handlers so rejected promises reach the error handler. */
export function asyncRoute<T extends (req: Request, res: Response, next: NextFunction) => Promise<unknown>>(fn: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}
