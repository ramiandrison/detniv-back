import { createHash } from 'crypto';
import { env } from '../../config/env';

const B2_AUTH_URL = 'https://api.backblazeb2.com/b2api/v4/b2_authorize_account';
const B2_API_VERSION = 'v4';
const AUTH_CACHE_TTL_MS = 23 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60_000;

interface StorageAuth {
  token: string;
  apiUrl: string;
  downloadUrl: string;
  expiresAt: number;
}

interface B2ErrorPayload {
  status?: number;
  code?: string;
  message?: string;
}

interface B2AuthPayload extends B2ErrorPayload {
  authorizationToken?: string;
  apiUrl?: string;
  downloadUrl?: string;
  apiInfo?: {
    storageApi?: {
      apiUrl?: string;
      downloadUrl?: string;
    };
  };
}

interface B2UploadUrlPayload extends B2ErrorPayload {
  uploadUrl?: string;
  authorizationToken?: string;
}

interface B2UploadFilePayload extends B2ErrorPayload {
  fileId?: string;
  fileName?: string;
}

class B2RequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'B2RequestError';
  }
}

let cachedAuth: StorageAuth | null = null;

function requireConfig() {
  const { keyId, applicationKey, bucketId, bucketName } = env.b2;
  if (!keyId || !applicationKey || !bucketId || !bucketName) {
    throw new Error('Image storage is not configured');
  }
  return { keyId, applicationKey, bucketId, bucketName };
}

async function readJson<T extends B2ErrorPayload>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    return {} as T;
  }
}

function requestError(
  action: string,
  response: Response,
  payload: B2ErrorPayload
): B2RequestError {
  const detail = payload.message || payload.code || response.statusText || 'unknown error';
  return new B2RequestError(`${action}: ${detail}`, response.status);
}

async function authorize(force = false): Promise<StorageAuth> {
  if (!force && cachedAuth && cachedAuth.expiresAt > Date.now()) {
    return cachedAuth;
  }

  const { keyId, applicationKey } = requireConfig();
  const credentials = Buffer.from(`${keyId}:${applicationKey}`).toString('base64');

  const response = await fetch(B2_AUTH_URL, {
    method: 'GET',
    headers: { Authorization: `Basic ${credentials}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await readJson<B2AuthPayload>(response);

  if (!response.ok) {
    throw requestError('Backblaze authorization failed', response, payload);
  }

  const storageApi = payload.apiInfo?.storageApi;
  const token = payload.authorizationToken;
  const apiUrl = storageApi?.apiUrl || payload.apiUrl;
  const downloadUrl = storageApi?.downloadUrl || payload.downloadUrl;

  if (!token || !apiUrl || !downloadUrl) {
    throw new B2RequestError(
      'Backblaze authorization response is incomplete',
      502
    );
  }

  cachedAuth = {
    token,
    apiUrl: apiUrl.replace(/\/+$/, ''),
    downloadUrl: downloadUrl.replace(/\/+$/, ''),
    expiresAt: Date.now() + AUTH_CACHE_TTL_MS,
  };
  return cachedAuth;
}

async function getUploadUrl(
  auth: StorageAuth,
  bucketId: string
): Promise<{ uploadUrl: string; authorizationToken: string }> {
  const url = new URL(`${auth.apiUrl}/b2api/${B2_API_VERSION}/b2_get_upload_url`);
  url.searchParams.set('bucketId', bucketId);

  const response = await fetch(url, {
    method: 'GET',
    headers: { Authorization: auth.token },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await readJson<B2UploadUrlPayload>(response);

  if (!response.ok) {
    throw requestError('Backblaze upload URL request failed', response, payload);
  }
  if (!payload.uploadUrl || !payload.authorizationToken) {
    throw new B2RequestError(
      'Backblaze upload URL response is incomplete',
      502
    );
  }

  return {
    uploadUrl: payload.uploadUrl,
    authorizationToken: payload.authorizationToken,
  };
}

/** Encode chaque segment sans encoder les séparateurs de dossier. */
function encodeFileName(fileName: string): string {
  return fileName
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function buildPublicUrl(
  auth: StorageAuth,
  bucketName: string,
  fileName: string
): string {
  const base = env.b2.publicUrl
    ? env.b2.publicUrl
    : `${auth.downloadUrl}/file/${encodeURIComponent(bucketName)}`;
  return `${base.replace(/\/+$/, '')}/${encodeFileName(fileName)}`;
}

async function uploadOnce(
  auth: StorageAuth,
  bucketId: string,
  buffer: Buffer,
  fileName: string,
  contentType: string
): Promise<{ fileId: string; fileName: string }> {
  const target = await getUploadUrl(auth, bucketId);
  const sha1 = createHash('sha1').update(buffer).digest('hex');

  const response = await fetch(target.uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: target.authorizationToken,
      'X-Bz-File-Name': encodeFileName(fileName),
      'Content-Type': contentType,
      'Content-Length': String(buffer.length),
      'X-Bz-Content-Sha1': sha1,
      'X-Bz-Info-b2-cache-control': encodeURIComponent(
        'public, max-age=31536000, immutable'
      ),
    },
    body: buffer,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await readJson<B2UploadFilePayload>(response);

  if (!response.ok) {
    throw requestError('Backblaze upload failed', response, payload);
  }
  if (!payload.fileId) {
    throw new B2RequestError('Backblaze upload response is incomplete', 502);
  }

  return { fileId: payload.fileId, fileName: payload.fileName || fileName };
}

/**
 * Envoie un fichier sur Backblaze B2 et renvoie son identifiant ainsi que son
 * URL publique. En cas de jeton expiré, on réautorise et on réessaie une fois.
 */
export async function uploadImage(
  buffer: Buffer,
  fileName: string,
  contentType: string
): Promise<{ fileId: string; url: string }> {
  const { bucketId, bucketName } = requireConfig();

  let attempt = 0;
  while (attempt < 2) {
    try {
      const auth = await authorize(attempt > 0);
      const uploaded = await uploadOnce(
        auth,
        bucketId,
        buffer,
        fileName,
        contentType
      );
      return {
        fileId: uploaded.fileId,
        url: buildPublicUrl(auth, bucketName, fileName),
      };
    } catch (error) {
      const retryable =
        error instanceof B2RequestError &&
        (error.status === 401 || error.status === 503);
      if (!retryable || attempt === 1) throw error;
      cachedAuth = null;
      attempt += 1;
    }
  }

  throw new B2RequestError('Backblaze upload failed', 502);
}
