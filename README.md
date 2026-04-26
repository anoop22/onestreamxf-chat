# OneStream XF Skill Chat

A static GitHub Pages demo that answers OneStream XF questions with the public
[`anoop22/onestreamxf-skill`](https://github.com/anoop22/onestreamxf-skill)
loaded as its working skill.

The app runs entirely in the browser:

- GitHub Pages serves the static React/Vite app.
- The browser fetches the public skill Markdown files from GitHub.
- `@mariozechner/pi-agent-core` runs the agent loop and tool execution.
- `@mariozechner/pi-ai` streams responses from OpenRouter.
- The user provides an OpenRouter API key locally in the browser.

## Local Development

```bash
npm install
npm run dev
```

Open the printed local URL and enter an OpenRouter API key. The default model is
`openrouter/free`, which routes to a free model that supports the requested
features where available.

## Build

```bash
npm run build
```

The production build is emitted to `docs/` with the Vite base path configured
for `https://anoop22.github.io/onestreamxf-chat/`.

## Deploy

Run `npm run build`, commit the updated `docs/` directory, and push `main`.
GitHub Pages is configured to serve the `docs/` folder from the `main` branch.

## Notes

OpenRouter free models still require an OpenRouter API key and are rate-limited.
The API key is stored in browser `localStorage`; there is no server-side backend
in this app.
