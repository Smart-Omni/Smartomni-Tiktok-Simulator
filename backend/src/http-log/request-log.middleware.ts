import { Inject, Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { MAX_BODY_CHARS, redactBody, redactHeaders, redactUrl, redactValue } from '../common/redaction';

export type RouterKind = 'TIKTOK' | 'DEMO' | 'TEST_ADMIN' | 'HEALTH';

export function classifyRouter(path: string): RouterKind {
  if (path === '/demo' || path.startsWith('/demo/')) return 'DEMO';
  if (path === '/test-admin' || path.startsWith('/test-admin/')) return 'TEST_ADMIN';
  // Swagger UI / OpenAPI JSON are documentation, not API traffic: never logged and never subject to injected faults.
  if (path === '/health' || path.startsWith('/health/') || path === '/api-docs' || path.startsWith('/api-docs/') || path === '/api-docs-json') return 'HEALTH';
  return 'TIKTOK';
}

/** Console polling reads must not flood the log they are displaying. */
export function shouldSkipLogging(method: string, path: string): boolean {
  const kind = classifyRouter(path);
  if (kind === 'HEALTH') return true;
  // image bytes are not worth a log row
  if (method === 'GET' && path.startsWith('/demo/media/images/')) return true;
  if (kind === 'TEST_ADMIN' && method === 'GET') {
    return /^\/test-admin\/(http-logs|webhooks|status|clock|shops|faults)/.test(path);
  }
  return false;
}

@Injectable()
export class RequestLogMiddleware implements NestMiddleware {
  private readonly logger = new Logger('http');

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header('x-request-id');
    const requestId = incoming && /^[\w.:-]{1,100}$/.test(incoming) ? incoming : randomUUID();
    (req as any).requestId = requestId;
    res.setHeader('x-request-id', requestId);

    const started = Date.now();
    const chunks: Buffer[] = [];
    let captured = 0;
    const origWrite = res.write.bind(res) as (...a: any[]) => boolean;
    const origEnd = res.end.bind(res) as (...a: any[]) => Response;
    const capture = (chunk: unknown) => {
      if (chunk && captured < MAX_BODY_CHARS * 2) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        chunks.push(buf);
        captured += buf.length;
      }
    };
    res.write = ((chunk: any, ...rest: any[]) => {
      capture(chunk);
      return origWrite(chunk, ...rest);
    }) as typeof res.write;
    res.end = ((chunk?: any, ...rest: any[]) => {
      if (typeof chunk !== 'function') capture(chunk);
      return origEnd(chunk, ...rest);
    }) as typeof res.end;

    res.on('finish', () => {
      const path = req.originalUrl.split('?')[0];
      if (shouldSkipLogging(req.method, path)) return;
      const responseText = Buffer.concat(chunks).toString('utf8');
      const reqBody =
        req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0
          ? JSON.stringify(req.body)
          : typeof req.body === 'string'
            ? req.body
            : undefined;
      const shopId = (req as any).shopId as string | undefined;
      this.prisma.httpRequestLog
        .create({
          data: {
            requestId,
            router: classifyRouter(path),
            method: req.method,
            path: redactUrl(path),
            query: redactValue(req.query) as any,
            requestHeaders: redactHeaders(req.headers as any) as any,
            requestBody: redactBody(reqBody),
            responseStatus: res.statusCode,
            responseHeaders: redactHeaders(res.getHeaders() as any) as any,
            responseBody: redactBody(responseText),
            durationMs: Date.now() - started,
            shopId: shopId ?? null,
          },
        })
        .catch((err: Error) => this.logger.warn(`failed to persist request log: ${err.message}`));
    });
    next();
  }
}
