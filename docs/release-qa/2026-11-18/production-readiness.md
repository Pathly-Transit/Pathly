# TestFlight production preparation — November 18, 2026

Follow-up to PR #31, based on main `4382611`. This record contains configuration names and outcomes, without keys, tokens, passwords or admin addresses.

## Current state

- App Store Connect app `6836052767` matches `com.mpaxos.pathly`.
- Expo access for `elemels` now includes the permissions needed for project/configuration work.
- The supplied Apple team API key is stored privately. **Its Issuer ID is the remaining missing store-preflight input.**
- EAS has no iOS distribution certificate/provisioning configuration and no managed App Store Connect API key to reuse. The first signing setup is still required.
- The completed EAS iOS build is `ios-simulator`, version `0.1.0`, build `1`. App Store Connect TestFlight has **No Builds**.

## Completed configuration work

### Expo production

- Pinned production Node.js to `24.9.0`, matching `.nvmrc` and the repository engine range. Store distribution, production environment selection and remote build-number increments are retained.
- Confirmed all six Firebase settings match the approved shared configuration and project `pathly-b7f0f`.
- Found conflicting project/account `GOOGLE_MAPS_IOS_API_KEY` values. Google Cloud verified the newer **Pathly iOS Maps** key is restricted to `com.mpaxos.pathly` and Maps SDK for iOS. Updated only the stale project production value to that exact key, preserving its Sensitive visibility and environment scope. Both definitions now agree; the account/preview configuration was preserved.
- Read the deployed backend's canonical `ADMIN_EMAILS` through Google Cloud and verified it matches the existing five-person production client list. After explicit approval of those identities and production scope, added the Sensitive, production-only `ADMIN_EMAILS` variable. Existing identities and backend authorization were preserved; no backend was deployed.
- Synchronized ignored local iOS Maps/admin settings to the verified production configuration. Private rollback records are outside Git.

### App Store Connect

- Saved previously-empty Test Information: factual beta description, the existing public support email, marketing URL and privacy URL.
- Preserved the existing internal group **FR friends**. No groups/testers were added, and no invitations were sent.
- Preserved review-contact, reviewer-login and EULA fields for the team's external-beta choices.

## Verification

| Check | Outcome |
| --- | --- |
| EAS production schema | Valid: Node `24.9.0`, store distribution, production environment, non-simulator |
| Actual production app config | Passed in isolated staging using production values with local dotenv fallback disabled; correct Firebase project, iOS key/bundle and five canonical admins |
| Local preflight | Passed |
| Store preflight | Only failure: missing team-key Issuer ID |
| Native Places REST fallback | HTTP 200; five predictions from one public station autocomplete query |
| Public landing/help/privacy URLs | All returned HTTP 200 HTML |
| Actual EAS archive stage | Completed without signing, remote build or version changes; required app/config/scripts included; `.env`, private keys, signing files, dependencies and scratch contents excluded |
| Existing simulator evidence | Prior unsigned arm64 Debug simulator compilation passed; no repeat compile for this configuration-only follow-up |

The archive includes 46 existing sync duplicates that are byte-identical to their originals. They were left untouched. The empty scratch-directory entry contains no scratch files.

## Remaining work

1. Obtain the actual Issuer ID from the account holder and set it in the ignored release environment file. Validate the team key's role during first signing setup.
2. Create the initial Apple Distribution certificate and App Store provisioning profile through the authorized EAS flow. Then build the signed production artifact, verify its app/team/version/SDK, and upload the selected build.
3. Resolve Apple processing/export-compliance prompts using the app's actual behavior, then add the processed build to the intended internal group.
4. Run the [physical-device script](../2026-11-12/native-platform-notes.md#exact-remaining-physical-device-script), including permissions, Maps, search, navigation, sound, resume and locked-screen behavior.

Native Google login remains unavailable: no iOS OAuth client exists in either checked Google project, and no iOS client ID is configured in EAS. Email/guest access is the existing internal-beta path. Enabling Google requires a real client configuration and the documented Apple equivalent-login review decision.

The generic Places fallback key is functional but broadly restricted by API and unrestricted by application. Review key hardening before a public release. Locked-screen navigation remains unverified, iPad layout remains in scope, and the public listing's `1.0` version still needs alignment with the intended release version. These are distinct from getting the first internal TestFlight build uploaded.

No signed `.ipa`, TestFlight upload, device test, push campaign, tester invitation or public release was performed by this preparation.
