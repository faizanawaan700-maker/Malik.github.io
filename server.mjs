import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

function parseOutputUrl(output) {
  const candidate = Array.isArray(output) ? output[0] : output;
  if (typeof candidate !== "string") return null;

  try {
    const url = new URL(candidate);
    return url.protocol === "https:" ? url.toString() : null;
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
} = {}) {
  const clientRequests = new Map();
  const failedLoginAttempts = new Map();
  const serverRequests = [];
  const videoJobs = new Map();
  const maximumPerClient = Number.parseInt(env.MAX_GENERATIONS_PER_HOUR || "5", 10);
  const validMaximumPerClient = Number.isInteger(maximumPerClient) && maximumPerClient > 0
    ? maximumPerClient
    : 5;

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
        sendJson(response, 400, { error: "Choose a 6-second clip or the 60-second free plan. Longer premium plans are not available yet." });
        return;
      }

      for (const [jobId, job] of videoJobs) {
        if (job.expiresAt <= timestamp) videoJobs.delete(jobId);
      }
      const hasActiveClientJob = [...videoJobs.values()]
        .some((job) => job.clientAddress === clientAddress);
      if (duration === MAX_VIDEO_DURATION_SECONDS &&
        (hasActiveClientJob || videoJobs.size >= MAX_VIDEO_JOBS)) {
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
        videoUrls: [],
        predictionId: null,
      } : null;
      if (job && jobId) videoJobs.set(jobId, job);

      let prediction;
      try {
        prediction = await startVideoSegment(prompt.trim(), style, 1, token);
      } catch (error) {
        if (jobId) videoJobs.delete(jobId);
        throw error;
      }
      if (duration === MODEL_CLIP_DURATION_SECONDS) {
        sendJson(response, prediction.status === "succeeded" ? 201 : 202, prediction);
        return;
      }
      if (prediction.status === "succeeded") {
        job.videoUrls.push(prediction.videoUrl);
        job.completedSegments += 1;
      } else {
        job.predictionId = prediction.id;
      }
      sendJson(response, 202, {
        id: jobId,
        status: "processing",
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
          videoJobs.delete(job.id);
          sendJson(response, 410, { error: "This video job expired. Please start a new video." });
          return;
        }
        if (job.predictionId) {
          const current = normalizePrediction(await callReplicate(
            `${REPLICATE_PREDICTION_URL}/${encodeURIComponent(job.predictionId)}`,
            token,
          ));
          if (current.status === "starting" || current.status === "processing") {
            sendJson(response, 200, {
              id: job.id,
              status: current.status,
              duration: MAX_VIDEO_DURATION_SECONDS,
              totalSegments: MAX_VIDEO_SEGMENTS,
              completedSegments: job.completedSegments,
            });
            return;
          }
          if (current.status === "failed") {
            videoJobs.delete(job.id);
            sendJson(response, 200, { ...current, id: job.id });
            return;
          }
          job.videoUrls.push(current.videoUrl);
          job.completedSegments += 1;
          job.predictionId = null;
        }
        if (job.completedSegments >= MAX_VIDEO_SEGMENTS) {
          videoJobs.delete(job.id);
          sendJson(response, 200, {
            id: job.id,
            status: "succeeded",
            duration: MAX_VIDEO_DURATION_SECONDS,
            totalSegments: MAX_VIDEO_SEGMENTS,
            completedSegments: job.completedSegments,
            videoUrls: job.videoUrls,
          });
          return;
        }
        const next = await startVideoSegment(job.prompt, job.style, job.completedSegments + 1, token);
        if (next.status === "failed") {
          videoJobs.delete(job.id);
          sendJson(response, 200, { ...next, id: job.id });
          return;
        }
        if (next.status === "succeeded") {
          job.videoUrls.push(next.videoUrl);
          job.completedSegments += 1;
        } else {
          job.predictionId = next.id;
        }
        if (job.completedSegments >= MAX_VIDEO_SEGMENTS) {
          videoJobs.delete(job.id);
          sendJson(response, 200, {
            id: job.id,
            status: "succeeded",
            duration: MAX_VIDEO_DURATION_SECONDS,
            totalSegments: MAX_VIDEO_SEGMENTS,
            completedSegments: job.completedSegments,
            videoUrls: job.videoUrls,
          });
          return;
        }
        sendJson(response, 200, {
          id: job.id,
          status: next.status === "starting" ? "starting" : "processing",
          duration: MAX_VIDEO_DURATION_SECONDS,
          totalSegments: MAX_VIDEO_SEGMENTS,
          completedSegments: job.completedSegments,
        });
        return;
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

  return createHttpServer(async (request, response) => {
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
