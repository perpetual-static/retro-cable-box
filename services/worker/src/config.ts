import { resolve } from 'node:path';

/** Folder that `local` sources live under. Default: <repo>/media. */
export const MEDIA_ROOT = resolve(process.env.MEDIA_ROOT ?? resolve(import.meta.dirname, '../../../media'));
