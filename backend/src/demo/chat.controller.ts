import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ChatMessage, Conversation } from '@prisma/client';
import { z } from 'zod';
import { ChatService, parseText, SUPPORTED_MESSAGE_TYPES } from '../chat/chat.service';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertShopAccess,
  DemoPrincipal,
  DemoRequest,
  DemoSessionGuard,
} from './demo-session.guard';

const TextBody = z.object({ text: z.string().min(1).max(2000) });

const roleLabel = (r: string): string => ({ BUYER: 'Buyer', SHOP: 'Shop', CUSTOMER_SERVICE: 'Agent', SYSTEM: 'System', ROBOT: 'Robot' })[r] ?? r;

/** UI view of a message: unsupported types are listed explicitly, never silently rendered as text. */
export function chatMessageView(m: ChatMessage) {
  const supported = (SUPPORTED_MESSAGE_TYPES as readonly string[]).includes(m.type);
  return { id: m.externalId, index: m.index, type: m.type, role: m.senderRole, roleLabel: roleLabel(m.senderRole), nickname: m.senderNickname, at: m.createdAt.toISOString(), text: supported ? parseText(m.content) : null, supported, visible: m.isVisible };
}

function principal(req: DemoRequest): DemoPrincipal {
  return req.demo!;
}

/** Buyer and Seller chat. /demo only: the TikTok API reads and sends through its own signed endpoints. Text only (see `supportedTypes`). */
@Controller()
export class ChatDemoController {
  constructor(
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  private async summary(c: Conversation) {
    const [latest, unread] = await Promise.all([this.prisma.chatMessage.findFirst({ where: { conversationId: c.id }, orderBy: { seq: 'desc' } }), this.chat.unreadFor(c)]);
    return { id: c.id, externalId: c.externalId, buyerNickname: c.buyerNickname, agentJoined: c.agentJoined, canSendMessage: c.canSendMessage, unread, latest: latest ? chatMessageView(latest) : null, updatedAt: c.updatedAt.toISOString() };
  }

  /** Buyer: the own conversation (if any). Seller: every conversation of the shop. */
  @Get('shops/:shopId/chat/conversations')
  @UseGuards(DemoSessionGuard)
  async conversations(@Req() req: DemoRequest, @Param('shopId') shopId: string) {
    const p = principal(req);
    await assertShopAccess(p, shopId, this.prisma);
    const rows = await this.prisma.conversation.findMany({ where: { shopId, ...(p.role === 'BUYER' ? { buyerId: p.buyerId } : {}) }, orderBy: { seq: 'asc' } });
    return { supportedTypes: SUPPORTED_MESSAGE_TYPES, unsupported: 'IMAGE, VIDEO, PRODUCT_CARD, ORDER_CARD, RETURN_REFUND_CARD, COUPON_CARD, LOGISTICS_CARD (uploads and cards are not simulated)', items: await Promise.all(rows.map((c) => this.summary(c))) };
  }

  @Get('shops/:shopId/chat/conversations/:conversationId/messages')
  @UseGuards(DemoSessionGuard)
  async messages(@Req() req: DemoRequest, @Param('shopId') shopId: string, @Param('conversationId') conversationId: string) {
    const p = principal(req);
    await assertShopAccess(p, shopId, this.prisma);
    const c = await this.chat.assertParticipant({ role: p.role, shopId, buyerId: p.buyerId }, conversationId);
    const rows = await this.prisma.chatMessage.findMany({ where: { conversationId: c.id, isVisible: true }, orderBy: { index: 'asc' }, take: 500 });
    return { conversation: await this.summary(c), items: rows.map(chatMessageView) };
  }

  /** Buyer: starts or continues the own conversation with the shop. */
  @Post('shops/:shopId/chat/messages')
  @UseGuards(DemoSessionGuard)
  async buyerSend(@Req() req: DemoRequest, @Param('shopId') shopId: string, @Body(new ZodPipe(TextBody)) body: z.infer<typeof TextBody>) {
    const p = principal(req);
    await assertShopAccess(p, shopId, this.prisma);
    if (p.role !== 'BUYER' || !p.buyerId) throw new ForbiddenException('Only a buyer session can start a conversation');
    const conversation = await this.chat.conversationForBuyer(shopId, p.buyerId);
    return this.send(req, conversation.id, 'BUYER', body.text);
  }

  /** Seller replies; a buyer may also continue the own conversation. */
  @Post('shops/:shopId/chat/conversations/:conversationId/messages')
  @UseGuards(DemoSessionGuard)
  async reply(@Req() req: DemoRequest, @Param('shopId') shopId: string, @Param('conversationId') conversationId: string, @Body(new ZodPipe(TextBody)) body: z.infer<typeof TextBody>) {
    const p = principal(req);
    await assertShopAccess(p, shopId, this.prisma);
    const c = await this.chat.assertParticipant({ role: p.role, shopId, buyerId: p.buyerId }, conversationId);
    if (p.role === 'SELLER' && !c.canSendMessage) throw new BadRequestException({ code: 'cannot_send_message', message: 'The shop cannot send messages in this conversation' });
    return this.send(req, c.id, p.role === 'SELLER' ? 'SHOP' : 'BUYER', body.text);
  }

  private async send(req: DemoRequest, conversationId: string, role: 'BUYER' | 'SHOP', text: string) {
    const { message } = await this.chat.postText(conversationId, role, text, { requestId: (req as { requestId?: string }).requestId });
    return { message: chatMessageView(message) };
  }
}
