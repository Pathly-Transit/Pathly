# iOS TestFlight release

This runbook prepares a signed iOS build for TestFlight. It does not certify public-release readiness. The [November 12 QA assessment](release-qa/2026-11-12/assessment.md) records passing JavaScript checks and an Android debug build, but no completed iOS build or physical-device navigation test. Record new results against the exact commit and build tested.

As of November 18, the existing App Store Connect record has been verified: Apple ID `6836052767`, bundle ID `com.mpaxos.pathly`. Expo project access now works as `elemels`. Production configuration has been checked and corrected, beta information is saved, and the existing internal group is `FR friends`. The supplied API key is stored locally with its path and Key ID; its Issuer ID is the remaining missing input in store preflight. Initial Apple signing setup, a signed production `.ipa`, upload and physical-device testing still follow. See the [production readiness record](release-qa/2026-11-18/production-readiness.md).

## App identity

| Setting | Expected value |
| --- | --- |
| iOS bundle identifier | `com.mpaxos.pathly` |
| App Store Connect Apple ID | `6836052767` |
| Expo project | `@pathlyapp/pathly` |
| EAS project ID | `deefeb3d-b292-44e7-8e70-64f8f7bf6a87` |
| Current display version | `0.1.0` |
| Store build profile / environment | `production` / `production` |
| Production Node.js | `24.9.0`, matching the repository runtime |
| iPad support | Enabled; include iPad in testing or make an explicit supported-device decision before release |

Use `mobile/app.config.js` and `mobile/eas.json`. Android keeps `com.pathly.app`; its existing store identity is separate. The `ios-simulator` profile produces a simulator build and cannot be uploaded to TestFlight. The production profile produces the store artifact and increments the remotely managed build number.

## Confirm access and collect the remaining inputs

Use the existing Apple Developer membership and the account holder's App Store Connect app. Each teammate should accept their invitation using their own Apple account. An individual developer membership can invite App Store Connect users without giving those users access to the membership's signing resources; the account holder may need to arrange certificates and provisioning. An App Store Connect **team API key** and an **individual membership** describe different things. See [Apple's account-role guidance](https://developer.apple.com/help/app-store-connect/manage-your-team/overview-of-accounts-and-roles/) and [Expo's signing-role guidance](https://docs.expo.dev/app-signing/apple-developer-program-roles-and-permissions/).

| Input | Where to verify it / action |
| --- | --- |
| Supplied `.p8` API private key and Key ID | Already prepared on this workstation in ignored `mobile/.credentials/`, with the path and Key ID in ignored `mobile/.env.testflight.local`. On another machine, retrieve the shared file through the approved private channel. Confirm the key is still active and its role permits uploading builds. Keep its contents out of Git, screenshots, chat, and logs. |
| API Issuer ID | For the supplied team key, ask the account holder to copy this from **App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys**. A Team ID is not an Issuer ID. |
| Apple Team ID | Confirm the previously supplied Team ID matches the developer membership used to sign `com.mpaxos.pathly`. It identifies the signing team, not the app record. |
| Numeric App Store Connect app ID (`ascAppId`) | Verified as `6836052767` in [Pathly App Information](https://appstoreconnect.apple.com/apps/6836052767/distribution/info) and set in the submission profile. Anyone with the relevant app-information access can retrieve it; it is not specific to the teammate entering metadata. This is not the bundle identifier or the Apple account email. |
| Signing materials | Confirm an Apple Distribution certificate and App Store provisioning profile for the bundle ID are available to EAS, or arrange their initial setup with the account holder. The `.p8` upload key alone does not establish that signing is configured. |
| Expo access | Sign in with an account that can access `@pathlyapp/pathly` and its production environment. |

The initial Expo access denial has been resolved. Project information, production variables, build history and credential metadata are readable with the current account. EAS currently has no iOS distribution signing credentials or managed App Store Connect API keys. Its completed iOS cloud build is simulator-only and cannot be submitted to TestFlight. Keep the existing project ID and arrange first-time signing using the supplied team key once the Issuer ID is available.

Use the existing Pathly App Store Connect record; do not create another record to work around missing access. The submission profile pins its confirmed `ascAppId` to `6836052767`, matching `com.mpaxos.pathly`. Both the store check and submission wrapper require a numeric ID: the wrapper stops before launching EAS if it is removed or malformed. [Expo explains where to find `ascAppId`](https://docs.expo.dev/submit/ios/#how-to-find-ascappid).

The account holder should supply the Issuer ID if invited users cannot access **Integrations**. A redirect from that restricted section does not establish that the app or backend is down.

The local `.credentials` directory is restricted to its owner, with owner-only read/write access on the key and release environment file. Preserve those permissions. On another machine, use a private directory outside the checkout, the ignored credential directory, or the authorized EAS credential flow. Never put a private credential in an `EXPO_PUBLIC_` variable; those values are compiled into the app. Back up signing materials through the team's approved secret storage. Apple API keys can only be downloaded once; [Apple's API-key guidance](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/) explains generation, roles, and revocation.

The repository's preflight, build and submit commands load ignored `mobile/.env.testflight.local`; it holds local release inputs rather than app-bundled settings. The production iOS submission profile reads the API values from the resulting process environment:

| Environment variable | Value |
| --- | --- |
| `EXPO_ASC_API_KEY_PATH` | Absolute path to the private `.p8` file on the submission machine |
| `EXPO_ASC_KEY_ID` | Key ID for that same active team API key |
| `EXPO_ASC_ISSUER_ID` | Issuer ID copied from the account holder's Team Keys page |
| `EXPO_APPLE_TEAM_ID` | Confirmed Apple signing-team ID; must agree with the submission profile |
| `EXPO_APPLE_TEAM_TYPE` | `INDIVIDUAL` for the existing developer membership; this does not make the supplied team API key an individual API key |

The existing local file contains the key path, Key ID and team metadata; add the Issuer ID when the account holder supplies it. Keep every value paired with the correct account/key; never substitute the Team ID for the Issuer ID. Edit the ignored local file through approved local secret tooling, without printing the `.p8` contents or pasting them into a terminal command. The submission profile's `appleTeamId` identifies the intended team.

## Verify the build environment

Run the repository commands below from the repository root. Direct Expo/EAS commands belong in `mobile/`. Sign in to EAS first with `npx --yes eas-cli@27.9.0 login` from that directory, then use `npx --yes eas-cli@27.9.0 whoami` to check the account. Confirm access to the intended project before building.

```sh
npm run ios:preflight
```

This checks local app metadata and client-configuration readiness. It does not log in to Apple, inspect live EAS production values, validate key permissions, or prove that a signed build runs.

The canonical `ADMIN_EMAILS` production variable and ignored local configuration now match the verified deployed five-person backend list, following explicit user approval. Local preflight passes. Store preflight additionally checks the API key and app record; its remaining failure is the missing Issuer ID. Do not substitute a Team ID or another UUID for it.

Verify **the EAS production environment**, using the [configuration reference](mobile-configuration.md), before queuing a cloud build:

- All required `EXPO_PUBLIC_FIREBASE_*` values point at the intended Firebase project/backend.
- `GOOGLE_MAPS_IOS_API_KEY` is present, enables Maps SDK for iOS, and is restricted to `com.mpaxos.pathly`. Check place-search access and key restrictions separately.
- `ADMIN_EMAILS` contains the approved canonical list for this build; backend authorization remains independent of UI visibility.
- If iOS Google login is enabled, its OAuth client is registered for `com.mpaxos.pathly` and the native client/redirect configuration is correct. Test login and deletion reauthentication on the built app.
- If remote service-alert push is included, configure the iOS/APNs credential through the authorized EAS flow and verify actual delivery. Local trip-step notifications and remote push are different paths; Android's FCM JSON is not an iOS APNs credential.
- Support/privacy destinations are the intended live public URLs.

The ignored local `mobile/.env` is not evidence that the EAS production environment has the same values. Confirm presence and restrictions without posting credential values. Native configuration or bundled environment changes require a new build.

## Build, inspect, and upload

Run the applicable repository validation for the chosen release commit and record the outcome. `npm run build` exports JavaScript bundles; it does not create a signed `.ipa`.

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

After local preflight and cloud-environment review, queue the production iOS build:

```sh
npm run build:ios
```

The wrapper uses EAS CLI 27.9.0 from `mobile/`. When the local release file contains only part of the API-key triple, the build command leaves that incomplete triple out of the build process so EAS can use existing signing credentials. If the shell itself explicitly exports an incomplete `EXPO_ASC_*` triple, the wrapper stops: complete it with the correct Issuer ID or unset those partial shell inputs before using existing signing. The API upload key is not a substitute for the distribution certificate and provisioning profile.

On the initial build, resolve Apple team selection, distribution certificate, provisioning profile, and required capabilities with the account holder. Review any proposed signing changes before applying them. An App Store Connect user invitation does not by itself prove access to those resources. Record the EAS build ID, Git commit, display version, build number, bundle ID and signing team from the finished artifact.

Before uploading, configure the submission inputs described above and run the store-input check:

```sh
npm run ios:preflight -- --store
```

Resolve the store check's failures before continuing. It validates local inputs; Apple account access, active credentials and the destination app record still require verification. Upload the intended successful production build, checking its build ID rather than assuming the newest build belongs to this release:

```sh
npm run submit:ios -- --id <EAS-build-id>
```

Replace the placeholder with the exact successful production build ID. The wrapper also accepts an explicit `--path` or `--url` to an intended `.ipa`; it rejects an unspecified source and `--latest`. Before launching EAS, submission requires the confirmed numeric `ascAppId` and all three API inputs, including the Issuer ID. Keep using the existing App Store Connect app record.

Submission uploads the binary to App Store Connect. After processing, inspect **Pathly → TestFlight** and resolve processing errors or export-compliance questions using the app's actual encryption behavior. Uploading does not publish the app or send it through public App Review. [Expo's iOS submission guide](https://docs.expo.dev/submit/ios/) describes this flow.

## Distribute a beta and test on devices

Start with an internal TestFlight group containing the approved App Store Connect users who have access to Pathly. Add the processed build and testing notes. [Apple's internal-testing guide](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/) describes eligibility and group setup.

An internal group named **FR friends** already exists. Reuse the team's intended group; the preparation work did not create another group, change memberships, or send invitations. Test Information now contains the beta description, existing public support email, and marketing/privacy URLs. Beta-review contacts, sign-in information and EULA choices remain team-owned inputs for external testing.

For people outside App Store Connect, use an external TestFlight group and supply beta-review information and working reviewer access. The first external build requires TestFlight App Review; subsequent builds may also need review. Login, privacy and app-completeness issues can affect beta review too, so resolve those review risks before expanding externally. A TestFlight invitation/public testing link does not make the app a public App Store release. [Apple's external-testing guide](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers/) covers review and distribution.

### Internal beta: What to Test

Paste this into the internal group's **What to Test** field and include the build number in the invitation:

> Test place search, Maps, nearby departures, and planning and starting a trip. Check location and notification permission denial/recovery, Back/Resume and app relaunch, and voice and notification settings. During a real trip, check guidance, transfers, arrival, and cleanup after End. Locked-screen and switched-app progression are under test; report whether guidance advances and warnings arrive on time. Include the app/build number, device model, OS version, permission settings and steps to reproduce each issue.

For each run, record device model, OS, app version/build number, permissions, account type, and observed result. Use dedicated test accounts for account changes. At minimum:

1. Install through TestFlight, cold-launch twice, and check splash, Maps, nearby transit, place search and route planning. Confirm the app works without Metro or Expo Go.
2. Exercise password/guest access and every enabled login provider, cancellation, relaunch, and reauthentication. Verify account deletion using an explicitly disposable test account and check the associated data cleanup.
3. Test location and notification denial, later Settings grants, and permission recovery without repeated prompts.
4. Take a real journey with walking, boarding, intermediate stops, transfer, exit and arrival. Check guidance, map follow/pan/recenter, stop counts and resumed trip identity.
5. Before an exit, separately lock the phone and switch apps. Record whether guidance actually advances and the correct warning arrives on time. Return to the app and check reconciliation, duplicates, and stale alerts. Do not treat a notification remaining visible as evidence of background progression.
6. Change voice/notification settings; end or replace a trip while a warning is pending; confirm no later stale warning. Check background return, process relaunch, Resume and cleanup.
7. Check small iPhones, safe areas, keyboard interaction, large text, VoiceOver, light/dark themes, interruption/audio behavior, and iPad while support is enabled. Record battery/thermal behavior during a representative ride.

The [existing device script](release-qa/2026-11-12/native-platform-notes.md#exact-remaining-physical-device-script) has additional detail. Simulated movement is useful for repeatable demonstrations but does not replace real location, locked-screen, audio or battery testing.

## Remaining review and release decisions

- **Locked-screen alerts:** current source configures when-in-use location and foreground progression, without a background task. Decide the launch promise. If timely locked-screen get-off alerts remain part of it, implement an explicit native lifecycle with appropriate consent, reconciliation and cleanup, then verify it on hardware. Do not advertise this as established behavior.
- **iOS login:** native Google sign-in is conditional on the iOS OAuth ID, which is absent locally; no Sign in with Apple implementation is currently present. Verify the actual production offering. If Google login is offered for the primary account, resolve [Apple Guideline 4.8](https://developer.apple.com/app-store/review/guidelines/#login-services) before review unless a documented exception applies. Guest/email login alone does not establish an exception. Include this decision in external-beta preparation as well as public-release preparation.
- **Store and reviewer material:** reconcile the app information already being prepared with the final build: app description, screenshots for supported devices, age rating, support/privacy URLs, accurate privacy disclosures including third-party SDKs, export-compliance answers, and reviewer instructions/access. Verify policy and deletion behavior against the actual build and backend. Do not invent answers from a dependency list.
- **Marketing version:** the existing App Store version is currently `1.0`, while the Expo app configuration is `0.1.0`. Confirm the intended public-release version before selecting its release build.
- **Release evidence:** close or explicitly scope the outstanding findings in the [release assessment](release-qa/2026-11-12/assessment.md). Neither this guide nor a passing preflight is release signoff. Keep unrun device combinations and unresolved processing/review issues visible in the handoff.

Public availability requires a separate App Store version, completed metadata, App Review and the team's release decision. [Apple's publishing overview](https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/overview-of-publishing-your-app-on-the-app-store/) describes that final stage.

## Verification record — November 18, 2026

Preparation is based on main commit `4fa282a` on branch `codex/testflight-prep`.

| Check | Result |
| --- | --- |
| Locked workspace dependencies | Reinstalled with `npm ci`; no dependency or lockfile change in this patch |
| Release-helper tests | 3 passed; includes preventing submission before the existing numeric app ID is confirmed and suppressing private-key parse details |
| Mobile lint and TypeScript | Passed; lint used `--no-cache` after replacing the stale dependency tree |
| Mobile Jest | 66 suites, 653 tests passed |
| iOS JavaScript export | Passed with one Metro worker; Hermes bundle approximately 5.3 MB |
| EAS configuration | Version 27.9.0 schema/resolution passed with fixture API inputs; existing Android submission settings preserved |
| Credential exclusion | Actual EAS archive ignore rules exclude the local API key, release environment, scratch directory and dependencies |
| Native project generation | Passed in isolated temporary staging; bundle ID, URL schemes, Maps integration and opaque 1024 px icon checked |
| CocoaPods | Installed successfully: 120 dependencies, 121 pods |
| Unsigned simulator compilation | **BUILD SUCCEEDED**: Pathly scheme, Debug configuration, arm64, Xcode 27.2 / iOS Simulator SDK 27.2, code signing disabled; minimum runtime iOS 16.4, iPhone and iPad |
| Expo access | Initial denial resolved; current project, environment, build and signing metadata reads succeed |
| Apple app record | Verified Apple ID `6836052767` and bundle ID `com.mpaxos.pathly` in the signed-in App Information page; submission profile updated |
| Local store preflight | Local checks pass; remaining store failure is the team-key Issuer ID. Confirmed app ID, canonical admins, Firebase, iOS Maps, key ID and private-key shape checks pass |

The simulator result is a Debug development-client binary without an embedded production JavaScript bundle. It was not launched or device-tested and is not a signed Release archive or TestFlight `.ipa`. The later [production audit](release-qa/2026-11-18/production-readiness.md) verifies cloud configuration, simulator-only build history, absent signing credentials and empty TestFlight build history. Native Google OAuth remains unconfigured; the existing iOS beta uses email/guest access. No signed cloud build, upload, backend deployment, account-role change or public release was performed.
