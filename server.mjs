import { createServer as createHttpServer } from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

let ffmpegStaticPath = null;
try {
  ({ default: ffmpegStaticPath } = await import("ffmpeg-static"));
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
}

const PROJECT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPLICATE_MODEL_URL = "https://api.replicate.com/v1/models/minimax/video-01/predictions";
const REPLICATE_PREDICTION_URL = "https://api.replicate.com/v1/predictions";
const MAX_BODY_BYTES = 8192;
const MAX_PROMPT_LENGTH = 500;
const MAX_RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_VIDEO_DURATION_SECONDS = 60;
const MODEL_CLIP_DURATION_SECONDS = 6;
const MAX_VIDEO_SEGMENTS = MAX_VIDEO_DURATION_SECONDS / MODEL_CLIP_DURATION_SECONDS;
const MAX_VIDEO_JOBS = 100;
const VIDEO_JOB_MAX_AGE_MS = 30 * 60 * 1000;
const MAX_SEGMENT_VIDEO_BYTES = 32 * 1024 * 1024;
const MEDIA_FETCH_TIMEOUT_MS = 120_000;
const FFMPEG_TIMEOUT_MS = 8 * 60 * 1000;
const VIDEO_OUTPUT_DIRECTORY = process.env.VIDEO_OUTPUT_DIRECTORY || join(tmpdir(), "ai-video-studio-videos");
const FFMPEG_PATH = process.env.FFMPEG_PATH || ffmpegStaticPath;
const MAX_AUTH_FAILURES_PER_CLIENT = 10;
const MAX_TRACKED_LOGIN_CLIENTS = 10_000;
const AUTH_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
const SESSION_COOKIE_NAME = "ai_video_session";
const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;
const REQUEST_TIMEOUT_MS = 20_000;
const OAUTH_PROVIDERS = {
  google: {
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userUrl: "https://openidconnect.googleapis.com/v1/userinfo",
  },
  github: {
    authorizationUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userUrl: "https://api.github.com/user",
  },
};
const ALLOWED_STYLES = new Set([
  "Cinematic",
  "Photorealistic",
  "Animation",
  "Anime",
  "Watercolor",
  "3D render",
]);

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(data));
}

function getClientAddress(request) {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    const addresses = forwarded.split(",");
    const address = addresses[addresses.length - 1].trim();
    if (address) return address;
  }
  return request.socket.remoteAddress || "unknown";
}

function isTrustedReplicateDeliveryUrl(url) {
  return url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    (url.hostname === "replicate.delivery" || url.hostname.endsWith(".replicate.delivery"));
}

function parseOutputUrl(output) {
  const candidate = Array.isArray(output) ? output[0] : output;
  if (typeof candidate !== "string") return null;

  try {
    const url = new URL(candidate);
    return isTrustedReplicateDeliveryUrl(url) ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizePrediction(prediction) {
  if (!prediction || typeof prediction !== "object") {
    throw new Error("The video provider returned an invalid response.");
  }

  const rawStatus = prediction.status;
  if (rawStatus === "starting" || rawStatus === "processing") {
    return { id: prediction.id, status: rawStatus };
  }
  if (rawStatus === "succeeded" || rawStatus === "successful") {
    const videoUrl = parseOutputUrl(prediction.output);
    if (!videoUrl) {
      return { id: prediction.id, status: "failed", error: "The provider finished without a valid video URL." };
    }
    return { id: prediction.id, status: "succeeded", videoUrl };
  }
  if (rawStatus === "failed" || rawStatus === "canceled" || rawStatus === "cancelled") {
    return {
      id: prediction.id,
      status: "failed",
      error: "The provider could not generate this video. Try another prompt.",
    };
  }
  throw new Error("The video provider returned an unsupported prediction status.");
}

function parseByteRange(header, fileSize) {
  if (typeof header !== "string") return null;
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return false;

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return false;
    start = Math.max(fileSize - suffixLength, 0);
    end = fileSize - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : fileSize - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
    start < 0 || start >= fileSize || end < start) {
    return false;
  }
  return { start, end: Math.min(end, fileSize - 1) };
}

async function downloadVideoSegment(fetchImpl, videoUrl, destination) {
  let url = new URL(videoUrl);
  if (!isTrustedReplicateDeliveryUrl(url)) {
    throw new Error("The video provider returned a clip from an untrusted host.");
  }

  const signal = AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS);
  let response;
  for (let redirects = 0; ; redirects += 1) {
    try {
      response = await fetchImpl(url, { redirect: "manual", signal });
    } catch {
      throw new Error("Could not download a generated clip from the video provider.");
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location || redirects >= 3) {
      await response.body?.cancel();
      throw new Error("The video provider returned an invalid clip redirect.");
    }
    const redirectedUrl = new URL(location, url);
    await response.body?.cancel();
    if (!isTrustedReplicateDeliveryUrl(redirectedUrl)) {
      throw new Error("The video provider redirected a clip to an untrusted host.");
    }
    url = redirectedUrl;
  }
  if (!response.ok || !response.body) {
    throw new Error("The video provider could not deliver one of the generated clips.");
  }
  const resolvedUrl = response.url ? new URL(response.url) : url;
  if (!isTrustedReplicateDeliveryUrl(resolvedUrl)) {
    throw new Error("The video provider redirected a clip to an untrusted host.");
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_SEGMENT_VIDEO_BYTES) {
    throw new Error("A generated clip is larger than the server can combine.");
  }

  let downloadedBytes = 0;
  const limitedBody = new TransformStream({
    transform(chunk, controller) {
      downloadedBytes += chunk.byteLength;
      if (downloadedBytes > MAX_SEGMENT_VIDEO_BYTES) {
        controller.error(new Error("A generated clip is larger than the server can combine."));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  try {
    await pipeline(response.body.pipeThrough(limitedBody), createWriteStream(destination, { flags: "wx" }));
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }
  if (downloadedBytes === 0) {
    await rm(destination, { force: true });
    throw new Error("The video provider returned an empty clip.");
  }
}

async function combineVideoSegments(job, videoOutputDirectory) {
  if (job.completedSegments !== MAX_VIDEO_SEGMENTS) {
    throw new Error("The video job did not contain all required clips.");
  }

  const workingDirectory = join(videoOutputDirectory, `${job.id}.work`);
  const temporaryOutput = join(workingDirectory, "combined.mp4");
  const finalOutput = join(videoOutputDirectory, `${job.id}.mp4`);
  await mkdir(workingDirectory, { recursive: true });

  try {
    const segmentPaths = Array.from(
      { length: MAX_VIDEO_SEGMENTS },
      (_, index) => join(workingDirectory, `clip-${index + 1}.mp4`),
    );

    const filterParts = segmentPaths.map((_, index) =>
      `[${index}:v:0]trim=duration=${MODEL_CLIP_DURATION_SECONDS},setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p[v${index}]`,
    );
    const joinedStreams = segmentPaths.map((_, index) => `[v${index}]`).join("");
    filterParts.push(`${joinedStreams}concat=n=${MAX_VIDEO_SEGMENTS}:v=1:a=0[outv]`);
    const ffmpegArguments = [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      ...segmentPaths.flatMap((path) => ["-i", path]),
      "-filter_complex", filterParts.join(";"),
      "-map", "[outv]",
      "-an",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-t", String(MAX_VIDEO_DURATION_SECONDS),
      "-movflags", "+faststart",
      "-f", "mp4",
      temporaryOutput,
    ];
    await runFfmpeg(ffmpegArguments);
    const outputStats = await stat(temporaryOutput);
    if (outputStats.size === 0) {
      throw new Error("FFmpeg did not produce a usable video.");
    }
    await mkdir(videoOutputDirectory, { recursive: true });
    await rename(temporaryOutput, finalOutput);
    return finalOutput;
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

function sendVideoJobStatus(response, job) {
  sendJson(response, 200, {
    id: job.id,
    status: job.status,
    duration: MAX_VIDEO_DURATION_SECONDS,
    totalSegments: MAX_VIDEO_SEGMENTS,
    completedSegments: job.completedSegments,
    ...(job.status === "succeeded" ? { videoUrl: `/api/videos/${job.id}/file` } : {}),
    ...(job.status === "failed" ? { error: job.error } : {}),
  });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!FFMPEG_PATH) {
      reject(new Error("FFmpeg is unavailable. Install ffmpeg-static or set FFMPEG_PATH."));
      return;
    }

    const child = spawn(FFMPEG_PATH, args, { windowsHide: true });
    let stderr = "";
    const timeout = setTimeout(() => child.kill(), FFMPEG_TIMEOUT_MS);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8000);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`Could not start FFmpeg: ${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg could not create the merged video (exit ${code}): ${stderr.trim()}`));
      }
    });
  });
}

async function readJsonBody(request) {
  const chunks = [];
  let length = 0;

  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) {
      return { error: { status: 413, message: "Request body is too large." } };
    }
    chunks.push(chunk);
  }

  try {
    return { data: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { error: { status: 400, message: "Request body must be valid JSON." } };
  }
}

function constantTimeStringEqual(actual, expected) {
  const actualHash = createHash("sha256").update(actual).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

function getCookie(request, cookieName) {
  const header = request.headers.cookie;
  if (typeof header !== "string") return null;
  for (const cookie of header.split(";")) {
    const separator = cookie.indexOf("=");
    if (separator < 0 || cookie.slice(0, separator).trim() !== cookieName) continue;
    return cookie.slice(separator + 1).trim();
  }
  return null;
}

function getSessionSecret(env) {
  return typeof env.APP_SESSION_SECRET === "string" && Buffer.byteLength(env.APP_SESSION_SECRET) >= 32
    ? env.APP_SESSION_SECRET
    : null;
}

function isPasswordLoginConfigured(env) {
  return Boolean(
    typeof env.APP_USERNAME === "string" &&
    env.APP_USERNAME.length >= 3 &&
    env.APP_USERNAME.length <= 100 &&
    typeof env.APP_PASSWORD === "string" &&
    env.APP_PASSWORD.length >= 16 &&
    env.APP_PASSWORD.length <= 256 &&
    getSessionSecret(env),
  );
}

function isVideoGenerationConfigured(env) {
  return Boolean(env.REPLICATE_API_TOKEN && getSessionSecret(env));
}

function getAppBaseUrl(env) {
  if (typeof env.APP_BASE_URL !== "string") return null;
  try {
    const url = new URL(env.APP_BASE_URL);
    const localHttp = url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if ((!localHttp && url.protocol !== "https:") ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function getOAuthConfig(provider, env) {
  const baseUrl = getAppBaseUrl(env);
  if (!baseUrl || !OAUTH_PROVIDERS[provider]) return null;
  const prefix = provider === "google" ? "GOOGLE" : "GITHUB";
  const clientId = env[`${prefix}_CLIENT_ID`];
  const clientSecret = env[`${prefix}_CLIENT_SECRET`];
  if (typeof clientId !== "string" || clientId.length === 0 ||
    typeof clientSecret !== "string" || clientSecret.length === 0) {
    return null;
  }
  return {
    ...OAUTH_PROVIDERS[provider],
    clientId,
    clientSecret,
    redirectUri: `${baseUrl}/api/auth/callback/${provider}`,
  };
}

function getAvailableAuthProviders(env) {
  return {
    password: isPasswordLoginConfigured(env),
    google: Boolean(getOAuthConfig("google", env)),
    github: Boolean(getOAuthConfig("github", env)),
  };
}

function getSessionVersion(secret, env) {
  return createHmac("sha256", secret)
    .update(`${env.APP_USERNAME}\0${env.APP_PASSWORD}`)
    .digest("base64url");
}

function createSessionToken(secret, expiresAt, sessionVersion, user) {
  const payload = Buffer.from(JSON.stringify({
    expiresAt,
    id: randomBytes(16).toString("base64url"),
    sessionVersion,
    user,
  }))
    .toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifySessionToken(token, secret, timestamp, sessionVersion) {
  if (typeof token !== "string" || token.length > 2048) return null;
  const separator = token.lastIndexOf(".");
  if (separator < 1) return null;
  const payload = token.slice(0, separator);
  const providedSignature = token.slice(separator + 1);
  const expectedSignature = createHmac("sha256", secret).update(payload).digest("base64url");
  if (!constantTimeStringEqual(providedSignature, expectedSignature)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const valid = Number.isSafeInteger(data.expiresAt) &&
      data.expiresAt > timestamp &&
      data.expiresAt <= timestamp + SESSION_MAX_AGE_SECONDS * 1000 &&
      typeof data.id === "string" &&
      typeof data.sessionVersion === "string" &&
      constantTimeStringEqual(data.sessionVersion, sessionVersion);
    return valid ? data : null;
  } catch {
    return null;
  }
}

function setSessionCookie(response, token, request, maxAge = SESSION_MAX_AGE_SECONDS) {
  const forwardedProtocol = request.headers["x-forwarded-proto"];
  const isHttps = typeof forwardedProtocol === "string"
    ? forwardedProtocol.split(",")[0].trim() === "https"
    : Boolean(request.socket.encrypted);
  const secure = isHttps ? "; Secure" : "";
  appendSetCookie(
    response,
    `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`,
  );
}

function appendSetCookie(response, cookie) {
  const existing = response.getHeader("Set-Cookie");
  response.setHeader("Set-Cookie", existing
    ? [...(Array.isArray(existing) ? existing : [existing]), cookie]
    : cookie);
}

function setOAuthStateCookie(response, state, provider, request, maxAge = OAUTH_STATE_MAX_AGE_SECONDS) {
  const forwardedProtocol = request.headers["x-forwarded-proto"];
  const isHttps = typeof forwardedProtocol === "string"
    ? forwardedProtocol.split(",")[0].trim() === "https"
    : Boolean(request.socket.encrypted);
  const secure = isHttps ? "; Secure" : "";
  appendSetCookie(
    response,
    `ai_video_oauth_state_${provider}=${state}; Path=/api/auth/callback; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`,
  );
}

function redirectOAuthFailure(response, request, provider, reason) {
  setOAuthStateCookie(response, "", provider, request, 0);
  response.writeHead(302, {
    Location: `/?authError=${encodeURIComponent(reason)}`,
    "Cache-Control": "no-store",
  });
  response.end();
}

async function fetchOAuthJson(fetchImpl, url, options) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error("The identity provider could not be reached.");
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("The identity provider returned an invalid response.");
  }
  if (!response.ok) {
    throw new Error("The identity provider rejected the sign-in request.");
  }
  return data;
}

async function getOAuthUser(fetchImpl, provider, config, code) {
  const token = await fetchOAuthJson(fetchImpl, config.tokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (typeof token.access_token !== "string" || !token.access_token) {
    throw new Error("The identity provider did not issue an access token.");
  }
  const profile = await fetchOAuthJson(fetchImpl, config.userUrl, {
    headers: {
      Accept: provider === "github" ? "application/vnd.github+json" : "application/json",
      Authorization: `Bearer ${token.access_token}`,
      ...(provider === "github" ? { "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "AI-Video-Studio" } : {}),
    },
  });
  const providerId = profile.sub ?? profile.id;
  if ((typeof providerId !== "string" && typeof providerId !== "number") ||
    typeof providerId === "number" && !Number.isSafeInteger(providerId) ||
    typeof providerId === "string" && (providerId.length === 0 || providerId.length > 256)) {
    throw new Error("The identity provider returned an invalid account.");
  }
  if (provider === "google" && profile.email_verified !== true) {
    throw new Error("Use a Google account with a verified email address.");
  }
  const name = typeof profile.name === "string" && profile.name.trim()
    ? profile.name.trim()
    : typeof profile.login === "string" && profile.login.trim()
      ? profile.login.trim()
      : typeof profile.email === "string" && profile.email.trim()
        ? profile.email.trim()
        : `${provider} user`;
  return {
    id: `${provider}:${providerId}`,
    provider,
    name: name.slice(0, 100),
    email: typeof profile.email === "string" ? profile.email.slice(0, 254) : null,
  };
}

function hasSameOrigin(request) {
  const origin = request.headers.origin;
  if (typeof origin !== "string") return true;
  try {
    const originUrl = new URL(origin);
    const forwardedProtocol = request.headers["x-forwarded-proto"];
    const expectedProtocol = typeof forwardedProtocol === "string"
      ? forwardedProtocol.split(",")[0].trim()
      : request.socket.encrypted ? "https" : "http";
    return originUrl.host === request.headers.host && originUrl.protocol === `${expectedProtocol}:`;
  } catch {
    return false;
  }
}

export function createServer({
  env = process.env,
  fetchImpl = fetch,
  now = Date.now,
  videoOutputDirectory = env.VIDEO_OUTPUT_DIRECTORY || VIDEO_OUTPUT_DIRECTORY,
} = {}) {
  const clientRequests = new Map();
  const failedLoginAttempts = new Map();
  const serverRequests = [];
  const videoJobs = new Map();
  const maximumPerClient = Number.parseInt(env.MAX_GENERATIONS_PER_HOUR || "5", 10);
  const validMaximumPerClient = Number.isInteger(maximumPerClient) && maximumPerClient > 0
    ? maximumPerClient
    : 5;

  function startVideoAssembly(job) {
    if (job.status === "combining" || job.status === "succeeded") return;
    job.status = "combining";
    job.assemblyPromise = combineVideoSegments(job, videoOutputDirectory)
      .then((outputPath) => {
        job.outputPath = outputPath;
        job.status = "succeeded";
      })
      .catch(async (error) => {
        console.error("Video assembly failed:", error instanceof Error ? error.message : "Unknown FFmpeg error");
        job.status = "failed";
        job.error = "The server could not combine all clips into a video. Please try again.";
      });
  }

  async function storeVideoSegment(job, videoUrl) {
    const workingDirectory = join(videoOutputDirectory, `${job.id}.work`);
    const segmentPath = join(workingDirectory, `clip-${job.completedSegments + 1}.mp4`);
    try {
      await mkdir(workingDirectory, { recursive: true });
      await downloadVideoSegment(fetchImpl, videoUrl, segmentPath);
      job.completedSegments += 1;
      return true;
    } catch (error) {
      console.error("Could not save a generated video clip:", error instanceof Error ? error.message : "Unknown media download error");
      job.status = "failed";
      job.error = "Could not download a generated clip to finish this video. Please try again.";
      await rm(workingDirectory, { recursive: true, force: true });
      return false;
    }
  }

  async function removeVideoJob(job) {
    videoJobs.delete(job.id);
    const paths = [
      join(videoOutputDirectory, `${job.id}.work`),
      join(videoOutputDirectory, `${job.id}.mp4`),
    ];
    for (const path of paths) {
      try {
        await rm(path, { recursive: true, force: true });
      } catch (error) {
        console.error("Could not remove an expired video file:", error instanceof Error ? error.message : "Unknown filesystem error");
      }
    }
  }

  async function callReplicate(url, token, options = {}) {
    let upstream;
    try {
      upstream = await fetchImpl(url, {
        ...options,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...options.headers,
        },
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new ApiError(504, "The video provider did not respond in time. Try again.");
      }
      throw new ApiError(502, "Could not reach the video provider. Try again later.");
    }

    let result;
    try {
      result = await upstream.json();
    } catch {
      throw new ApiError(502, "The video provider returned an invalid response.");
    }

    if (!upstream.ok) {
      if (upstream.status === 401 || upstream.status === 403) {
        throw new ApiError(502, "The server's Replicate token is invalid or does not have permission to run this model.");
      }
      if (upstream.status === 402) {
        throw new ApiError(402, "Replicate needs billing or more account credit before it can generate this video.");
      }
      if (upstream.status === 422) {
        throw new ApiError(422, "The video provider rejected this prompt or its input settings. Try a different prompt.");
      }
      if (upstream.status === 429) {
        throw new ApiError(429, "The video provider is busy. Wait a moment before trying again.");
      }
      throw new ApiError(502, "The video provider could not accept this request. Try again later.");
    }
    return result;
  }

  async function startVideoSegment(prompt, style, segmentNumber, token) {
    const continuation = segmentNumber === 1
      ? ""
      : ` This is clip ${segmentNumber} of ${MAX_VIDEO_SEGMENTS} for one longer video. Keep the same subject, setting, and visual style; show a plausible continuation rather than restarting the scene.`;
    const prediction = normalizePrediction(await callReplicate(REPLICATE_MODEL_URL, token, {
      method: "POST",
      body: JSON.stringify({
        input: {
          prompt: `Visual style: ${style}. ${prompt}${continuation}`,
          prompt_optimizer: true,
        },
      }),
      headers: { Prefer: "wait=5" },
    }));
    if (prediction.status === "failed") {
      throw new ApiError(422, prediction.error);
    }
    if (prediction.status !== "succeeded" &&
      (typeof prediction.id !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(prediction.id))) {
      throw new Error("The video provider did not return a valid generation ID.");
    }
    return prediction;
  }

  async function handleApi(request, response, url) {
    const token = env.REPLICATE_API_TOKEN;
    const sessionSecret = getSessionSecret(env);
    if (request.method === "GET" && url.pathname === "/api/auth/session") {
      const sessionToken = getCookie(request, SESSION_COOKIE_NAME);
      const session = sessionSecret && sessionToken
        ? verifySessionToken(sessionToken, sessionSecret, now(), getSessionVersion(sessionSecret, env))
        : null;
      sendJson(response, 200, {
        authenticated: Boolean(session),
        ready: isVideoGenerationConfigured(env),
        providers: getAvailableAuthProviders(env),
        user: session?.user || null,
      });
      return;
    }

    const clientAddress = getClientAddress(request);
    const timestamp = now();

    const videoFileMatch = url.pathname.match(/^\/api\/videos\/([a-zA-Z0-9_-]{8,128})\/file$/);
    if ((request.method === "GET" || request.method === "HEAD") && videoFileMatch) {
      if (!sessionSecret) {
        sendJson(response, 503, { error: "Video playback is not configured." });
        return;
      }
      const sessionToken = getCookie(request, SESSION_COOKIE_NAME);
      const session = sessionToken
        ? verifySessionToken(sessionToken, sessionSecret, timestamp, getSessionVersion(sessionSecret, env))
        : null;
      if (!session) {
        sendJson(response, 401, { error: "Please log in again to continue." });
        return;
      }
      const job = videoJobs.get(videoFileMatch[1]);
      if (!job) {
        sendJson(response, 404, { error: "Video file not found." });
        return;
      }
      if (session.user?.id !== job.userId) {
        sendJson(response, 403, { error: "This video belongs to a different account." });
        return;
      }
      if (job.expiresAt <= timestamp) {
        await removeVideoJob(job);
        sendJson(response, 410, { error: "This video expired. Please generate it again." });
        return;
      }
      if (job.status !== "succeeded" || !job.outputPath) {
        sendJson(response, 409, { error: "The merged video is not ready yet." });
        return;
      }

      const file = await stat(job.outputPath);
      const rangeHeader = request.headers.range;
      const range = parseByteRange(rangeHeader, file.size);
      if (range === false) {
        response.writeHead(416, {
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, no-store",
          "Content-Range": `bytes */${file.size}`,
        });
        response.end();
        return;
      }
      const start = range ? range.start : 0;
      const end = range ? range.end : file.size - 1;
      response.writeHead(range ? 206 : 200, {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
        "Content-Disposition": `inline; filename="ai-video-${job.id}.mp4"`,
        "Content-Length": end - start + 1,
        "Content-Type": "video/mp4",
        "X-Content-Type-Options": "nosniff",
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${file.size}` } : {}),
      });
      if (request.method === "HEAD") {
        response.end();
      } else {
        await pipeline(createReadStream(job.outputPath, { start, end }), response);
      }
      return;
    }

    const oauthStart = url.pathname.match(/^\/api\/auth\/(google|github)$/);
    if (request.method === "GET" && oauthStart) {
      const provider = oauthStart[1];
      const config = getOAuthConfig(provider, env);
      if (!config || !sessionSecret) {
        sendJson(response, 503, { error: `${provider} sign-in is not configured. Ask the app owner to finish setup.` });
        return;
      }
      const state = randomBytes(32).toString("base64url");
      const authorizationUrl = new URL(config.authorizationUrl);
      authorizationUrl.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: "code",
        scope: provider === "google" ? "openid email profile" : "read:user user:email",
        state,
        ...(provider === "github" ? { allow_signup: "true" } : {}),
      }).toString();
      setOAuthStateCookie(response, state, provider, request);
      response.writeHead(302, {
        Location: authorizationUrl.toString(),
        "Cache-Control": "no-store",
      });
      response.end();
      return;
    }

    const oauthCallback = url.pathname.match(/^\/api\/auth\/callback\/(google|github)$/);
    if (request.method === "GET" && oauthCallback) {
      const provider = oauthCallback[1];
      const config = getOAuthConfig(provider, env);
      if (!config || !sessionSecret) {
        redirectOAuthFailure(response, request, provider, "setup");
        return;
      }
      const providedState = url.searchParams.get("state");
      const savedState = getCookie(request, `ai_video_oauth_state_${provider}`);
      const code = url.searchParams.get("code");
      if (!providedState || !savedState || providedState.length > 128 ||
        !constantTimeStringEqual(providedState, savedState)) {
        redirectOAuthFailure(response, request, provider, "state");
        return;
      }
      if (url.searchParams.has("error")) {
        redirectOAuthFailure(response, request, provider, "denied");
        return;
      }
      if (!code || code.length > 4096) {
        redirectOAuthFailure(response, request, provider, "provider");
        return;
      }
      try {
        const user = await getOAuthUser(fetchImpl, provider, config, code);
        const expiresAt = timestamp + SESSION_MAX_AGE_SECONDS * 1000;
        const session = createSessionToken(
          sessionSecret,
          expiresAt,
          getSessionVersion(sessionSecret, env),
          user,
        );
        setOAuthStateCookie(response, "", provider, request, 0);
        setSessionCookie(response, session, request);
        response.writeHead(302, { Location: "/", "Cache-Control": "no-store" });
        response.end();
      } catch (error) {
        console.error("OAuth sign-in failed:", error instanceof Error ? error.message : "Unknown identity provider error");
        redirectOAuthFailure(response, request, provider, "provider");
      }
      return;
    }

    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      if (!hasSameOrigin(request)) {
        sendJson(response, 403, { error: "Login request origin is not allowed." });
        return;
      }
      if (!isPasswordLoginConfigured(env) || !sessionSecret) {
        sendJson(response, 503, { error: "Login is not configured. Ask the app owner to finish server setup." });
        return;
      }
      const failures = (failedLoginAttempts.get(clientAddress) || [])
        .filter((failedAt) => timestamp - failedAt < AUTH_FAILURE_WINDOW_MS);
      for (const [address, attempts] of failedLoginAttempts) {
        if (!attempts.some((failedAt) => timestamp - failedAt < AUTH_FAILURE_WINDOW_MS)) {
          failedLoginAttempts.delete(address);
        }
      }
      if (!failedLoginAttempts.has(clientAddress) && failedLoginAttempts.size >= MAX_TRACKED_LOGIN_CLIENTS) {
        sendJson(response, 429, { error: "Login is temporarily busy. Please try again in a moment." });
        return;
      }
      if (failures.length >= MAX_AUTH_FAILURES_PER_CLIENT) {
        failedLoginAttempts.set(clientAddress, failures);
        sendJson(response, 429, { error: "Too many failed logins. Please wait 15 minutes and try again." });
        return;
      }

      const body = await readJsonBody(request);
      if (body.error) {
        sendJson(response, body.error.status, { error: body.error.message });
        return;
      }
      const username = body.data?.username;
      const password = body.data?.password;
      const credentialsValid =
        typeof username === "string" &&
        typeof password === "string" &&
        username.length <= 100 &&
        password.length <= 256 &&
        constantTimeStringEqual(username, env.APP_USERNAME) &&
        constantTimeStringEqual(password, env.APP_PASSWORD);
      if (!credentialsValid) {
        failures.push(timestamp);
        failedLoginAttempts.set(clientAddress, failures);
        sendJson(response, 401, { error: "Username or password is incorrect." });
        return;
      }

      failedLoginAttempts.delete(clientAddress);
      const expiresAt = timestamp + SESSION_MAX_AGE_SECONDS * 1000;
      const session = createSessionToken(
        sessionSecret,
        expiresAt,
        getSessionVersion(sessionSecret, env),
        { id: `password:${username}`, provider: "password", name: username, email: null },
      );
      setSessionCookie(response, session, request);
      sendJson(response, 200, { authenticated: true, expiresAt });
      return;
    }

    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      if (!hasSameOrigin(request)) {
        sendJson(response, 403, { error: "Logout request origin is not allowed." });
        return;
      }
      setSessionCookie(response, "", request, 0);
      sendJson(response, 200, { authenticated: false });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/videos") {
      if (!hasSameOrigin(request)) {
        sendJson(response, 403, { error: "Video request origin is not allowed." });
        return;
      }
      if (!isVideoGenerationConfigured(env) || !token || !sessionSecret) {
        sendJson(response, 503, {
          error: "Video generation is not configured. Ask the app owner to finish private server setup.",
        });
        return;
      }
      const sessionToken = getCookie(request, SESSION_COOKIE_NAME);
      const session = sessionToken
        ? verifySessionToken(sessionToken, sessionSecret, timestamp, getSessionVersion(sessionSecret, env))
        : null;
      if (!session) {
        sendJson(response, 401, { error: "Please log in again to continue." });
        return;
      }

      const existingRequests = (clientRequests.get(clientAddress) || [])
        .filter((createdAt) => timestamp - createdAt < MAX_RATE_WINDOW_MS);

      const body = await readJsonBody(request);
      if (body.error) {
        sendJson(response, body.error.status, { error: body.error.message });
        return;
      }

      const { prompt, style } = body.data || {};
      const duration = body.data?.duration === undefined ? MODEL_CLIP_DURATION_SECONDS : body.data.duration;
      if (typeof prompt !== "string" || prompt.trim().length === 0 || prompt.length > MAX_PROMPT_LENGTH) {
        sendJson(response, 400, { error: "Enter a prompt between 1 and 500 characters." });
        return;
      }
      if (typeof style !== "string" || !ALLOWED_STYLES.has(style)) {
        sendJson(response, 400, { error: "Choose a supported visual style." });
        return;
      }
      if (duration !== MODEL_CLIP_DURATION_SECONDS && duration !== MAX_VIDEO_DURATION_SECONDS) {
        sendJson(response, 400, { error: "Choose a 6-second clip or the 60-second MP4 option. Longer durations are not available yet." });
        return;
      }
      if (duration === MAX_VIDEO_DURATION_SECONDS) {
        try {
          if (!FFMPEG_PATH) throw new Error("FFmpeg is unavailable.");
          await access(FFMPEG_PATH);
        } catch {
          sendJson(response, 503, { error: "The server's video encoder is unavailable; no clips were generated." });
          return;
        }
      }

      for (const job of videoJobs.values()) {
        if (job.expiresAt <= timestamp) await removeVideoJob(job);
      }
      const hasActiveClientJob = [...videoJobs.values()]
        .some((job) => job.clientAddress === clientAddress &&
          job.status !== "succeeded" && job.status !== "failed");
      if (duration === MAX_VIDEO_DURATION_SECONDS &&
        (hasActiveClientJob ||
          [...videoJobs.values()].filter((job) => job.status !== "succeeded" && job.status !== "failed").length >= MAX_VIDEO_JOBS)) {
        sendJson(response, 429, { error: "A long video is already running or the video queue is full. Please try again later." });
        return;
      }

      const segmentCount = duration / MODEL_CLIP_DURATION_SECONDS;
      const recentServerRequests = serverRequests
        .filter((createdAt) => timestamp - createdAt < MAX_RATE_WINDOW_MS);
      if (existingRequests.length >= validMaximumPerClient || recentServerRequests.length + segmentCount > 30) {
        clientRequests.set(clientAddress, existingRequests);
        sendJson(response, 429, { error: "Video generation limit reached. Please wait before generating another clip." });
        return;
      }
      existingRequests.push(timestamp);
      clientRequests.set(clientAddress, existingRequests);
      for (let index = 0; index < segmentCount; index += 1) serverRequests.push(timestamp);
      for (let index = 0; index < serverRequests.length; index += 1) {
        if (timestamp - serverRequests[index] >= MAX_RATE_WINDOW_MS) {
          serverRequests.splice(index, 1);
          index -= 1;
        }
      }
      for (const [address, requests] of clientRequests) {
        if (!requests.some((createdAt) => timestamp - createdAt < MAX_RATE_WINDOW_MS)) {
          clientRequests.delete(address);
        }
      }
      const jobId = duration === MAX_VIDEO_DURATION_SECONDS
        ? randomBytes(18).toString("base64url")
        : null;
      const job = jobId ? {
        id: jobId,
        clientAddress,
        userId: session.user?.id,
        prompt: prompt.trim(),
        style,
        expiresAt: timestamp + VIDEO_JOB_MAX_AGE_MS,
        completedSegments: 0,
        predictionId: null,
        status: "processing",
        polling: false,
      } : null;
      if (job && jobId) videoJobs.set(jobId, job);

      let prediction;
      try {
        prediction = await startVideoSegment(prompt.trim(), style, 1, token);
      } catch (error) {
        if (job) await removeVideoJob(job);
        throw error;
      }
      if (duration === MODEL_CLIP_DURATION_SECONDS) {
        sendJson(response, prediction.status === "succeeded" ? 201 : 202, prediction);
        return;
      }
      if (prediction.status === "succeeded") {
        if (!await storeVideoSegment(job, prediction.videoUrl)) {
          sendVideoJobStatus(response, job);
          return;
        }
        if (job.completedSegments >= MAX_VIDEO_SEGMENTS) startVideoAssembly(job);
      } else {
        job.predictionId = prediction.id;
      }
      sendJson(response, 202, {
        id: jobId,
        status: job.status,
        duration,
        totalSegments: MAX_VIDEO_SEGMENTS,
        completedSegments: job.completedSegments,
      });
      return;
    }

    const match = url.pathname.match(/^\/api\/videos\/([a-zA-Z0-9_-]{8,128})$/);
    if (request.method === "GET" && match) {
      if (!isVideoGenerationConfigured(env) || !token || !sessionSecret) {
        sendJson(response, 503, { error: "Video generation is not configured. Ask the app owner to finish private server setup." });
        return;
      }
      const sessionToken = getCookie(request, SESSION_COOKIE_NAME);
      const session = sessionToken
        ? verifySessionToken(sessionToken, sessionSecret, timestamp, getSessionVersion(sessionSecret, env))
        : null;
      if (!session) {
        sendJson(response, 401, { error: "Please log in again to continue." });
        return;
      }
      const job = videoJobs.get(match[1]);
      if (job) {
        if (!session || session.user?.id !== job.userId) {
          sendJson(response, 403, { error: "This video job belongs to a different account." });
          return;
        }
        if (job.expiresAt <= timestamp) {
          await removeVideoJob(job);
          sendJson(response, 410, { error: "This video job expired. Please start a new video." });
          return;
        }
        if (job.status === "succeeded" || job.status === "failed" || job.status === "combining") {
          sendVideoJobStatus(response, job);
          return;
        }
        if (job.polling) {
          sendVideoJobStatus(response, job);
          return;
        }
        job.polling = true;
        try {
          if (job.predictionId) {
            const current = normalizePrediction(await callReplicate(
              `${REPLICATE_PREDICTION_URL}/${encodeURIComponent(job.predictionId)}`,
              token,
            ));
            if (current.status === "starting" || current.status === "processing") {
              sendVideoJobStatus(response, job);
              return;
            }
            if (current.status === "failed") {
              job.status = "failed";
              job.error = current.error;
              await rm(join(videoOutputDirectory, `${job.id}.work`), { recursive: true, force: true });
              sendVideoJobStatus(response, job);
              return;
            }
            if (!await storeVideoSegment(job, current.videoUrl)) {
              sendVideoJobStatus(response, job);
              return;
            }
            job.predictionId = null;
          }
          if (job.completedSegments >= MAX_VIDEO_SEGMENTS) {
            startVideoAssembly(job);
            sendVideoJobStatus(response, job);
            return;
          }
          let next;
          try {
            next = await startVideoSegment(job.prompt, job.style, job.completedSegments + 1, token);
          } catch (error) {
            job.status = "failed";
            job.error = error instanceof ApiError
              ? error.message
              : "The video provider failed while creating a clip. Please try again.";
            await rm(join(videoOutputDirectory, `${job.id}.work`), { recursive: true, force: true });
            sendVideoJobStatus(response, job);
            return;
          }
          if (next.status === "failed") {
            job.status = "failed";
            job.error = next.error;
            sendVideoJobStatus(response, job);
            return;
          }
          if (next.status === "succeeded") {
            if (!await storeVideoSegment(job, next.videoUrl)) {
              sendVideoJobStatus(response, job);
              return;
            }
          } else {
            job.predictionId = next.id;
          }
          if (job.completedSegments >= MAX_VIDEO_SEGMENTS) {
            startVideoAssembly(job);
            sendVideoJobStatus(response, job);
            return;
          }
          sendVideoJobStatus(response, job);
          return;
        } finally {
          job.polling = false;
        }
      }
      const prediction = await callReplicate(
        `${REPLICATE_PREDICTION_URL}/${encodeURIComponent(match[1])}`,
        token,
      );
      sendJson(response, 200, normalizePrediction(prediction));
      return;
    }

    sendJson(response, 404, { error: "API route not found." });
  }

  const server = createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://localhost");
      if (url.pathname.startsWith("/api/")) {
        await handleApi(request, response, url);
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { error: "Method not allowed." });
        return;
      }
      if (url.pathname !== "/" && url.pathname !== "/index.html") {
        sendJson(response, 404, { error: "Page not found." });
        return;
      }

      const nonce = randomBytes(18).toString("base64");
      const html = (await readFile(join(PROJECT_DIRECTORY, "index.html"), "utf8"))
        .replace("<script>", `<script nonce="${nonce}">`);
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        "Content-Security-Policy": `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; media-src 'self' https:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`,
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      });
      response.end(request.method === "HEAD" ? undefined : html);
    } catch (error) {
      if (error instanceof ApiError) {
        sendJson(response, error.status, { error: error.message });
        return;
      }
      console.error("Request failed:", error instanceof Error ? error.message : "Unknown server error");
      if (!response.headersSent) {
        sendJson(response, 500, { error: "The server could not complete this request." });
      } else {
        response.destroy();
      }
    }
  });
  const cleanupTimer = setInterval(() => {
    const timestamp = now();
    for (const job of videoJobs.values()) {
      if (job.expiresAt <= timestamp) void removeVideoJob(job);
    }
  }, 60_000);
  cleanupTimer.unref();
  server.once("close", () => clearInterval(cleanupTimer));
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = createServer();
  const port = Number.parseInt(process.env.PORT || "3000", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be a valid TCP port.");
  }
  server.listen(port, "0.0.0.0", () => {
    console.log(`AI Video Studio listening on port ${port}`);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      server.close((error) => {
        if (error) {
          console.error("Could not close server cleanly:", error.message);
          process.exitCode = 1;
        }
      });
    });
  }
}
