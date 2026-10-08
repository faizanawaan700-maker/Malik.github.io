import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "./server.mjs";

const USERNAME = "studio-owner";
const PASSWORD = "test-only-strong-password-2026";
const SESSION_SECRET = "test-only-session-signing-secret-at-least-32-bytes";
const API_TOKEN = "test-replicate-token";
const VALID_BODY = { prompt: "A quiet lake at sunrise.", style: "Cinematic" };

async function withServer(run, options = {}) {
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
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
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
    assert.match(html, /<script nonce="[a-zA-Z0-9+/]+=*">/);
    assert.match(html, /type="password"/);
    assert.doesNotMatch(html, /Your private access code|REPLICATE_API_TOKEN/);
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
    assert.match((await unavailablePremium.json()).error, /premium plans are not available/i);

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

test("generates a 60-second free video from ten secured six-second clips", async () => {
  const providerRequests = [];
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
        assert.equal(progress.status, "succeeded");
        assert.equal(progress.completedSegments, 10);
        assert.equal(progress.videoUrls.length, 10);
        assert.deepEqual(progress.videoUrls, Array.from(
          { length: 10 },
          (_, index) => `https://replicate.delivery/clip-${index + 1}.mp4`,
        ));
      }
    }
    const generationRequests = providerRequests.filter((request) => request.method === "POST");
    assert.equal(generationRequests.length, 10);
    assert.match(generationRequests[0].body.input.prompt, /quiet lake at sunrise/);
    assert.match(generationRequests[9].body.input.prompt, /clip 10 of 10/);
  }, {
    fetchImpl: async (url, options) => {
      providerRequests.push({
        url: String(url),
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : null,
      });
      if (options.method === "POST") {
        const segment = providerRequests.filter((request) => request.method === "POST").length;
        return jsonResponse({ id: `prediction_${String(segment).padStart(4, "0")}`, status: "processing" });
      }
      const segment = Number(String(url).match(/prediction_(\d+)/)?.[1]);
      return jsonResponse({
        id: `prediction_${String(segment).padStart(4, "0")}`,
        status: "succeeded",
        output: `https://replicate.delivery/clip-${segment}.mp4`,
      });
    },
  });
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
  await withServer(async (baseUrl) => {
    const { cookie } = await login(baseUrl);
    const response = await fetch(`${baseUrl}/api/videos/prediction_1234`, {
      headers: sessionHeaders(cookie),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      id: "prediction_1234",
      status: "failed",
      error: "The provider finished without a valid video URL.",
    });
  }, {
    fetchImpl: async () => jsonResponse({
      id: "prediction_1234",
      status: "succeeded",
      output: "http://insecure.example/video.mp4",
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
