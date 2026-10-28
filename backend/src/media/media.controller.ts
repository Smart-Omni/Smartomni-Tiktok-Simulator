import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  UploadedFiles,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { promises as fs } from 'fs';
import { join } from 'path';
import type { Request } from 'express';
import { APP_CONFIG, AppConfig } from '../config/config';
import { TiktokFaultFilter } from '../tiktok/tiktok-fault.filter';

export interface UploadedMediaFile {
  fieldname?: string;
  originalname: string;
  encoding?: string;
  mimetype?: string;
  size?: number;
  buffer?: Buffer;
  destination?: string;
  filename?: string;
  path?: string;
}

@Controller()
@UseFilters(TiktokFaultFilter)
export class MediaController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Post('api/v2/media/upload')
  @HttpCode(200)
  @UseInterceptors(AnyFilesInterceptor())
  async uploadMedia(
    @Req() req: Request,
    @UploadedFiles() files?: Array<UploadedMediaFile>,
    @Body() body?: Record<string, unknown>,
  ) {
    const file = files && files.length > 0 ? files[0] : undefined;
    const fileName =
      file?.originalname ||
      (typeof body?.file_name === 'string' && body.file_name.length > 0 ? body.file_name : 'mock_evidence.jpg');

    if (file?.buffer) {
      try {
        await fs.mkdir(this.config.mediaDir, { recursive: true });
        await fs.writeFile(join(this.config.mediaDir, fileName), file.buffer);
      } catch {
        // Disk write failure in restricted test environments should not break mock API response
      }
    }

    const mediaId =
      typeof body?.media_id === 'string' && body.media_id.length > 0
        ? body.media_id
        : fileName === 'mock_evidence.jpg'
          ? 'mock_media_123456'
          : `mock_media_${Date.now()}`;

    const mediaUrl = `https://simulator.smartomni.local/uploads/${fileName}`;

    return {
      code: 0,
      message: 'Success',
      data: {
        media_id: mediaId,
        media_url: mediaUrl,
      },
    };
  }
}
