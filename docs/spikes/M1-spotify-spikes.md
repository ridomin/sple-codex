# M1 Spotify spike record

## Provenance

On 2026-10-13, Rido confirmed S1–S3 in this implementation session: **“verified, assume the spikes work”**. This records the owner's confirmation of the results previously dated 2026-10-02 in the requirements. Original request/response captures, timings, client/account details and test ISRCs were not supplied. No new authenticated Spotify requests were run by the implementation agent. Automated fixtures are synthetic examples based on the documented response contract, not purported live captures.

## S1: ISRC search filter

Owner-confirmed: `q=isrc:<ISRC>` works, and track/search objects retain `external_ids.isrc`. The adapter declares `isrcSearchMode: 'filter'` and exports ISRC when present, otherwise `null`. The [current search reference](https://developer.spotify.com/documentation/web-api/reference/search) documents the ISRC filter and response field.

## S2: Collaborator access to playlist items

Owner-confirmed: collaborative playlists that are not owned can be read. Non-collaborative followed playlists return 403 on `/items`, and editorial playlists 404. Readability uses ownership or the presence of the metadata `items` object; it does not rely on the collaborative flag. A subsequent 403/404 becomes the documented access restriction and copy-to-owned-playlist workaround. This is consistent with the [migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide).

## S3: Page-size limits

Owner-confirmed limits: playlists 50, liked tracks 50, playlist items 100, search 10; search offset + limit ≤1000. M1 uses these values. The public [playlist-items reference](https://developer.spotify.com/documentation/web-api/reference/get-playlists-tracks) currently lists a maximum of 50, while the confirmed spike reports 100. The public reference is therefore not independent confirmation of 100. Reading follows the page's actual next offset; concurrent item reads are enabled only where returned page size matches the requested size, so a lower effective page size cannot silently skip items.

The requirements' prior 2–4 second live export claim is not independently reproduced here. Deterministic mocked performance checks cannot establish real network throughput.

## S4: Premium detection (unverified)

No non-Premium app-owner response was supplied. The adapter uses the approved fallback: HTTP 403 with `error.message` matching `/premium/i` means Premium is required. Other 403 responses retain a generic access restriction. The login token is saved only after `/me` successfully returns a validated identity.
