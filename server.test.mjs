import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server.mjs";
import ffmpegPath from "ffmpeg-static";

const USERNAME = "studio-owner";
const PASSWORD = "test-only-strong-password-2026";
const SESSION_SECRET = "test-only-session-signing-secret-at-least-32-bytes";
const API_TOKEN = "test-replicate-token";
const VALID_BODY = { prompt: "A quiet lake at sunrise.", style: "Cinematic" };

async function withServer(run, options = {}) {
  const videoOutputDirectory = options.videoOutputDirectory ||
    await mkdtemp(join(tmpdir(), "ai-video-studio-test-"));
  const environment = options.environment || {
    REPLICATE_API_TOKEN: API_TOKEN,
    APP_USERNAME: USERNAME,
    APP_PASSWORD: PASSWORD,
    APP_SESSION_SECRET: SESSION_SECRET,
    MAX_GENERATIONS_PER_HOUR: "5",
    ...options.env,
  };
  const server = createServer({
    env: environment,
    fetchImpl: options.fetchImpl,
    now: options.now,
    videoOutputDirectory,
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    if (!options.videoOutputDirectory) {
      await rm(videoOutputDirectory, { recursive: true, force: true });
    }
  }
}

let videoFixturePromise;
async function getSixSecondVideoFixture() {
  if (!videoFixturePromise) {
    videoFixturePromise = (async () => {
      const directory = await mkdtemp(join(tmpdir(), "ai-video-studio-fixture-"));
      const path = join(directory, "clip.mp4");
      try {
        const result = spawnSync(ffmpegPath, [
          "-hide_banner",
          "-loglevel", "error",
          "-f", "lavfi",
          "-i", "color=c=blue:s=160x90:r=24:d=6",
          "-an",
          "-c:v", "libx264",
          "-pix_fmt", "yuv420p",
          "-movflags", "+faststart",
          path,
        ], { encoding: "utf8", timeout: 60_000 });
        assert.equal(result.status, 0, result.stderr || result.error?.message);
        return await readFile(path);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    })();
  }
  return videoFixturePromise;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function login(baseUrl, credentials = { username: USERNAME, password: PASSWORD }) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(credentials),
  });
  return { response, cookie: response.headers.get("set-cookie")?.split(";")[0] };
}

function sessionHeaders(cookie) {
  return { Cookie: cookie };
}

async function generateVideo(baseUrl, cookie, body = VALID_BODY) {
  return fetch(`${baseUrl}/api/videos`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...sessionHeaders(cookie) },
    body: JSON.stringify(body),
  });
}

test("serves the login screen and protects it with same-origin browser policy", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy"), /connect-src 'self'/);
    assert.doesNotMatch(response.headers.get("content-security-policy"), /script-src[^;]*unsafe-inline/);
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.match(html, /Sign in or create an account/);
    assert.match(html, /Continue with Google/);
    assert.match(html, /Continue with GitHub/);
    assert.match(html, /\.auth-shell\[hidden\]\s*\{\s*display:\s*none;/);
    assert.match(html, /id="demoNotice"/);
    assert.match(html, /function isLocalPrivateHost\(hostname\)/);
    assert.match(html, /host === "localhost"/);
    assert.match(html, /host === "127\.0\.0\.1"/);
    assert.match(html, /host === "::1"/);
    assert.match(html, /host\.endsWith\("\.localhost"\)/);
    assert.match(html, /host\.endsWith\("\.local"\)/);
    assert.match(html, /octets\[0\] === 192 && octets\[1\] === 168/);
    assert.match(html, /window\.location\.protocol === "file:"/);
    assert.match(html, /!isLocalPrivateHost\(hostname\)/);
    assert.match(html, /hostname\.endsWith\("\.github\.io"\).*hostname\.endsWith\("\.netlify\.app"\)/);
    assert.match(html, /Static preview only\./);
    assert.match(html, /60-second MP4 · 10 clips merged/);
    assert.match(html, /Free for clients\. The studio owner pays AI provider charges/);
    assert.match(html, /id="generateHint"/);
    assert.match(html, /function setGenerationAvailability\(ready\)/);
    assert.match(html, /generateButton\.disabled = ready !== true/);
    assert.match(html, /Video generation is not configured on the private server/);
    assert.match(html, /Combining clips into one MP4/);
    assert.doesNotMatch(html, /videoPlaylist|videoUrls|Open the free video demo|Hugging Face/);
    assert.match(html, /Video generation unavailable in static preview/);
    assert.match(html, /<script nonce="[a-zA-Z0-9+/]+=*">/);
    assert.match(html, /type="password"/);
    assert.doesNotMatch(html, /Your private access code|REPLICATE_API_TOKEN/);
  });
});

test("enables the real generation UI on localhost when the backend is ready", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl);
    const html = await response.text();
    const modeCode = html.match(/function isLocalPrivateHost\(hostname\) \{[\s\S]*?let requestInProgress = false;/)?.[0];
    const availabilityCode = html.match(/function setGenerationAvailability\(ready\) \{[\s\S]*?\n        \}/)?.[0];
    assert.ok(modeCode, "frontend host-mode logic should exist");
    assert.ok(availabilityCode, "frontend readiness logic should exist");
    assert.match(html, /fetch\("\/api\/videos"/);

    const assessMode = (hostname, protocol, ready) => {
      const generateHint = { textContent: "" };
      const generateButton = { disabled: true };
      const state = runInNewContext(
        `${modeCode}\n${availabilityCode}\n({ isStaticDemo, setGenerationAvailability })`,
        {
          window: { location: { hostname, protocol } },
          document: { getElementById: (id) => id === "generateHint" ? generateHint : null },
          generateButton,
        },
      );
      state.setGenerationAvailability(ready);
      return { isStaticDemo: state.isStaticDemo, disabled: generateButton.disabled };
    };

    const sessionResponse = await fetch(`${baseUrl}/api/auth/session`);
    const session = await sessionResponse.json();
    assert.equal(session.ready, true);
    assert.deepEqual(assessMode("localhost", "http:", session.ready), {
      isStaticDemo: false,
      disabled: false,
    });
    assert.deepEqual(assessMode("192.168.1.20", "http:", session.ready), {
      isStaticDemo: false,
      disabled: false,
    });
    assert.deepEqual(assessMode("malik.github.io", "https:", session.ready), {
      isStaticDemo: true,
      disabled: true,
    });
    assert.deepEqual(assessMode("localhost", "http:", false), {
      isStaticDemo: false,
      disabled: true,
    });
  });
});

test("reports login setup status without exposing server configuration", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/session`);
    assert.deepEqual(await response.json(), {
      authenticated: false,
      ready: false,
      providers: { password: false, google: false, github: false },
      user: null,
    });
  }, {
    env: {
      REPLICATE_API_TOKEN: "",
      APP_USERNAME: "",
      APP_PASSWORD: "",
      APP_SESSION_SECRET: "",
    },
  });
});

test("reports generation readiness without returning the server-side API token", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/session`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ready, true);
    assert.equal(JSON.stringify(payload).includes(API_TOKEN), false);
  });
});

test("requires correct login credentials and rate-limits failed logins", async () => {
  await withServer(async (baseUrl) => {
    const wrongLogin = await login(baseUrl, { username: USERNAME, password: "wrong password value" });
    assert.equal(wrongLogin.response.status, 401);
    assert.deepEqual(await wrongLogin.response.json(), { error: "Username or password is incorrect." });
    for (let attempt = 1; attempt < 10; attempt += 1) {
      await login(baseUrl, { username: USERNAME, password: "wrong password value" });
    }
    const lockedOut = await login(baseUrl, { username: USERNAME, password: PASSWORD });
    assert.equal(lockedOut.response.status, 429);
  });
});

test("starts Google and GitHub OAuth with provider callback URLs and CSRF state", async () => {
  const providers = {
    google: { clientId: "google-public-client-id", clientSecret: "google-private-client-secret" },
    github: { clientId: "github-public-client-id", clientSecret: "github-private-client-secret" },
  };
  await withServer(async (baseUrl) => {
    for (const provider of ["google", "github"]) {
      const response = await fetch(`${baseUrl}/api/auth/${provider}`, { redirect: "manual" });
      assert.equal(response.status, 302);
      const location = new URL(response.headers.get("location"));
      assert.equal(location.searchParams.get("client_id"), providers[provider].clientId);
      assert.equal(
        location.searchParams.get("redirect_uri"),
        `https://studio.example.com/api/auth/callback/${provider}`,
      );
      assert.equal(location.searchParams.get("response_type"), "code");
      assert.ok(location.searchParams.get("state"));
      if (provider === "github") {
        assert.equal(location.searchParams.get("allow_signup"), "true");
        assert.match(location.searchParams.get("scope"), /user:email/);
      } else {
        assert.equal(location.searchParams.get("scope"), "openid email profile");
      }
      const stateCookie = response.headers.get("set-cookie");
      assert.match(stateCookie, new RegExp(`ai_video_oauth_state_${provider}=`));
      assert.match(stateCookie, /HttpOnly/);
      assert.match(stateCookie, /SameSite=Lax/);
      assert.equal(stateCookie.includes(providers[provider].clientSecret), false);
    }

    const status = await fetch(`${baseUrl}/api/auth/session`);
    const statusBody = await status.json();
    assert.deepEqual(statusBody.providers, { password: true, google: true, github: true });
    assert.equal(JSON.stringify(statusBody).includes(providers.google.clientSecret), false);
    assert.equal(JSON.stringify(statusBody).includes(providers.github.clientSecret), false);
  }, {
    env: {
      APP_BASE_URL: "https://studio.example.com",
      GOOGLE_CLIENT_ID: providers.google.clientId,
      GOOGLE_CLIENT_SECRET: providers.google.clientSecret,
      GITHUB_CLIENT_ID: providers.github.clientId,
      GITHUB_CLIENT_SECRET: providers.github.clientSecret,
    },
  });
});

test("completes Google and GitHub OAuth, creates provider sessions, and returns the account identity", async () => {
  const identities = {
    google: { id: "google:account-123", provider: "google", name: "Google Client", email: "client@example.com" },
    github: { id: "github:456", provider: "github", name: "GitHub Client", email: null },
  };
  await withServer(async (baseUrl) => {
    for (const provider of ["google", "github"]) {
      const start = await fetch(`${baseUrl}/api/auth/${provider}`, { redirect: "manual" });
      const location = new URL(start.headers.get("location"));
      const state = location.searchParams.get("state");
      const cookie = start.headers.get("set-cookie").match(/ai_video_oauth_state_[^=]+=([^;]+)/)[0];
      const callback = await fetch(
        `${baseUrl}/api/auth/callback/${provider}?code=test-authorization-code&state=${encodeURIComponent(state)}`,
        { headers: { Cookie: cookie }, redirect: "manual" },
      );
      assert.equal(callback.status, 302);
      assert.equal(callback.headers.get("location"), "/");
      const cookieHeaders = callback.headers.getSetCookie().join("; ");
      assert.match(cookieHeaders, /ai_video_oauth_state_[^=]+=; Path=\/api\/auth\/callback; HttpOnly; SameSite=Lax; Max-Age=0/);
      assert.match(cookieHeaders, /ai_video_session=.*HttpOnly; SameSite=Strict; Max-Age=28800/);
      const sessionCookie = cookieHeaders.match(/ai_video_session=[^;,]+/)[0];
      const sessionResponse = await fetch(`${baseUrl}/api/auth/session`, {
        headers: sessionHeaders(sessionCookie),
      });
      const session = await sessionResponse.json();
      assert.equal(session.authenticated, true);
      assert.deepEqual(session.user, identities[provider]);
    }
  }, {
    env: {
      APP_BASE_URL: "https://studio.example.com",
      GOOGLE_CLIENT_ID: "google-public-client-id",
      GOOGLE_CLIENT_SECRET: "google-private-client-secret",
      GITHUB_CLIENT_ID: "github-public-client-id",
      GITHUB_CLIENT_SECRET: "github-private-client-secret",
    },
    fetchImpl: async (url, options = {}) => {
      const requestUrl = String(url);
      if (requestUrl.includes("oauth2.googleapis.com/token") || requestUrl.includes("github.com/login/oauth/access_token")) {
        const body = new URLSearchParams(options.body);
        assert.equal(body.get("code"), "test-authorization-code");
        assert.ok(body.get("client_secret"));
        return jsonResponse({ access_token: "provider-test-access-token" });
      }
      if (requestUrl === "https://openidconnect.googleapis.com/v1/userinfo") {
        assert.equal(options.headers.Authorization, "Bearer provider-test-access-token");
        return jsonResponse({
          sub: "account-123",
          name: "Google Client",
          email: "client@example.com",
          email_verified: true,
        });
      }
      if (requestUrl === "https://api.github.com/user") {
        assert.equal(options.headers.Authorization, "Bearer provider-test-access-token");
        return jsonResponse({ id: 456, login: "github-client", name: "GitHub Client", email: null });
      }
      throw new Error(`Unexpected OAuth request: ${requestUrl}`);
    },
  });
});

test("rejects OAuth callbacks without a matching state cookie", async () => {
  let providerCalls = 0;
  await withServer(async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/auth/callback/google?code=authorization-code&state=attacker-state`,
      { redirect: "manual" },
    );
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/?authError=state");
    assert.equal(response.headers.get("set-cookie"), "ai_video_oauth_state_google=; Path=/api/auth/callback; HttpOnly; SameSite=Lax; Max-Age=0");
    assert.equal(providerCalls, 0);
  }, {
    env: {
      APP_BASE_URL: "https://studio.example.com",
      GOOGLE_CLIENT_ID: "google-public-client-id",
      GOOGLE_CLIENT_SECRET: "google-private-client-secret",
    },
    fetchImpl: async () => {
      providerCalls += 1;
      return jsonResponse({});
    },
  });
});

test("creates secure HttpOnly login sessions and logs out cleanly", async () => {
  await withServer(async (baseUrl) => {
    const { response, cookie } = await login(baseUrl);
    assert.equal(response.status, 200);
    const loginBody = await response.json();
    assert.equal(loginBody.authenticated, true);
    assert.equal(Number.isSafeInteger(loginBody.expiresAt), true);
    const setCookie = response.headers.get("set-cookie");
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Max-Age=28800/);
    assert.doesNotMatch(setCookie, /Bearer|r8_/);

    const session = await fetch(`${baseUrl}/api/auth/session`, {
      headers: sessionHeaders(cookie),
    });
    assert.deepEqual(await session.json(), {
      authenticated: true,
      ready: true,
      providers: { password: true, google: false, github: false },
      user: { id: `password:${USERNAME}`, provider: "password", name: USERNAME, email: null },
    });

    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: sessionHeaders(cookie),
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
    const loggedOut = await fetch(`${baseUrl}/api/auth/session`);
    assert.deepEqual(await loggedOut.json(), {
      authenticated: false,
      ready: true,
      providers: { password: true, google: false, github: false },
      user: null,
    });
  });
});

test("marks the HttpOnly session cookie secure behind an HTTPS proxy", async () => {
  await withServer(async (baseUrl) => {
    const origin = new URL(baseUrl).origin.replace("http:", "https:");
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "X-Forwarded-Proto": "https",
      },
      body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie"), /; Secure/);
  });
});

test("rejects cross-origin login attempts", async () => {
  await withServer(async (baseUrl) => {
    const origin = `${new URL(baseUrl).origin.replace("127.0.0.1", "localhost")}`;
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    });
    assert.equal(response.status, 403);
  });
});

test("rejects expired or modified session cookies", async () => {
  let timestamp = 1_800_000_000_000;
  await withServer(async (baseUrl) => {
    const { response, cookie } = await login(baseUrl);
    assert.equal(response.status, 200);
    const validStatus = await fetch(`${baseUrl}/api/auth/session`, {
      headers: sessionHeaders(cookie),
    });
    assert.equal((await validStatus.json()).authenticated, true);
    const modified = await fetch(`${baseUrl}/api/auth/session`, {
      headers: sessionHeaders(`${cookie}tampered`),
    });
    assert.equal((await modified.json()).authenticated, false);
    timestamp += 8 * 60 * 60 * 1000 + 1;
    const expired = await fetch(`${baseUrl}/api/auth/session`, {
      headers: sessionHeaders(cookie),
    });
    assert.equal((await expired.json()).authenticated, false);
  }, { now: () => timestamp });
});

test("invalidates active sessions when the configured login password changes", async () => {
  const environment = {
    REPLICATE_API_TOKEN: API_TOKEN,
    APP_USERNAME: USERNAME,
    APP_PASSWORD: PASSWORD,
    APP_SESSION_SECRET: SESSION_SECRET,
    MAX_GENERATIONS_PER_HOUR: "5",
  };
  await withServer(async (baseUrl) => {
    const { response, cookie } = await login(baseUrl);
    assert.equal(response.status, 200);
    environment.APP_PASSWORD = "new-test-password-that-is-long-enough";
    const session = await fetch(`${baseUrl}/api/auth/session`, {
      headers: sessionHeaders(cookie),
    });
    assert.equal((await session.json()).authenticated, false);
    const video = await generateVideo(baseUrl, cookie);
    assert.equal(video.status, 401);
  }, { environment });
});

test("blocks video generation until a valid login session exists", async () => {
  let providerCalls = 0;
  await withServer(async (baseUrl) => {
    const response = await generateVideo(baseUrl, "");
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Please log in again to continue." });
    assert.equal(providerCalls, 0);
  }, { fetchImpl: async () => {
    providerCalls += 1;
    return jsonResponse({ id: "prediction_1234", status: "starting" });
  } });
});

test("validates user input before calling the video provider", async () => {
  let providerCalls = 0;
  await withServer(async (baseUrl) => {
    const { cookie } = await login(baseUrl);
    const invalidPrompt = await generateVideo(baseUrl, cookie, { ...VALID_BODY, prompt: " ".repeat(4) });
    assert.equal(invalidPrompt.status, 400);

    const invalidStyle = await generateVideo(baseUrl, cookie, { ...VALID_BODY, style: "unknown-model-options" });
    assert.equal(invalidStyle.status, 400);

    const unavailablePremium = await generateVideo(baseUrl, cookie, { ...VALID_BODY, duration: 90 });
    assert.equal(unavailablePremium.status, 400);
    assert.match((await unavailablePremium.json()).error, /longer durations are not available/i);

    const malformed = await fetch(`${baseUrl}/api/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionHeaders(cookie) },
      body: "{",
    });
    assert.equal(malformed.status, 400);
    assert.equal(providerCalls, 0);
  }, {
    fetchImpl: async () => {
      providerCalls += 1;
      return jsonResponse({ id: "prediction_1234", status: "starting" });
    },
  });
});

test("merges ten provider clips into one secured playable 60-second MP4", async () => {
  const fixture = await getSixSecondVideoFixture();
  const videoOutputDirectory = await mkdtemp(join(tmpdir(), "ai-video-studio-output-test-"));
  const providerRequests = [];
  let clipDownloads = 0;
  try {
    await withServer(async (baseUrl) => {
    const { cookie } = await login(baseUrl);
    const started = await generateVideo(baseUrl, cookie, { ...VALID_BODY, duration: 60 });
    assert.equal(started.status, 202);
    const job = await started.json();
    assert.equal(job.duration, 60);
    assert.equal(job.totalSegments, 10);
    assert.equal(job.completedSegments, 0);

    for (let segment = 0; segment < 10; segment += 1) {
      const response = await fetch(`${baseUrl}/api/videos/${encodeURIComponent(job.id)}`, {
        headers: sessionHeaders(cookie),
      });
      assert.equal(response.status, 200);
      const progress = await response.json();
      if (segment < 9) {
        assert.equal(progress.status, "processing");
        assert.equal(progress.completedSegments, segment + 1);
      } else {
        assert.equal(progress.status, "combining");
        assert.equal(progress.completedSegments, 10);
        assert.equal("videoUrls" in progress, false);
      }
    }

    let finished;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const response = await fetch(`${baseUrl}/api/videos/${encodeURIComponent(job.id)}`, {
        headers: sessionHeaders(cookie),
      });
      assert.equal(response.status, 200);
      finished = await response.json();
      if (finished.status !== "combining") break;
    }
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.duration, 60);
    assert.equal(finished.completedSegments, 10);
    assert.equal(finished.videoUrl, `/api/videos/${job.id}/file`);
    assert.equal("videoUrls" in finished, false);

    const videoResponse = await fetch(new URL(finished.videoUrl, baseUrl), {
      headers: sessionHeaders(cookie),
    });
    assert.equal(videoResponse.status, 200);
    assert.equal(videoResponse.headers.get("content-type"), "video/mp4");
    assert.match(videoResponse.headers.get("content-disposition"), /inline; filename="ai-video-/);
    const finalVideo = Buffer.from(await videoResponse.arrayBuffer());
    assert.ok(finalVideo.length > fixture.length);
    assert.equal(finalVideo.subarray(4, 8).toString("ascii"), "ftyp");

    const rangeResponse = await fetch(new URL(finished.videoUrl, baseUrl), {
      headers: { ...sessionHeaders(cookie), Range: "bytes=0-31" },
    });
    assert.equal(rangeResponse.status, 206);
    assert.equal(rangeResponse.headers.get("content-range"), `bytes 0-31/${finalVideo.length}`);
    assert.equal((await rangeResponse.arrayBuffer()).byteLength, 32);

    const inspected = spawnSync(ffmpegPath, [
      "-hide_banner",
      "-i", join(videoOutputDirectory, `${job.id}.mp4`),
      "-f", "null",
      "-",
    ], { encoding: "utf8", timeout: 60_000 });
    assert.equal(inspected.status, 0, inspected.stderr || inspected.error?.message);
    assert.match(inspected.stderr, /Duration: 00:01:00(?:\.00)?/);

    const generationRequests = providerRequests.filter((request) => request.method === "POST");
    assert.equal(generationRequests.length, 10);
    assert.equal(clipDownloads, 10);
    assert.match(generationRequests[0].body.input.prompt, /quiet lake at sunrise/);
    assert.match(generationRequests[9].body.input.prompt, /clip 10 of 10/);
  }, {
    fetchImpl: async (url, options) => {
      const requestUrl = String(url);
      if (requestUrl.startsWith("https://replicate.delivery/clip-")) {
        clipDownloads += 1;
        return new Response(fixture, { headers: { "Content-Type": "video/mp4" } });
      }
      providerRequests.push({
        url: requestUrl,
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : null,
      });
      if (options.method === "POST") {
        const segment = providerRequests.filter((request) => request.method === "POST").length;
        return jsonResponse({ id: `prediction_${String(segment).padStart(4, "0")}`, status: "processing" });
      }
      const segment = Number(requestUrl.match(/prediction_(\d+)/)?.[1]);
      return jsonResponse({
        id: `prediction_${String(segment).padStart(4, "0")}`,
        status: "succeeded",
        output: `https://replicate.delivery/clip-${segment}.mp4`,
      });
    },
    videoOutputDirectory,
  });
  } finally {
    await rm(videoOutputDirectory, { recursive: true, force: true });
  }
});

test("rejects a second active long-video job from the same client", async () => {
  await withServer(async (baseUrl) => {
    const { cookie } = await login(baseUrl);
    const first = await generateVideo(baseUrl, cookie, { ...VALID_BODY, duration: 60 });
    assert.equal(first.status, 202);
    const second = await generateVideo(baseUrl, cookie, { ...VALID_BODY, duration: 60 });
    assert.equal(second.status, 429);
  }, {
    fetchImpl: async () => jsonResponse({ id: "prediction_1234", status: "processing" }),
  });
});

test("marks a long-video job failed when a later provider clip fails", async () => {
  const fixture = await getSixSecondVideoFixture();
  let generationCount = 0;
  await withServer(async (baseUrl) => {
    const { cookie } = await login(baseUrl);
    const started = await generateVideo(baseUrl, cookie, { ...VALID_BODY, duration: 60 });
    const job = await started.json();
    const response = await fetch(`${baseUrl}/api/videos/${encodeURIComponent(job.id)}`, {
      headers: sessionHeaders(cookie),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, "failed");
    assert.match(result.error, /could not generate this video/i);
  }, {
    fetchImpl: async (url, options) => {
      if (String(url).startsWith("https://replicate.delivery/")) {
        return new Response(fixture, { headers: { "Content-Type": "video/mp4" } });
      }
      if (options.method === "POST") {
        generationCount += 1;
        return generationCount === 1
          ? jsonResponse({ id: "prediction_1234", status: "processing" })
          : jsonResponse({ status: "failed" });
      }
      return jsonResponse({
        id: "prediction_1234",
        status: "succeeded",
        output: "https://replicate.delivery/clip-1.mp4",
      });
    },
  });
});

test("does not download generated clips from hosts outside Replicate delivery", async () => {
  let clipDownloadRequests = 0;
  let generationCount = 0;
  await withServer(async (baseUrl) => {
    const { cookie } = await login(baseUrl);
    const started = await generateVideo(baseUrl, cookie, { ...VALID_BODY, duration: 60 });
    const job = await started.json();

    for (let segment = 0; segment < 10; segment += 1) {
      const response = await fetch(`${baseUrl}/api/videos/${encodeURIComponent(job.id)}`, {
        headers: sessionHeaders(cookie),
      });
      assert.equal(response.status, 200);
    }

    let result;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const response = await fetch(`${baseUrl}/api/videos/${encodeURIComponent(job.id)}`, {
        headers: sessionHeaders(cookie),
      });
      result = await response.json();
      if (result.status !== "combining") break;
    }
    assert.equal(result.status, "failed");
    assert.match(result.error, /finished without a valid video URL/i);
    assert.equal(clipDownloadRequests, 0);
  }, {
    fetchImpl: async (url, options) => {
      const requestUrl = String(url);
      if (requestUrl.startsWith("https://attacker.example/")) {
        clipDownloadRequests += 1;
        return new Response("not a video");
      }
      if (options.method === "POST") {
        generationCount += 1;
        return jsonResponse({
          id: `prediction_${String(generationCount).padStart(4, "0")}`,
          status: "processing",
        });
      }
      const segment = Number(requestUrl.match(/prediction_(\d+)/)?.[1]);
      return jsonResponse({
        id: `prediction_${String(segment).padStart(4, "0")}`,
        status: "succeeded",
        output: "https://attacker.example/clip.mp4",
      });
    },
  });
});

test("does not follow Replicate clip redirects to untrusted hosts", async (t) => {
  let clipRequests = 0;
  let untrustedRequests = 0;
  t.mock.method(console, "error", () => {});
  await withServer(async (baseUrl) => {
    const { cookie } = await login(baseUrl);
    const started = await generateVideo(baseUrl, cookie, { ...VALID_BODY, duration: 60 });
    const job = await started.json();
    const response = await fetch(`${baseUrl}/api/videos/${encodeURIComponent(job.id)}`, {
      headers: sessionHeaders(cookie),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, "failed");
    assert.match(result.error, /could not download a generated clip/i);
    assert.equal(clipRequests, 1);
    assert.equal(untrustedRequests, 0);
  }, {
    fetchImpl: async (url, options) => {
      const requestUrl = String(url);
      if (requestUrl.startsWith("https://replicate.delivery/")) {
        clipRequests += 1;
        return new Response(null, {
          status: 302,
          headers: { Location: "https://attacker.example/private.mp4" },
        });
      }
      if (requestUrl.startsWith("https://attacker.example/")) {
        untrustedRequests += 1;
        return new Response("should not be requested");
      }
      if (options.method === "POST") {
        return jsonResponse({ id: "prediction_1234", status: "processing" });
      }
      return jsonResponse({
        id: "prediction_1234",
        status: "succeeded",
        output: "https://replicate.delivery/clip.mp4",
      });
    },
  });
});

test("prevents a different signed-in account from polling another account's long-video job", async () => {
  await withServer(async (baseUrl) => {
    const owner = await login(baseUrl);
    const started = await generateVideo(baseUrl, owner.cookie, { ...VALID_BODY, duration: 60 });
    const jobId = (await started.json()).id;

    const oauthStart = await fetch(`${baseUrl}/api/auth/github`, { redirect: "manual" });
    const state = new URL(oauthStart.headers.get("location")).searchParams.get("state");
    const stateCookie = oauthStart.headers.get("set-cookie").match(/ai_video_oauth_state_[^=]+=([^;]+)/)[0];
    const oauthCallback = await fetch(
      `${baseUrl}/api/auth/callback/github?code=another-account-code&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: stateCookie }, redirect: "manual" },
    );
    const otherUserCookie = oauthCallback.headers.getSetCookie()
      .find((cookie) => cookie.startsWith("ai_video_session="))
      .split(";")[0];
    const response = await fetch(`${baseUrl}/api/videos/${encodeURIComponent(jobId)}`, {
      headers: sessionHeaders(otherUserCookie),
    });
    assert.equal(response.status, 403);
    const videoFile = await fetch(`${baseUrl}/api/videos/${encodeURIComponent(jobId)}/file`, {
      headers: sessionHeaders(otherUserCookie),
    });
    assert.equal(videoFile.status, 403);
    const unauthenticatedFile = await fetch(`${baseUrl}/api/videos/${encodeURIComponent(jobId)}/file`);
    assert.equal(unauthenticatedFile.status, 401);
  }, {
    env: {
      APP_BASE_URL: "https://studio.example.com",
      GITHUB_CLIENT_ID: "github-public-client-id",
      GITHUB_CLIENT_SECRET: "github-private-client-secret",
    },
    fetchImpl: async (url) => {
      if (String(url).includes("github.com/login/oauth/access_token")) {
        return jsonResponse({ access_token: "other-user-access-token" });
      }
      if (String(url) === "https://api.github.com/user") {
        return jsonResponse({ id: 789, login: "different-client" });
      }
      return jsonResponse({ id: "prediction_1234", status: "processing" });
    },
  });
});

test("submits a prompt securely and returns a finished HTTPS video", async () => {
  const requests = [];
  await withServer(async (baseUrl) => {
    const { cookie } = await login(baseUrl);
    const started = await generateVideo(baseUrl, cookie, { ...VALID_BODY, style: "Animation" });
    assert.equal(started.status, 202);
    assert.equal(started.headers.get("cache-control"), "no-store");
    assert.deepEqual(await started.json(), { id: "prediction_1234", status: "processing" });
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/v1\/models\/minimax\/video-01\/predictions$/);
    assert.equal(requests[0].authorization, `Bearer ${API_TOKEN}`);
    assert.deepEqual(requests[0].body.input, {
      prompt: "Visual style: Animation. A quiet lake at sunrise.",
      prompt_optimizer: true,
    });

    const finished = await fetch(`${baseUrl}/api/videos/prediction_1234`, {
      headers: sessionHeaders(cookie),
    });
    assert.equal(finished.status, 200);
    assert.deepEqual(await finished.json(), {
      id: "prediction_1234",
      status: "succeeded",
      videoUrl: "https://replicate.delivery/example.mp4",
    });
    assert.equal(requests.length, 2);
    assert.match(requests[1].url, /\/v1\/predictions\/prediction_1234$/);
  }, {
    fetchImpl: async (url, options) => {
      requests.push({
        url,
        authorization: options.headers.Authorization,
        body: options.body ? JSON.parse(options.body) : undefined,
      });
      if (options.method === "POST") {
        return jsonResponse({ id: "prediction_1234", status: "processing" });
      }
      return jsonResponse({
        id: "prediction_1234",
        status: "succeeded",
        output: "https://replicate.delivery/example.mp4",
      });
    },
  });
});

test("rejects insecure provider output URLs", async () => {
  const invalidUrls = [
    "http://insecure.example/video.mp4",
    "https://attacker.example/video.mp4",
    "https://user@replicate.delivery/video.mp4",
  ];
  await withServer(async (baseUrl) => {
    const { cookie } = await login(baseUrl);
    for (const invalidUrl of invalidUrls) {
      const response = await fetch(`${baseUrl}/api/videos/prediction_1234`, {
        headers: sessionHeaders(cookie),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        id: "prediction_1234",
        status: "failed",
        error: "The provider finished without a valid video URL.",
      });
    }
  }, {
    fetchImpl: async () => jsonResponse({
      id: "prediction_1234",
      status: "succeeded",
      output: invalidUrls.shift(),
    }),
  });
});

test("applies both per-client and global generation rate limits", async () => {
  let providerCalls = 0;
  await withServer(async (baseUrl) => {
    const { cookie } = await login(baseUrl);
    assert.equal((await generateVideo(baseUrl, cookie)).status, 202);
    assert.equal((await generateVideo(baseUrl, cookie)).status, 429);
    assert.equal(providerCalls, 1);
  }, {
    env: { MAX_GENERATIONS_PER_HOUR: "1" },
    fetchImpl: async () => {
      providerCalls += 1;
      return jsonResponse({ id: "prediction_1234", status: "starting" });
    },
  });
});

test("reserves rate-limit capacity before concurrent provider requests", async () => {
  let providerCalls = 0;
  let releaseProvider;
  const providerResponse = new Promise((resolve) => {
    releaseProvider = resolve;
  });
  await withServer(async (baseUrl) => {
    const { cookie } = await login(baseUrl);
    const firstRequest = generateVideo(baseUrl, cookie);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const secondResponse = await generateVideo(baseUrl, cookie);
    assert.equal(secondResponse.status, 429);
    releaseProvider(jsonResponse({ id: "prediction_1234", status: "starting" }));
    assert.equal((await firstRequest).status, 202);
    assert.equal(providerCalls, 1);
  }, {
    env: { MAX_GENERATIONS_PER_HOUR: "1" },
    fetchImpl: async () => {
      providerCalls += 1;
      return providerResponse;
    },
  });
});

test("reports provider billing errors without leaking API credentials", async () => {
  await withServer(async (baseUrl) => {
    const { cookie } = await login(baseUrl);
    const response = await generateVideo(baseUrl, cookie);
    assert.equal(response.status, 402);
    const body = await response.json();
    assert.match(body.error, /billing|credit/);
    assert.equal(JSON.stringify(body).includes(API_TOKEN), false);
  }, {
    fetchImpl: async () => jsonResponse({ detail: "Payment required." }, 402),
  });
});
