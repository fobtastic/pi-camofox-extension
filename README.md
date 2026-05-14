# pi-camofox-extension

Open-source pi extension for installing and using [camofox-browser](https://github.com/jo-inc/camofox-browser).

## Commands
- `/camofox-setup` - install/update the server package
- `/camofox-start` - start the local camofox server
- `/camofox-stop` - stop it
- `/camofox-status` - inspect install/server state
- `/camofox-logs [limit]` - show recent structured server logs

## Tools
- `camofox_setup`
- `camofox_start`
- `camofox_stop`
- `camofox_status`
- `camofox_logs`
- `camofox_create_tab`
- `camofox_snapshot`
- `camofox_click`
- `camofox_type`
- `camofox_navigate`
- `camofox_wait`
- `camofox_press`
- `camofox_scroll`
- `camofox_evaluate`
- `camofox_close_tab`
- `camofox_list_tabs`

## Install in pi
Add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/absolute/path/to/pi-camofox-extension"
  ]
}
```

Then run `/reload` in pi.

## Development
```bash
npm install
npm run check
```

## Environment
Copy `.env.example` to `.env` if you want local defaults. Do not commit `.env` files.

Supported variables:
- `CAMOFOX_BASE_URL`
- `CAMOFOX_PROXY_URL`
- `CAMOFOX_PROXY_BYPASS`
- `CAMOFOX_CRASH_REPORT_ENABLED`
- `CAMOFOX_CRASH_REPORT_URL`
- `CAMOFOX_CRASH_REPORT_REPO`
- `CAMOFOX_CRASH_REPORT_RATE_LIMIT`

Load order:
1. `~/.env` / `~/.env.local`
2. extension-local `.env` / `.env.local`
3. current working directory `.env` / `.env.local`
4. exported environment variables override file-based values

## Notes
- The server package installed is `@askjo/camofox-browser`.
- Initial setup also installs the optional `yt-dlp` dependency by default.
- First install/start may download the Camoufox browser payload via `camoufox-js`.
- Default server URL: `http://127.0.0.1:9377`.
- Proxy values are masked in status output.
- Upstream Camofox emits structured JSON logs and supports anonymized crash/hang telemetry; this extension now exposes recent logs via `/camofox-logs` and `camofox_logs`.
