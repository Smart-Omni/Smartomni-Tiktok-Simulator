import { BadRequestException, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { BusinessClock } from '../clock/clock';
import { APP_CONFIG, AppConfig } from '../config/config';
import { isMediaId, MAX_IMAGE_BYTES, storeImage } from '../media/media-store';
import { PrismaService } from '../prisma/prisma.service';
import { assertSellerShop, DemoRequest, DemoSessionGuard } from './demo-session.guard';

/**
 * Product images uploaded from the Seller Center, stored in PostgreSQL (`MediaAsset`), so they survive a redeploy
 * without a disk. Upload is per shop and seller-only; reading is public because an <img> cannot send the session header.
 */
@Controller()
export class MediaDemoController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(BusinessClock) private readonly clock: BusinessClock,
  ) {}

  @Post('shops/:shopId/media/images')
  @HttpCode(201)
  @UseGuards(DemoSessionGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } }))
  async upload(@Req() req: DemoRequest, @Param('shopId') shopId: string, @UploadedFile() file?: { buffer?: Buffer }) {
    assertSellerShop(req.demo!, shopId);
    if (!file?.buffer) throw new BadRequestException('Send the picture as the multipart field "file"');
    const stored = await storeImage(this.prisma, shopId, file.buffer, this.config.publicApiBaseUrl, this.clock.now());
    if (stored === 'not_an_image') throw new BadRequestException('Only JPEG, PNG or WebP images are accepted');
    if (stored === 'too_large') throw new BadRequestException('The image is larger than 5 MB');
    return { uri: stored.uri, url: stored.url, width: stored.width, height: stored.height, mimeType: stored.mimeType, sizeBytes: stored.sizeBytes };
  }

  @Get('media/images/:id')
  async image(@Param('id') id: string, @Res() res: Response): Promise<void> {
    if (!isMediaId(id)) throw new NotFoundException();
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id }, select: { mimeType: true, bytes: true } });
    if (!asset) throw new NotFoundException();
    // Content never changes for an id, so browsers may keep it.
    res.setHeader('Content-Type', asset.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(Buffer.from(asset.bytes));
  }
}
