import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from './helpers';

describe('Mock Media Upload API', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    app = await createApp();
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await app.close();
  });

  it('uploads multipart/form-data file and returns standard TikTok Open API envelope', async () => {
    const fileContent = Buffer.from('fake image binary content for testing');

    const res = await http
      .post('/api/v2/media/upload')
      .attach('file', fileContent, 'mock_evidence.jpg')
      .expect(200);

    expect(res.body).toEqual({
      code: 0,
      message: 'Success',
      data: {
        media_id: 'mock_media_123456',
        media_url: 'https://simulator.smartomni.local/uploads/mock_evidence.jpg',
      },
    });
  });

  it('accepts video or different filename and returns custom media_url and generated media_id', async () => {
    const videoContent = Buffer.from('fake video mp4 binary');

    const res = await http
      .post('/api/v2/media/upload')
      .attach('data', videoContent, 'dispute_video.mp4')
      .expect(200);

    expect(res.body.code).toBe(0);
    expect(res.body.message).toBe('Success');
    expect(res.body.data.media_id).toMatch(/^mock_media_/);
    expect(res.body.data.media_url).toBe('https://simulator.smartomni.local/uploads/dispute_video.mp4');
  });

  it('allows custom media_id in body if specified', async () => {
    const fileContent = Buffer.from('fake proof image');

    const res = await http
      .post('/api/v2/media/upload')
      .field('media_id', 'custom_media_999888')
      .attach('file', fileContent, 'custom_proof.jpg')
      .expect(200);

    expect(res.body.code).toBe(0);
    expect(res.body.message).toBe('Success');
    expect(res.body.data.media_id).toBe('custom_media_999888');
    expect(res.body.data.media_url).toBe('https://simulator.smartomni.local/uploads/custom_proof.jpg');
  });

  it('handles request without attachment by falling back gracefully', async () => {
    const res = await http
      .post('/api/v2/media/upload')
      .send({})
      .expect(200);

    expect(res.body).toEqual({
      code: 0,
      message: 'Success',
      data: {
        media_id: 'mock_media_123456',
        media_url: 'https://simulator.smartomni.local/uploads/mock_evidence.jpg',
      },
    });
  });
});
