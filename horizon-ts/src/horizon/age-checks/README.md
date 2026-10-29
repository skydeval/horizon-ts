# Age checks

Bluesky's age assurance is switched off in Horizon (`AGE_ASSURANCE_OFF`).
This folder is the one place ages are checked, and only where a state law
requires it.

## Where it runs

- **In the app, never on web.** The US state App Store Accountability Acts
  cover apps distributed through app stores, not websites.
- **Only in a covered state, from its start date** (`regions.ts`): Texas
  now, Utah from 2026-12-31, Louisiana from 2027-07-01. The state comes
  from the location lookup the app already does. An unknown location is
  not covered.
- **Only for installs from the store.** The check asks the phone's store
  (Google Play Age Signals; Apple's Declared Age Range on iOS 26). If the
  store can't be asked, as with an APK installed by hand, nothing changes:
  such an install isn't store-distributed.

## What it does

From the store's answer (`decide.ts`):

| Answer | Effect |
|---|---|
| 18 and up, or no duty applies | nothing changes |
| 13 to 17 | adult content locked off |
| a parent's approval pending | adult content locked off |
| not shared, unknown, or verify in the store | adult content off, with a button to share or open the store |
| under 13 | blocked screen |
| a parent declined | blocked screen |

Chat and everything else are untouched. The result drives the same context
Bluesky's screens read (`#/ageAssurance`), so the adult content setting and
the moderation preferences follow it without changes of their own.

## When it asks

The first launch in a covered state shows the store's age sharing screen
once. After that the app refreshes a range already shared without
prompting, and asks again only when the user presses a button.
