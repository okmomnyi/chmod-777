/**
 * CTFd read-only client.
 *
 * Provides:
 *   fetchChallenges(baseUrl, token)        → Challenge[]
 *   fetchChallengeDetail(baseUrl, token, id) → ChallengeDetail
 *   downloadFiles(baseUrl, token, id)       → writes to work/<id>/files/, returns local paths
 *
 * NO submit function exists — this is intentional and must never be added.
 */
import { mkdirSync, writeFileSync } from "fs";
import { join, basename } from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Challenge {
  id: number;
  name: string;
  category: string;
  value: number;
  solves: number;
  solved_by_me: boolean;
  tags: string[];
  type: string;
}

export interface ChallengeFile {
  /** Relative URL as returned by CTFd, e.g. "/files/abc123/challenge.zip?token=..." */
  url: string;
}

export interface ChallengeHint {
  id: number;
  cost: number;
  content?: string; // only present if already unlocked
}

export interface ChallengeDetail extends Challenge {
  description: string;
  connection_info: string | null;
  files: string[]; // raw URLs from CTFd
  hints: ChallengeHint[];
  max_attempts: number;
  /** Parsed from connection_info if it contains host:port */
  host?: string;
  port?: number;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

interface CTFdListResponse<T> {
  success: boolean;
  data: T[];
  meta?: {
    pagination?: {
      page: number;
      next: number | null;
      prev: number | null;
      pages: number;
      per_page: number;
      total: number;
    };
  };
}

interface CTFdSingleResponse<T> {
  success: boolean;
  data: T;
}

async function ctfdGet<T>(
  baseUrl: string,
  token: string,
  path: string
): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(
      `CTFd request failed: GET ${path} → ${res.status} ${res.statusText}`
    );
  }

  const body = (await res.json()) as { success: boolean };
  if (!body.success) {
    throw new Error(`CTFd API returned success=false for GET ${path}`);
  }

  return body as T;
}

/** Parse optional "host:port" from connection_info */
function parseConnectionInfo(raw: string | null): {
  host?: string;
  port?: number;
} {
  if (!raw) return {};
  const match = raw.match(/([a-zA-Z0-9.\-_]+):(\d+)/);
  if (match) {
    return { host: match[1], port: parseInt(match[2], 10) };
  }
  // Might be just a hostname / URL
  try {
    const u = new URL(raw.includes("://") ? raw : `nc://${raw}`);
    return {
      host: u.hostname || undefined,
      port: u.port ? parseInt(u.port, 10) : undefined,
    };
  } catch {
    return {};
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch all challenges (handles pagination automatically).
 */
export async function fetchChallenges(
  baseUrl: string,
  token: string
): Promise<Challenge[]> {
  const all: Challenge[] = [];
  let page = 1;

  while (true) {
    const resp = await ctfdGet<CTFdListResponse<Challenge>>(
      baseUrl,
      token,
      `/api/v1/challenges?page=${page}&per_page=100`
    );

    all.push(...resp.data);

    const pagination = resp.meta?.pagination;
    if (!pagination || pagination.next === null) break;
    page = pagination.next;
  }

  return all;
}

/**
 * Fetch full details for a single challenge.
 */
export async function fetchChallengeDetail(
  baseUrl: string,
  token: string,
  id: number
): Promise<ChallengeDetail> {
  const resp = await ctfdGet<CTFdSingleResponse<ChallengeDetail>>(
    baseUrl,
    token,
    `/api/v1/challenges/${id}`
  );

  const detail = resp.data;
  const { host, port } = parseConnectionInfo(detail.connection_info);

  return { ...detail, host, port };
}

/**
 * Download all files for a challenge into work/<id>/files/.
 * Returns the list of absolute local paths written.
 *
 * Files are mounted read-only into the solver container later.
 */
export async function downloadFiles(
  baseUrl: string,
  token: string,
  id: number,
  workDir = "work"
): Promise<string[]> {
  const detail = await fetchChallengeDetail(baseUrl, token, id);

  if (!detail.files || detail.files.length === 0) return [];

  const outDir = join(process.cwd(), workDir, String(id), "files");
  mkdirSync(outDir, { recursive: true });

  const localPaths: string[] = [];

  for (const fileUrl of detail.files) {
    // CTFd file URLs can be relative (/files/...) or absolute
    const fullUrl = fileUrl.startsWith("http")
      ? fileUrl
      : `${baseUrl.replace(/\/$/, "")}${fileUrl}`;

    const res = await fetch(fullUrl, {
      headers: { Authorization: `Token ${token}` },
    });

    if (!res.ok) {
      throw new Error(
        `Failed to download file ${fullUrl}: ${res.status} ${res.statusText}`
      );
    }

    // Extract filename from URL path (before query string)
    const urlPath = new URL(fullUrl).pathname;
    const filename = basename(urlPath) || `file_${Date.now()}`;
    const localPath = join(outDir, filename);

    const buffer = Buffer.from(await res.arrayBuffer());
    writeFileSync(localPath, buffer);
    localPaths.push(localPath);
  }

  return localPaths;
}
