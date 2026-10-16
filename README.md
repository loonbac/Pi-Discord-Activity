# pi-discord-activity

A repo-ready package for adding **Discord activity** support to the **Pi coding agent**.

This project is split into two pieces:

- a **Pi extension** that listens to real Pi session and activity events
- a **local helper daemon** that owns the Discord RPC connection and updates your Discord activity

## What this starter pack includes

- `package.json`
- TypeScript build config
- Pi extension implementation in `src/extension`
- Discord helper implementation in `src/helper`
- shared types/config in `src/shared`
- example local settings in `.pi/example-settings.json`
- install, setup, service, and verification docs

## Quick Start

### Published package install

For most users, the simplest path is to install the published package into Pi and let the extension auto-start the helper when Pi activity is first published.

1. **Install the Pi package**

   ```bash
   pi install npm:pi-discord-activity
   ```

2. **Open Pi and use it normally**

   With the default configuration, the extension will auto-start the helper the first time it needs to publish Discord activity.

3. **Verify the integration**

   Follow [docs/verification.md](./docs/verification.md) for the Discord-side checks.

If you prefer explicit process management, you can still start the helper manually:

```bash
pi-discord-activity-helper
# or
npx pi-discord-activity-helper
```

### Direct npm install

If you want the helper binary available directly from npm on your PATH:

```bash
npm install -g pi-discord-activity
```

You should still install the Pi package so Pi loads the extension:

```bash
pi install npm:pi-discord-activity
```

Then either let Pi auto-start the helper, or run it yourself:

```bash
pi-discord-activity-helper
```

### Local repo / development install

1. **Configure Discord (optional)**

   The package already ships with a working default Discord application ID, so custom setup is optional.

   ```bash
   # optional: override the built-in default app
   export DISCORD_RPC_CLIENT_ID="your_discord_client_id"
   ```

   For a custom Discord application, see [docs/discord-setup.md](./docs/discord-setup.md).

2. **Install dependencies and build**

   ```bash
   npm install
   npm run build
   ```

3. **Install the Pi extension**

   ```bash
   pi install .
   ```

   Manual fallback:

   ```bash
   mkdir -p ~/.pi/agent/extensions
   ln -s "$(pwd)/dist/extension/index.js" ~/.pi/agent/extensions/pi-discord-activity.js
   ```

4. **Start Pi and let the helper auto-start**

   The extension will start the helper automatically on the first publish attempt. If you prefer to run it yourself during development, you can still use:

   ```bash
   npm start
   ```

5. **Verify the integration**

   ```bash
   ./scripts/verify-installation.sh
   ```

   Then follow [docs/verification.md](./docs/verification.md) for the manual Discord-side checks.

## Status

This is a working Pi extension/helper package with:

- ✅ real Pi extension integration
- ✅ Discord activity transport and reconnect handling
- ✅ a built-in default Discord application ID for low-friction setup
- ✅ `pi install .` package installation support
- ✅ setup, service, and verification documentation

Typical next steps for a new user:

1. follow [INSTALL.md](./INSTALL.md)
2. optionally configure a custom Discord application
3. optionally set up a background service using [docs/service-recipes.md](./docs/service-recipes.md)
4. verify the full flow with [docs/verification.md](./docs/verification.md)

## Keeping this fork in sync with upstream

This fork adds the multi-session aggregate to the upstream plugin. The upstream keeps
improving, so the two lines are kept apart with a rebase, never a merge that hides
where a change came from:

```bash
scripts/sync-upstream.sh          # fetch upstream, report, then rebase this branch onto it
scripts/sync-upstream.sh --dry    # fetch and report only; changes nothing
```

It fails closed on uncommitted work or a conflict, and after a clean rebase the
suite is what decides whether the combination is sound:

```bash
npm ci && npm test
```

What lives in this fork, so a sync knows what must survive: the live-session
registry and `/retire` (`src/helper/index.ts`), the aggregate it publishes
(`src/shared/aggregate.ts`), the live subagent count (`src/helper/subagents.ts`),
and the summary Discord renders (`src/helper/discord.ts`).

## Requirements

- Node.js 20+
- npm 10+
- Discord desktop app running locally
- Pi coding agent installed locally

## Install

For the full guided flow, see [INSTALL.md](./INSTALL.md).

### Install from the published package

Recommended for most users:

```bash
pi install npm:pi-discord-activity
```

Then open Pi and let the extension auto-start the helper on first use.

Manual helper startup is still available if you want it:

```bash
pi-discord-activity-helper
# or
npx pi-discord-activity-helper
```

If you want the helper installed globally through npm as well:

```bash
npm install -g pi-discord-activity
```

### Install from the local repo

```bash
npm install
npm run build
pi install .
```

Then open Pi and let the extension auto-start the helper, or run `npm start` manually if you prefer.

### Guided setup scripts

The repo also includes automation scripts that can write `.env`, build the project, optionally run `pi install .`, and create a background service:

```bash
./setup.sh
# or on Windows
pwsh ./setup.ps1
```

## Local development

Run the helper daemon:

```bash
npm run dev:helper
```

In another terminal, build and install the extension or use `pi install .` again after making changes.

If you want to test the HTTP transport without Pi, keep the helper running and POST a payload to:

```text
http://127.0.0.1:42666/presence
```

## Environment variables

The package ships with a built-in default Discord RPC client ID:

- `1495329514417426522`

So `DISCORD_RPC_CLIENT_ID` is optional for normal use. The helper also reads `.env` and `.env.local` from the project root.

Common configuration:

```dotenv
DISCORD_RPC_CLIENT_ID=1495329514417426522
PI_PRESENCE_PORT=42666
PI_PRESENCE_HOST=127.0.0.1
PI_PRESENCE_PRIVACY_MODE=true
PI_PRESENCE_INCLUDE_PROJECT=false
PI_PRESENCE_DEBOUNCE_MS=2000
PI_PRESENCE_AUTOSTART_HELPER=true
PI_PRESENCE_DEBUG=false
```

Set `PI_PRESENCE_AUTOSTART_HELPER=false` if you want to disable auto-start and manage the helper manually or through an OS service.

### Privacy defaults

Default behavior is privacy-first:

- project name is hidden unless explicitly enabled
- prompt content is never sent to Discord
- filenames are not sent to Discord

To allow project names in the Discord state line, set both:

```bash
export PI_PRESENCE_PRIVACY_MODE="false"
export PI_PRESENCE_INCLUDE_PROJECT="true"
```

## Example Discord activity mapping

- **Details**: `Using Pi Coding Agent`
- **State**: `<model> • <activity>`
- **Large image**: `pi`
- **Small image**: provider key such as `openai`

Common activities:

- `Starting`
- `Thinking`
- `Running Tools`
- `Editing Files`
- `Idle`
- `Error`

## Documentation

- [INSTALL.md](./INSTALL.md) — full installation guide
- [docs/discord-setup.md](./docs/discord-setup.md) — custom Discord application setup
- [docs/service-recipes.md](./docs/service-recipes.md) — macOS, Linux, and Windows service recipes
- [docs/verification.md](./docs/verification.md) — manual verification flow and troubleshooting

## License

MIT
