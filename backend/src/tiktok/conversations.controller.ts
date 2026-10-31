import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UploadedFiles,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { promises as fs } from 'fs';
import { join } from 'path';
import { ChatService, ChatRuleError, MAX_TEXT_LENGTH } from '../chat/chat.service';
import { conversationItem, messageItem, participants } from '../chat/chat.mapper';
import { TiktokFault } from '../common/tiktok-fault';
import { APP_CONFIG, AppConfig } from '../config/config';
import { SCOPE_CONVERSATION_READ, SCOPE_CONVERSATION_WRITE } from '../oauth/scopes';
import { PrismaService } from '../prisma/prisma.service';
import { parseRawQuery } from './signature';
import { RequireScope, TiktokApiGuard, TiktokRequest } from './tiktok-api.guard';
import { TiktokFaultFilter } from './tiktok-fault.filter';

/** Message types the OAS lists for Send Message. */
const OAS_SEND_TYPES = new Set(['TEXT', 'IMAGE', 'VIDEO', 'PRODUCT_CARD', 'ORDER_CARD', 'RETURN_REFUND_CARD', 'COUPON_CARD', 'LOGISTICS_CARD']);

interface ListCursor {
  s: number;
}
interface MsgCursor {
  k: number;
  s: number;
  f: 'create_time' | 'index';
  o: 'ASC' | 'DESC';
}
const enc = (c: object): string => Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
function dec<T>(raw: string, ok: (c: Partial<T>) => boolean): T {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<T>;
    if (ok(c)) return c as T;
  } catch {
    /* fall through */
  }
  throw new TiktokFault(400, 'invalid_input', 'page_token is not a token issued by this API');
}
function pageSize(query: Record<string, string>, max: number): number {
  if (!/^\d{1,4}$/.test(query.page_size ?? '')) throw new TiktokFault(400, 'invalid_input', `page_size is required and must be an integer in [1, ${max}]`);
  const n = Number(query.page_size);
  if (n < 1 || n > max) throw new TiktokFault(400, 'invalid_input', `page_size must be in [1, ${max}]`);
  return n;
}

/**
 * Customer-service API: Get Conversation List (202309), Get Conversation Messages (202309),
 * Get Conversation Detail (202601), Send Message (202309 & 202606), Upload Image (202309).
 */
@Controller()
@UseFilters(TiktokFaultFilter)
export class ConversationsController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('customer_service/202309/conversations')
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_CONVERSATION_READ)
  async list(@Req() req: TiktokRequest) {
    const { shop } = req.tiktok!;
    const query = parseRawQuery(req.originalUrl)!.query;
    const size = pageSize(query, 20);
    const after = query.page_token ? dec<ListCursor>(query.page_token, (c) => Number.isSafeInteger(c.s)).s : 0;
    const rows = await this.prisma.conversation.findMany({ where: { shopId: shop.id, seq: { gt: after } }, orderBy: { seq: 'asc' }, take: size + 1 });
    const page = rows.slice(0, size);
    const items = [];
    for (const c of page) {
      const latest = await this.prisma.chatMessage.findFirst({ where: { conversationId: c.id }, orderBy: { seq: 'desc' } });
      items.push(conversationItem(c, shop.name, latest, await this.chat.unreadFor(c)));
    }
    return this.envelope(req, { conversations: items, next_page_token: rows.length > size ? enc({ s: page[page.length - 1].seq }) : '' });
  }

  @Get('customer_service/202309/conversations/:conversationId/messages')
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_CONVERSATION_READ)
  async messages(@Req() req: TiktokRequest, @Param('conversationId') conversationId: string) {
    const { shop } = req.tiktok!;
    const query = parseRawQuery(req.originalUrl)!.query;
    const size = pageSize(query, 10);
    const sortField = (query.sort_field ?? 'create_time') as 'create_time' | 'index';
    if (sortField !== 'create_time' && sortField !== 'index') throw new TiktokFault(400, 'invalid_input', 'sort_field must be create_time or index');
    const order = query.sort_order ?? 'DESC';
    if (order !== 'ASC' && order !== 'DESC') throw new TiktokFault(400, 'invalid_input', 'sort_order must be ASC or DESC');
    const conversation = await this.chat.ownedByShop(shop.id, conversationId);
    if (!conversation) throw new TiktokFault(404, 'conversation_not_found', 'conversation does not exist in this shop');
    const cursor = query.page_token ? dec<MsgCursor>(query.page_token, (c) => Number.isSafeInteger(c.k) && Number.isSafeInteger(c.s) && (c.f === 'create_time' || c.f === 'index') && (c.o === 'ASC' || c.o === 'DESC')) : null;
    if (cursor && (cursor.f !== sortField || cursor.o !== order)) throw new TiktokFault(400, 'invalid_input', 'page_token was issued for a different sort_field/sort_order');
    const col = sortField === 'create_time' ? 'createdAt' : 'index';
    const key = (v: Date | number): Date | number => (col === 'createdAt' ? new Date(v) : v);
    const cmp = order === 'ASC' ? 'gt' : 'lt';
    const base: Prisma.ChatMessageWhereInput = { conversationId: conversation.id };
    const where: Prisma.ChatMessageWhereInput = cursor ? { AND: [base, { OR: [{ [col]: { [cmp]: key(cursor.k) } }, { [col]: key(cursor.k), seq: { [cmp]: cursor.s } }] }] } : base;
    const dir = order === 'ASC' ? 'asc' : 'desc';
    const rows = await this.prisma.chatMessage.findMany({ where, orderBy: [{ [col]: dir }, { seq: dir }], take: size + 1 });
    const page = rows.slice(0, size);
    const last = page[page.length - 1];
    const lastKey = last ? (col === 'createdAt' ? last.createdAt.getTime() : last.index) : 0;
    return this.envelope(req, {
      messages: page.map((m) => messageItem(m, query.need_data === 'true')),
      next_page_token: rows.length > size && last ? enc({ k: lastKey, s: last.seq, f: sortField, o: order } satisfies MsgCursor) : '',
      unsupported_msg_tips: 'This message type is not supported by the simulator; check it in the simulator Seller view.',
    });
  }

  @Get('customer_service/202601/conversations/:conversationId')
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_CONVERSATION_READ)
  async detail(@Req() req: TiktokRequest, @Param('conversationId') conversationId: string) {
    const { shop } = req.tiktok!;
    const c = await this.chat.ownedByShop(shop.id, conversationId);
    if (!c) throw new TiktokFault(404, 'conversation_not_found', 'conversation does not exist in this shop');
    return this.envelope(req, {
      conversation: {
        id: c.externalId,
        create_time: Math.floor(c.createdAt.getTime() / 1000),
        participant_count: c.agentJoined ? 3 : 2,
        participants: participants(c, shop.name),
        unread_count: await this.chat.unreadFor(c),
      },
    });
  }

  /**
   * Send Message 202309 (TEXT only).
   */
  @Post('customer_service/202309/conversations/:conversationId/messages')
  @HttpCode(200)
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_CONVERSATION_WRITE)
  async send(@Req() req: TiktokRequest, @Res({ passthrough: true }) res: Response, @Param('conversationId') conversationId: string) {
    const { shop } = req.tiktok!;
    const body = (req.body ?? {}) as { type?: unknown; content?: unknown };
    const type = body.type;
    if (typeof type !== 'string' || !OAS_SEND_TYPES.has(type)) throw new TiktokFault(400, 'invalid_input', 'type is not a documented message type');
    if (type !== 'TEXT') throw new TiktokFault(400, 'invalid_input', `message type ${type} is not supported by the simulator (TEXT only)`);
    if (typeof body.content !== 'string') throw new TiktokFault(400, 'invalid_input', 'content must be a JSON-serialized string');
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.content);
    } catch {
      throw new TiktokFault(400, 'invalid_input', 'content is not valid JSON');
    }
    const keys = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : [];
    const text = (parsed as { content?: unknown } | null)?.content;
    if (keys.length !== 1 || keys[0] !== 'content' || typeof text !== 'string' || text.trim() === '' || text.length > MAX_TEXT_LENGTH) {
      throw new TiktokFault(400, 'invalid_input', `TEXT content must be {"content": "<1-${MAX_TEXT_LENGTH} chars>"}`);
    }
    const conversation = await this.chat.ownedByShop(shop.id, conversationId);
    if (!conversation) throw new TiktokFault(404, 'conversation_not_found', 'conversation does not exist in this shop');
    if (!conversation.canSendMessage) throw new TiktokFault(400, 'cannot_send_message', 'can_send_message is false for this conversation');
    try {
      const { message, conversation: c } = await this.chat.postText(conversation.id, 'SHOP', text, { requestId: req.requestId });
      if (c.dropSendResponse) {
        res.socket?.destroy(); // stored, event emitted, but the sender never learns the outcome
        return undefined;
      }
      return this.envelope(req, { message_id: message.externalId });
    } catch (e) {
      if (e instanceof ChatRuleError) throw new TiktokFault(400, 'invalid_input', e.message);
      throw e;
    }
  }

  /**
   * Send Message 202606: supports TEXT and IMAGE.
   */
  @Post('customer_service/202606/conversations/:conversationId/messages')
  @HttpCode(200)
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_CONVERSATION_WRITE)
  async send202606(@Req() req: TiktokRequest, @Res({ passthrough: true }) res: Response, @Param('conversationId') conversationId: string) {
    const { shop } = req.tiktok!;
    const body = (req.body ?? {}) as { type?: unknown; content?: unknown };
    const type = typeof body.type === 'string' ? body.type : 'TEXT';
    if (type !== 'TEXT' && type !== 'IMAGE') {
      throw new TiktokFault(400, 'invalid_input', `message type ${type} is not supported (TEXT and IMAGE supported)`);
    }
    if (typeof body.content !== 'string') throw new TiktokFault(400, 'invalid_input', 'content must be a JSON-serialized string');
    let parsed: any;
    try {
      parsed = JSON.parse(body.content);
    } catch {
      throw new TiktokFault(400, 'invalid_input', 'content is not valid JSON');
    }

    if (type === 'TEXT') {
      const text = parsed?.content;
      if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_TEXT_LENGTH) {
        throw new TiktokFault(400, 'invalid_input', `TEXT content must be {"content": "<1-${MAX_TEXT_LENGTH} chars>"}`);
      }
    } else if (type === 'IMAGE') {
      const url = parsed?.url || parsed?.image_url;
      if (!url && !parsed?.image_id) {
        throw new TiktokFault(400, 'invalid_input', 'IMAGE content must contain url or image_id');
      }
    }

    const conversation = await this.chat.ownedByShop(shop.id, conversationId);
    if (!conversation) throw new TiktokFault(404, 'conversation_not_found', 'conversation does not exist in this shop');
    if (!conversation.canSendMessage) throw new TiktokFault(400, 'cannot_send_message', 'can_send_message is false for this conversation');

    try {
      const { message, conversation: c } = await this.chat.postRaw(conversation.id, 'SHOP', type, body.content, { requestId: req.requestId });
      if (c.dropSendResponse) {
        res.socket?.destroy();
        return undefined;
      }
      return this.envelope(req, { message_id: message.externalId });
    } catch (e) {
      if (e instanceof ChatRuleError) throw new TiktokFault(400, 'invalid_input', e.message);
      throw e;
    }
  }

  /**
   * Upload Image (POST /customer_service/202309/images/upload).
   */
  @Post('customer_service/202309/images/upload')
  @HttpCode(200)
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_CONVERSATION_WRITE)
  @UseInterceptors(AnyFilesInterceptor())
  async uploadImage(
    @Req() req: TiktokRequest,
    @UploadedFiles() files?: Array<any>,
  ) {
    const file = files && files.length > 0 ? files[0] : undefined;
    const fileName = file?.originalname || 'chat_image.jpg';
    if (file?.buffer) {
      try {
        await fs.mkdir(this.config.mediaDir, { recursive: true });
        await fs.writeFile(join(this.config.mediaDir, fileName), file.buffer);
      } catch {
        /* Ignore disk write errors in restricted test environment */
      }
    }

    return this.envelope(req, {
      url: `https://simulator.smartomni.local/uploads/${fileName}`,
      width: 1280,
      height: 720,
    });
  }

  private envelope(req: TiktokRequest, data: unknown) {
    return { code: 0, message: 'Success', request_id: req.requestId ?? 'unknown', data };
  }
}
