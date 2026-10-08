# AI Video Studio

A text-to-video app built around MiniMax Video-01 on Replicate. Clients can sign in or create an account by continuing with Google or GitHub. The first successful OAuth sign-in creates their app account automatically; on later visits they use the same provider account. An optional owner-only username/password login can also be enabled.

The app currently does not store a separate account database or link Google and GitHub identities together. Each identity is authenticated by its provider and held in a signed, HTTP-only session cookie for up to eight hours. Video generations use the app owner's Replicate account, so provider charges apply to the owner.

## Free static previews

Every push to `main` deploys a free static preview to GitHub Pages using `.github/workflows/pages.yml`. To use Netlify instead, import this GitHub repository in Netlify; `netlify.toml` configures its build command, skips the optional FFmpeg binary, and publishes only the generated `dist/` preview. The build intentionally disables sign-in and in-app generation, including on custom Netlify domains. GitHub Pages and a static Netlify deploy cannot run this app's Node backend. Netlify's Free plan has a 300-credit limit, and usage is subject to its current plan limits.

The static preview is intentionally read-only: it does not run the app's backend or connect to the real Replicate generator. The actual app runs on a private Node backend and uses the authenticated `/api/videos` flow described below.

The separate Node backend uses paid MiniMax Video-01 through Replicate. A six-second request returns one generated clip. A 60-second request generates ten clips, downloads them on the server, and encodes them in order into one H.264 MP4 with FFmpeg; the browser receives only the final video URL, never the individual clip URLs. The merged video is served from the Node app at `/api/videos/<job-id>/file`, with the same signed-in account and byte-range checks used for video playback. The app does not collect payment, and the app owner pays the provider for each generated clip. Longer premium durations are not available.

## Requirements

- Node.js 22.9 or newer.
- The optional `ffmpeg-static` dependency installs a platform-specific FFmpeg binary for server-side MP4 encoding (standard Node-host installs include it). Set `FFMPEG_PATH` only if you need to use a separately installed FFmpeg binary.
- A Replicate account and API token with access to the [`minimax/video-01` model](https://replicate.com/minimax/video-01).
- A private session signing secret; generate one with `node -p "require('node:crypto').randomBytes(32).toString('base64url')"`
- OAuth client credentials for whichever sign-in providers you enable.

AI video generation uses paid provider compute. Review Replicate's current [billing information](https://replicate.com/docs/topics/billing) and model access/pricing before allowing clients to generate videos. Creating an app or account does not promise earnings or free provider credits.

## Configure Google and GitHub sign-in

1. Deploy the app to a public HTTPS Node host and set `APP_BASE_URL` to its exact origin, without a path or trailing slash (for example, `https://your-app.example.com`).
2. Create an OAuth client in Google Cloud. Add the callback URI `https://your-app.example.com/api/auth/callback/google` as an authorized redirect URI. Enable the Google identity scopes `openid`, `email`, and `profile`.
3. Create a GitHub OAuth App. Set its Authorization callback URL to `https://your-app.example.com/api/auth/callback/github`. GitHub's OAuth screen allows users to sign up for GitHub if they do not already have an account.
4. In the hosting provider's private environment settings, add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, and/or `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. Add the client secret only to the server environment, never to frontend code or Git.
5. Configure `APP_SESSION_SECRET` with a fresh random value. Configure `REPLICATE_API_TOKEN` to enable video generation. Redeploy after changing environment variables.
6. Open the app and select **Continue with Google** or **Continue with GitHub**. A successful first sign-in automatically creates that provider's account in the app; future sign-ins return to the same account.

Only providers with both client ID and secret, plus a valid `APP_BASE_URL`, are shown on the login page. Google sign-in requires a verified Google email address. Google and GitHub accounts are not automatically merged; clients should keep using the same provider they first used.

For Google to accept clients outside your Google Cloud test-user list, configure the OAuth consent screen for an external audience and publish the app; Google may require additional consent-screen verification. While it remains in testing mode, only accounts listed as test users can sign in.

## Optional owner password login

Set `APP_USERNAME` and a strong `APP_PASSWORD` of at least 16 characters to enable the separate owner login form. Do not share those credentials with clients. Leave them unset if you only want Google/GitHub access.

## Run locally

In PowerShell, copy the private environment template and edit it locally:

```powershell
Copy-Item .env.example .env
notepad .env
node -p "require('node:crypto').randomBytes(32).toString('base64url')"
```

In `.env`, set `REPLICATE_API_TOKEN` to your private Replicate token, `APP_SESSION_SECRET` to the generated random value, `APP_USERNAME`, and an `APP_PASSWORD` of at least 16 characters. Set `APP_BASE_URL=http://localhost:3000`. Google/GitHub credentials are optional if using the owner password form. Never paste the token into frontend code or chat; `.env` is git-ignored and is loaded only by the local Node server.

Start the backend and open the local app:

```powershell
npm.cmd start
```

Open `http://localhost:3000` in your browser; do not open `index.html` directly or serve the generated `dist/` directory. Localhost, loopback, and private LAN hosts served by `npm.cmd start` use the authenticated Node server mode, not the static preview. Sign in with the owner credentials or configure OAuth. Generation is enabled only after the server reports a Replicate token and session secret are configured; Replicate generation uses provider credits and is not free. If generation reports a missing token or billing/credit, configure your Replicate account before retrying. The `.github.io` and `.netlify.app` previews, the Netlify `dist/` build, and `file://` pages remain static and cannot generate videos.

Register `http://localhost:3000/api/auth/callback/google` and/or `http://localhost:3000/api/auth/callback/github` as the provider callback URI for local development. Do not use HTTP for a non-local deployment. `.env.example` lists all supported settings.

## Deploy to Render

1. Push this repository to GitHub.
2. In Render, create a **Blueprint** from the repository. Render uses `render.yaml` to configure the Node server.
3. In the service's **Environment** settings, add `REPLICATE_API_TOKEN`, `APP_SESSION_SECRET`, the Render public origin as `APP_BASE_URL`, and the OAuth client ID/secret pair for each provider you want to enable.
4. If you want the separate owner login, also add `APP_USERNAME` and a strong `APP_PASSWORD`.
5. In Google Cloud and GitHub, register the exact Render callback URLs listed above using the Render public origin.
6. Deploy and open the HTTPS URL Render provides. GitHub Pages alone cannot run this private Node API.

The server protects API calls and final MP4 playback with a signed HTTP-only session cookie, verifies OAuth state, and limits video generations. A 60-second request reserves capacity for all ten clips before starting; by default the global limit of 30 provider generations per hour therefore permits at most three 60-second videos per server per hour. `MAX_GENERATIONS_PER_HOUR` limits requests per client; the provider-generation limit is a fixed server-side safety cap. Rate limits, jobs, and output ownership are held in memory and reset if the service restarts, so a restart interrupts active work and invalidates the temporary video URLs. Merged MP4 files are stored on the server's local temporary filesystem and removed after 30 minutes; `VIDEO_OUTPUT_DIRECTORY` can select another local path. On hosts with ephemeral filesystems, restarting or replacing the instance removes the files. Anyone who can sign in can use the app owner's Replicate balance.

## Model limitations

MiniMax Video-01 through Replicate currently produces six-second landscape clips. The 60-second option trims and encodes ten clips in sequence as one 1280×720, 24-fps H.264 MP4; generated sound is not included, clip-to-clip visual consistency can vary, and actual duration depends on provider output. Clips larger than 32 MiB are rejected. The merge runs on the app server and needs CPU, temporary disk space, and FFmpeg; generation and encoding can take several minutes. The interface uses landscape output rather than offering portrait/square output it cannot deliver. Style is guided through the prompt because this model does not expose a dedicated style parameter. See the [model API](https://replicate.com/minimax/video-01/api) and [Replicate prediction docs](https://replicate.com/docs/topics/predictions/create-a-prediction).
