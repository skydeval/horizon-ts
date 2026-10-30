# Horizon push

Push notifications for Horizon's Android app, as a Cloudflare Worker at
`push.nearhorizon.app`.

- The app registers its Firebase token with
  `app.bsky.notification.registerPush`, sent through the account's PDS
  (`atproto-proxy: did:web:push.nearhorizon.app#horizon_push`). The PDS signs
  a short service token, so the Worker knows which account is asking; it
  stores only account and token.
- A Durable Object follows Jetstream for posts, likes, reposts and follows,
  and notes the accounts each one concerns (replies, quotes, mentions,
  likes, reposts, follows).
- It then sends a data-only Firebase message: no text, just which account
  should check. The app fetches that account's notifications with its own
  sign-in and shows them, so mutes, blocks and notification settings apply as
  usual.

- A trusted service (Horizon's prism, or the DIDs in the `NOTIFY_SOURCES`
  variable) can ask for a check with `app.nearhorizon.push.notify`, for
  activity the public stream never carries. It sends account DIDs only,
  signed as itself.

## What the operator sees

The service stores each registered account's DID and push tokens. It also
learns which registered accounts had activity and when, including activity
reported by a notify source. It never receives post or message content.
Firebase sees a content-free message to each phone.

## Development

```sh
pnpm install
pnpm test        # vitest
pnpm typecheck   # tsc
pnpm check       # bundle without deploying
```

Deploying needs a Cloudflare token with Workers Scripts: Edit, and the
Firebase service account as a secret:

```sh
wrangler secret put FCM_SERVICE_ACCOUNT < service-account.json
pnpm deploy
```

`GET /status` reports whether the listener is connected and how far behind
the stream it is.

## Licence

MPL-2.0.
