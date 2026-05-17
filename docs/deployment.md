# Lang Tutor Deployment Runbook

This file captures the droplet-level setup that `lt.ps1 deploy` assumes. Keep
app release work in `lt.ps1`; keep one-time host provisioning here unless it
becomes worth automating as a separate bootstrap command.

## Current Production

- App URL: `https://leftos.dev/lang-tutor/`
- SSH target: `root@24.199.111.154` (dedicated lang-tutor droplet, `lang-tutor-1` in DO)
- App user: `lang-tutor`
- App root: `/opt/lang-tutor`
- Account database: `/var/lib/lang-tutor/account.sqlite`
- Code-run workspaces: `/var/lib/lang-tutor/runs`
- Project workspaces: `/var/lib/lang-tutor/workspaces/<user-id>/<language>`
- Shared project tool cache: `/var/lib/lang-tutor/cache`
- Node service port: `5190`
- Systemd unit: `lang-tutor.service`
- Docker image built by deploy: `lang-tutor-toolchains:latest` (Rust/C++/DASM/Python/C# single-file runs)

Provider API keys are entered by users in the browser. They are not stored in
the droplet environment, SQLite account database, or mirrored app state.

Project-language files are copied from the app templates into per-user scratch
workspaces under `/var/lib/lang-tutor/workspaces`. Web previews bind private
loopback-only Vite ports and are exposed to the browser through the app's
same-origin `/proj/preview/<lang>/` proxy.

## Normal Deploy

From `D:\dev\lang-tutor`:

```powershell
.\lt.ps1 deploy
```

For an uncommitted worktree deployment:

```powershell
.\lt.ps1 deploy -Worktree
```

`lt.ps1 deploy` currently does the repeatable app work:

- Archives the selected source tree and uploads an immutable release.
- Ensures host-side checker/LSP binaries are present:
  `rustc`, `rustfmt`, `rust-analyzer`, `clang`, `clang-format`, `clangd`,
  `python`, `black`, `basedpyright`, `typescript-language-server`,
  `vscode-html-language-server`, `vscode-css-language-server`, and `biome`.
- Builds the Vite app with `LANG_TUTOR_BASE_PATH` derived from `-DeployUrl`.
- Creates `/var/lib/lang-tutor`, `/var/lib/lang-tutor/runs`,
  `/var/lib/lang-tutor/workspaces`, and `/var/lib/lang-tutor/cache`.
- Ensures `LANG_TUTOR_PROJECT_ROOT=/var/lib/lang-tutor/workspaces` is present
  in `/etc/lang-tutor/lang-tutor-runtime.conf`.
- Builds and verifies `lang-tutor-toolchains:latest` for hosted code runs.
- Restarts `lang-tutor.service`.
- Smoke-tests `/lang-tutor`, `/lang-tutor/`, auth, protected state, and
  protected tooling endpoints.

## New Droplet Checklist

These are one-time host steps before `.\lt.ps1 deploy -DeployHost root@NEW_IP`
can succeed.

1. Add Nginx `location ^~ /lang-tutor/` (with `Host: leftos.dev`, `X-Forwarded-Proto https`) on the leftos.dev website droplet (`143.198.231.175`) so it `proxy_pass`es to the new tutor droplet IP. See `server-setup.sh` in the `leftos.dev` repo for the canonical block (it has the right `proxy_set_header Host leftos.dev` and `X-Forwarded-Proto https` headers so Caddy on this droplet routes correctly).
2. Install baseline host tools: Docker Engine, Node 22, pnpm, Caddy, Git, curl,
   and tar.
3. Create the `lang-tutor` system user and app/state directories.
4. Create `/etc/lang-tutor/lang-tutor-runtime.conf`.
5. Create and enable `/etc/systemd/system/lang-tutor.service`.
6. Configure Caddy on the tutor droplet to add `/lang-tutor` + `/lang-tutor/*` handlers under the `http://leftos.dev { ... }` site block, both proxying to `127.0.0.1:5190`. (HTTP-only — DNS for leftos.dev does not point at this droplet, so Caddy's auto-HTTPS is disabled for this site; TLS is terminated by the website droplet upstream.)
7. Run `.\lt.ps1 deploy -DeployHost root@NEW_IP`.
8. Verify:

```powershell
Invoke-WebRequest https://leftos.dev/lang-tutor -Method Head
Invoke-WebRequest https://leftos.dev/lang-tutor/ -Method Head
```

## Known-Good Host Files

Runtime environment:

```bash
install -d -m 0755 /etc/lang-tutor
cat >/etc/lang-tutor/lang-tutor-runtime.conf <<'EOF'
NODE_ENV=production
PORT=5190
LANG_TUTOR_BASE_PATH=/lang-tutor/
LANG_TUTOR_REQUIRE_AUTH=true
LANG_TUTOR_SECURE_COOKIES=true
LANG_TUTOR_DB_FILE=/var/lib/lang-tutor/account.sqlite
LANG_TUTOR_TOOLCHAIN_IMAGE=lang-tutor-toolchains:latest
LANG_TUTOR_RUN_ROOT=/var/lib/lang-tutor/runs
LANG_TUTOR_PROJECT_ROOT=/var/lib/lang-tutor/workspaces
EOF
```

System user and directories:

```bash
useradd --system --home /opt/lang-tutor --shell /usr/sbin/nologin lang-tutor || true
usermod -aG docker lang-tutor
install -d -o lang-tutor -g lang-tutor /opt/lang-tutor /opt/lang-tutor/releases
install -d -o lang-tutor -g lang-tutor /var/lib/lang-tutor /var/lib/lang-tutor/runs /var/lib/lang-tutor/workspaces /var/lib/lang-tutor/cache
```

Systemd service:

```bash
cat >/etc/systemd/system/lang-tutor.service <<'EOF'
[Unit]
Description=Lang Tutor hosted app
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
Type=simple
User=lang-tutor
Group=lang-tutor
SupplementaryGroups=docker
WorkingDirectory=/opt/lang-tutor/app
EnvironmentFile=/etc/lang-tutor/lang-tutor-runtime.conf
ExecStart=/usr/bin/node /opt/lang-tutor/app/server.mjs
Restart=on-failure
RestartSec=3
SuccessExitStatus=143
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/lang-tutor /opt/lang-tutor/app/.local /opt/lang-tutor/app/.tmp

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable lang-tutor.service
```

Caddy routing inside the tutor droplet's `http://leftos.dev { ... }` site
(lang-tutor is the only app on this droplet; `auto_https off` because the
website droplet upstream terminates TLS):

```caddyfile
{
    auto_https off
}

http://leftos.dev {
    handle /lang-tutor {
        reverse_proxy 127.0.0.1:5190
    }
    handle /lang-tutor/* {
        reverse_proxy 127.0.0.1:5190
    }

    handle {
        respond 404
    }
}
```

The server accepts both prefixed forms, so `/lang-tutor` and `/lang-tutor/`
serve the same app entry point.

## Operational Checks

```bash
systemctl status lang-tutor.service --no-pager
journalctl -u lang-tutor.service --since "30 minutes ago" --no-pager
docker image inspect lang-tutor-toolchains:latest >/dev/null
docker run --rm --entrypoint objdump lang-tutor-toolchains:latest --version >/dev/null
sudo -u lang-tutor env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin rustc --version
sudo -u lang-tutor env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin basedpyright --version
```

Model-list failures are not expected in server logs because model discovery is
performed directly from the user's browser to the selected provider. HTTP error
bodies are surfaced in the app. Browser/network failures surface as a provider
reachability message and the browser DevTools Network tab may show the lower
level reason, such as `ERR_CONNECTION_RESET`.
