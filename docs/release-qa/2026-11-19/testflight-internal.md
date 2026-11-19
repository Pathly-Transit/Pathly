# First internal TestFlight build — November 19, 2026

The first production build has finished in EAS, uploaded successfully and passed Apple processing. Version `0.1.0` build `2` is available to the existing internal group; Apple shows Ellie and Sammi invited. Physical-device results remain pending. This record does not establish that the app works on a physical device.

## Artifact and signing

| Item | Recorded value |
| --- | --- |
| Repository main | `e45b3b1` after [PR #33](https://github.com/Transit-Clone/Pathly/pull/33) |
| Build source commit | `16f7aab3ede3be9905bb8d10f3135dc319fb2772` |
| EAS build | [`d990d5df-2278-4b82-b2ea-955a317ba768`](https://expo.dev/accounts/pathlyapp/projects/pathly/builds/d990d5df-2278-4b82-b2ea-955a317ba768) |
| Profile / environment | `production` / `production`, iOS device store build |
| Version / build | `0.1.0` / `2` |
| App / bundle | App Store Connect `6836052767` / `com.mpaxos.pathly` |
| Signing team | `MRANRL5SNC` |
| Distribution certificate | Created and stored in EAS; serial `1D32D1CE54B041F2FE6D8597A306C214`, expires November 19, 2027 |
| Provisioning profile | Created and active; Developer Portal ID `9UR57QCVN7`, expires November 19, 2027 |
| Export compliance | App config declares `ITSAppUsesNonExemptEncryption=false`, based on standard/Apple OS-provided cryptography |

The supplied Issuer ID was saved in the ignored local release environment. Apple API authentication succeeded against the existing app record; store preflight has zero blocking checks. Credential contents are excluded from this record and Git.

## Build and delivery results

| Check | Result |
| --- | --- |
| PR #33 CI | Passed; change merged to main |
| EAS signed production build | **FINISHED**, November 19, 2026 at `21:41:55.674Z` |
| Finished artifact identity / SDK | IPA verified: correct bundle, version/build and signing team; embedded production `main.jsbundle`; arm64, iOS 16.4 minimum, iPhone/iPad; Xcode 27.1 / iPhoneOS 27.1 SDK |
| Apple archive validation | Official local `altool --validate-app` **VERIFY SUCCEEDED with no errors**, November 19 at `21:54:13Z` |
| Exact-build submission | **FINISHED:** [`dabf48ff-2357-4ea5-ae81-1e8dcdc95214`](https://expo.dev/accounts/pathlyapp/projects/pathly/submissions/dabf48ff-2357-4ea5-ae81-1e8dcdc95214), automatic TestFlight setup disabled |
| Apple processing | **VALID**; App Store Connect build ID `61fd1103-28e5-4b22-9ebd-4294259b534d`; exempt encryption confirmed |
| Internal build assignment / invitation | Existing `friends` group has this build and two testers; Ellie and Sammi show **Invited**, November 19 |
| What to Test | Saved directly in App Store Connect for build `0.1.0 (2)`, including core checks and current notification/background limitations |
| Physical iPhone installation and checks | **Not run** |
| External beta / public link | **Not created; wait for Ellie's successful phone check** |

The downloaded IPA SHA-256 is `f0f8318005d5a3ff1d58d044295bf12cbbcd04b330694ce0ce09c038eb688ec3`. Its embedded App Store profile and signed entitlements identify `MRANRL5SNC.com.mpaxos.pathly`, with `get-task-allow=false`, `beta-reports-active=true` and the production APNs entitlement. The entitlement does not establish that an APNs provider credential exists or remote alerts work. Archive signature/resource hashes and Apple's archive validation passed. App Store Connect processing remains a separate delivery check.

The initial scheduling attempt with `--what-to-test` failed before upload because Expo restricts that flag to Enterprise plans. Retrying without the optional flag scheduled the exact-build submission above. Add testing notes in App Store Connect rather than upgrading the Expo plan.

While EAS was queued, the local Apple uploader validated the IPA as a fallback check. EAS then started the original upload; no cancellation or duplicate direct upload was performed.

## Internal tester preparation

The existing internal group `friends` (shown as `FR friends` in the sidebar), ID `50e782fd-b58c-4e88-8288-8ee189f0d75e`, already contained Sammi. Ellie was added through App Store Connect. Apple automatically assigned the processed build to that group; it now contains two testers and one build, with both testers showing **Invited**. No additional group, public link or manual resend was created. An invitation does not establish a working installation.

The previously saved beta description, feedback contact and marketing/privacy URLs remain in place. TestFlight's beta-review contact and reviewer-access fields are empty. However, the existing iOS `1.0` App Store review record already contains Sammi's complete contact details, a required demo account with credentials, and review notes. The saved reviewer account matches an approved backend admin; do not copy those credentials into beta review. Validate guest coverage or arrange a dedicated non-admin reviewer account, and check that the existing NYC route-testing instructions fit this build. No new demo account was created and no beta-review fields were changed.

## Physical-device checks still required

Record the version/build, iPhone model, iOS version, account type, permissions and failures.

1. Install from TestFlight and cold-launch twice without Expo Go or Metro. Try guest and an existing email account; confirm account state after reopening.
2. Check Maps tiles, current location, nearby departures, place search and route planning. Deny location once, grant it in Settings, and confirm recovery.
3. Start a short familiar trip; check boarding, stop progress, transfers/exit guidance, Back/Resume and relaunch preserving the same trip.
4. Allow notifications and test local approaching-stop alerts, voice and haptics. Change settings mid-trip, then End; verify speech and pending trip notifications clear.
5. Separately lock the phone and switch apps before an exit. Record whether progress and warnings update on time, then check reconciliation on return. Existing foreground location behavior does not establish reliable background progression.

Use the full [device script](../2026-11-12/native-platform-notes.md#exact-remaining-physical-device-script) for wider QA, including iPad while supported.

## Remaining scope

- Remote service-alert push has no APNs credential configured in this setup. The ASC team-key flow cannot create that push key; Apple user authentication is required. Local trip notifications are separate and still need device verification.
- Native Google OAuth remains unconfigured; this beta uses email/guest access.
- Locked-screen behavior, iPad and broader release QA remain unverified. Existing public App Store version `1.0` still needs alignment before public release.
- After Ellie confirms the installed build works, complete external-beta review details, submit for TestFlight App Review as required, and enable a public testing link only when eligible. This does not publish an App Store release.
