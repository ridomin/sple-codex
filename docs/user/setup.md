# Spotify setup

You need an active Spotify Premium subscription and your own Spotify Development Mode app. `sple` is a local tool; it has no shared app credentials or hosted server.

1. Open the [Spotify developer dashboard](https://developer.spotify.com/dashboard), create your app and enable the Web API.
2. Register **`http://127.0.0.1/callback`** as its redirect URI, with no port. Do not use `localhost`. Spotify permits a dynamically assigned port for a registered loopback IP address.
3. Copy the app's Client ID. Set `SPLE_SPOTIFY_CLIENT_ID` in the environment or the user config `.env` described in [commands](commands.md). No Spotify client secret is required or stored.
4. Run `sple auth login`. The authorization URL always appears on stderr; `sple` tries to open your browser, including an opener for WSL. Grant access, then check `sple auth status`.

For a checkout, replace `sple` with `node dist/cli/main.js` after building. On POSIX, an environment-only login is:

```sh
SPLE_SPOTIFY_CLIENT_ID=your-client-id node dist/cli/main.js auth login
```

`auth login --no-browser` prints the URL and waits for the local redirect. For SSH/headless use, `auth login --manual` starts no listener: authorize in any browser and paste the resulting full redirect URL back into the terminal, even if the browser cannot load it. The command verifies OAuth state and exchanges the code with its stored PKCE verifier. A loopback login times out after 10 minutes.

Login requests the scopes needed by the supported commands: private/collaborative playlist reads, Liked Songs reads, and public/private playlist writes. Each operation checks its required scopes and gives a login instruction if one is missing. Tokens refresh automatically, while `auth status` always remains offline.

`auth logout --provider spotify` deletes local Spotify tokens and links to the [Spotify account Apps page](https://www.spotify.com/account/apps/) for manual grant revocation. It keeps your Client ID configuration and user-created exports.

S1–S3 were confirmed by the project owner; the [spike record](../spikes/M1-spotify-spikes.md) documents the evidence. The exact non-Premium error was not captured: a Premium-related 403 gets a specific explanation, while other access failures remain generic.
