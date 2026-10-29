# Bluesky's moderation, off for adults

An adult can turn Bluesky's moderation labeler off in Moderation settings
("Use Bluesky's moderation"). Anyone else keeps it.

## Who may turn it off

`lock.ts`: an account whose saved birthdate makes it 18 or over, or, where
Horizon can't read the birthdate, whose declared-age preference says 18 or
over. Not a minor, not an account with no known age, and not while the
app's age check keeps adult content off (`#/horizon/age-checks`). Until
preferences load, the labeler stays on.

## What it changes

`apply.ts` takes Bluesky's labeler off the global app labelers
(`Client.appLabelers`). That list goes on every AppView and chat request,
and the SDK's `getPreferences` puts it first in the account's labelers, so
both the server's labels and the client's moderation drop it.
`BskyModerationSync` (in `HorizonHost`) applies the choice and reads
everything again when it changes.

What stays:

- the country labelers on the same list (legal blocks where the user is);
- takedowns, which Bluesky applies on its own servers;
- self-labels, and every labeler the account subscribes to.

## Where it's kept

Per account, on the device (`horizonBskyModerationOff` in account storage),
not in a public record, so the choice isn't announced.
