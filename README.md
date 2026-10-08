# AI Video Studio

A text-to-video app built around MiniMax Video-01 on Replicate. Clients can sign in or create an account by continuing with Google or GitHub. The first successful OAuth sign-in creates their app account automatically; on later visits they use the same provider account. An optional owner-only username/password login can also be enabled.

The app currently does not store a separate account database or link Google and GitHub identities together. Each identity is authenticated by its provider and held in a signed, HTTP-only session cookie for up to eight hours. Video generations use the app owner's Replicate account, so provider charges apply to the owner.

## Free static previews

Every push to `main` deploys a free static preview to GitHub Pages using `.github/workflows/pages.yml`. To use Netlify instead, import this GitHub repository in Netlify; `netlify.toml` configures its build command and publishes only the generated `dist/` preview. The build intentionally disables sign-in and in-app generation, including on custom Netlify domains. GitHub Pages and a static Netlify deploy cannot run this app's Node backend. Netlify's Free plan has a 300-credit limit, and usage is subject to its current plan limits.

The static preview links to a separate public [Hugging Face LTX Video ZeroGPU demo](https://huggingface.co/spaces/DeepRat/LTX-Video-ZeroGPU-Optimized) for short video tests. That is not this app's API or a production service: its own documentation says output is up to about 8.5 seconds, public Spaces can be queued or rate-limited, and Hugging Face's current ZeroGPU documentation lists 2 GPU minutes per day for unauthenticated visitors and 5 for free accounts. Prompts are sent to that third party; do not enter private information. Availability and quotas can change.

The separate Node backend still uses paid MiniMax Video-01 through Replicate. Clients can request one six-second clip or a 60-second free-for-clients video; the 60-second result is ten separate clips played consecutively, not one joined MP4, and the app owner pays the provider. Premium durations remain unavailable until payment and a longer-video workflow are configured.

## Requirements

- Node.js 22 or newer.
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

In PowerShell, set environment variables for the current terminal session and start the server:

```powershell
$env:REPLICATE_API_TOKEN = "your-private-replicate-token"
$env:APP_SESSION_SECRET = "paste-the-random-session-secret-you-generated"
$env:APP_BASE_URL = "http://localhost:3000"
$env:GOOGLE_CLIENT_ID = "your-google-client-id"
$env:GOOGLE_CLIENT_SECRET = "your-google-client-secret"
$env:GITHUB_CLIENT_ID = "your-github-client-id"
$env:GITHUB_CLIENT_SECRET = "your-github-client-secret"
npm.cmd start
```

Register `http://localhost:3000/api/auth/callback/google` and/or `http://localhost:3000/api/auth/callback/github` as the provider callback URI for local development. Do not use HTTP for a non-local deployment. `.env.example` lists all supported settings.

## Deploy to Render

1. Push this repository to GitHub.
2. In Render, create a **Blueprint** from the repository. Render uses `render.yaml` to configure the Node server.
3. In the service's **Environment** settings, add `REPLICATE_API_TOKEN`, `APP_SESSION_SECRET`, the Render public origin as `APP_BASE_URL`, and the OAuth client ID/secret pair for each provider you want to enable.
4. If you want the separate owner login, also add `APP_USERNAME` and a strong `APP_PASSWORD`.
5. In Google Cloud and GitHub, register the exact Render callback URLs listed above using the Render public origin.
6. Deploy and open the HTTPS URL Render provides. GitHub Pages alone cannot run this private Node API.

The server protects API calls with a signed HTTP-only session cookie, verifies OAuth state, and limits video generations. A 60-second request reserves capacity for all ten clips before starting; by default the global limit of 30 provider generations per hour therefore permits at most three 60-second videos per server per hour. `MAX_GENERATIONS_PER_HOUR` limits requests per client; the provider-generation limit is a fixed server-side safety cap. Rate limits and in-progress video jobs are held in memory and reset if the service restarts, so a restart can interrupt a long video. Anyone who can sign in can use the app owner's Replicate balance.

## Model limitations

MiniMax Video-01 through Replicate currently produces six-second landscape clips from text prompts. Longer videos in this app are a sequential playback of separate clips rather than a single stitched download. The interface uses the model's supported format rather than offering portrait/square output it cannot deliver. Style is guided through the prompt because this model does not expose a dedicated style parameter. Generation time and output availability depend on the provider. See the [model API](https://replicate.com/minimax/video-01/api) and [Replicate prediction docs](https://replicate.com/docs/topics/predictions/create-a-prediction).
