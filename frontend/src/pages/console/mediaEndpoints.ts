import { api, ApiError } from '../../lib/api';

export interface MediaUploadResult { media_id: string; media_url: string }
// Keep multipart uploads below the 6 MB nginx request limit (including overhead).
export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
export function mediaFileProblem(file: File): string | undefined {
  if (!file.size) return 'Choose a file that is not empty.';
  if (file.size > MAX_MEDIA_BYTES) return 'Choose a file of 5 MB or less.';
  if (/[\\/]/.test(file.name) || file.name === '.' || file.name === '..') return 'The filename must not contain a path.';
  return undefined;
}
export async function uploadSimulatorMedia(file: File, customMediaId = ''): Promise<MediaUploadResult> {
  const problem = mediaFileProblem(file);
  if (problem) throw new Error(problem);
  const body = new FormData();
  body.append('file', file);
  if (customMediaId.trim()) body.append('media_id', customMediaId.trim());
  const result = await api<{ code: number; message: string; request_id?: string; data: MediaUploadResult }>('/api/v2/media/upload', { method: 'POST', body });
  if (result.code !== 0 || !result.data?.media_id || !result.data?.media_url) throw new ApiError(result.message || 'Invalid media response', 200, result.request_id);
  return result.data;
}
