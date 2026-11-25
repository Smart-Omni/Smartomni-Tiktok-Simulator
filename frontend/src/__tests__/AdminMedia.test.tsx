import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MediaPanel } from '../pages/console/MediaPanel';
import { MAX_MEDIA_BYTES, mediaFileProblem, uploadSimulatorMedia } from '../pages/console/mediaEndpoints';

const response = (data: unknown) => new Response(JSON.stringify({ code: 0, message: 'Success', data }), { headers: { 'content-type': 'application/json' } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('uploads the selected file as multipart and displays only returned media values', async () => {
  const fetcher = vi.fn(async () => response({ media_id: 'from-backend-42', media_url: 'https://simulator.smartomni.local/uploads/evidence.png' }));
  vi.stubGlobal('fetch', fetcher);
  render(<MediaPanel />);
  const file = new File(['real file bytes'], 'evidence.png', { type: 'image/png' });
  fireEvent.change(screen.getByLabelText('Media file'), { target: { files: [file] } });
  fireEvent.change(screen.getByLabelText('Custom media ID (optional)'), { target: { value: ' custom-media-1 ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Upload media' }));
  expect((await screen.findByRole('textbox', { name: 'Media ID' }) as HTMLInputElement).value).toBe('from-backend-42');
  const options = (fetcher.mock.calls as unknown as [string, RequestInit][])[0];
  expect(options[0]).toBe('/api/v2/media/upload');
  expect(options[1].method).toBe('POST');
  expect((options[1].body as FormData).get('file')).toBe(file);
  expect((options[1].body as FormData).get('media_id')).toBe('custom-media-1');
  expect(options[1].headers).toEqual({});
  expect((screen.getByRole('button', { name: 'Upload media' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Media file'), { target: { files: [new File(['next'], 'next.pdf')] } });
  expect(screen.queryByRole('textbox', { name: 'Media ID' })).toBeNull();
});

it('omits an empty custom media ID so the API can generate one', async () => {
  const fetcher = vi.fn<(url: string, options?: RequestInit) => Promise<Response>>(async () => response({ media_id: 'generated', media_url: 'https://simulator.smartomni.local/uploads/file.txt' }));
  vi.stubGlobal('fetch', fetcher);
  await uploadSimulatorMedia(new File(['x'], 'file.txt'), '   ');
  expect((fetcher.mock.calls[0][1]!.body as FormData).has('media_id')).toBe(false);
});

it('blocks empty, oversized and path-bearing filenames before the API call', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  expect(mediaFileProblem(new File([], 'empty.txt'))).toContain('not empty');
  expect(mediaFileProblem(new File(['x'], '../outside.txt'))).toContain('path');
  const file = new File([new Uint8Array(MAX_MEDIA_BYTES + 1)], 'large.pdf');
  await expect(uploadSimulatorMedia(file)).rejects.toThrow('5 MB');
  expect(fetcher).not.toHaveBeenCalled();
});

it('shows upload failure and does not retry or invent media results', async () => {
  const fetcher = vi.fn(async () => { throw new Error('offline'); });
  vi.stubGlobal('fetch', fetcher);
  render(<MediaPanel />);
  fireEvent.change(screen.getByLabelText('Media file'), { target: { files: [new File(['x'], 'evidence.pdf')] } });
  fireEvent.click(screen.getByRole('button', { name: 'Upload media' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Cannot reach');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('region', { name: 'Uploaded media' })).toBeNull();
});

it('rejects an application error even when HTTP is successful', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 8, message: 'Upload rejected' }))));
  await expect(uploadSimulatorMedia(new File(['x'], 'file.txt'))).rejects.toThrow('Upload rejected');
});
