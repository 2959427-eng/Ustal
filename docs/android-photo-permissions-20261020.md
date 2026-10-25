# Android photo permission scope

USTAL attaches user-selected photos; it is not a broad gallery manager. This change removes explicit READ_MEDIA_IMAGES and blocks both READ_MEDIA_IMAGES/READ_MEDIA_VIDEO against dependency manifest contributions. Camera, microphone and notifications permissions remain unchanged. No UI/profile/helper/auth changes.

Installed Expo image-picker57.0.16 uses AndroidX PickVisualMedia/PickMultipleVisualMedia and its launchImageLibraryAsync has no broad library permission prerequisite. Its explicit requestMediaLibraryPermissionsAsync returns an empty permissions array on Android33+, so this fix does not claim that current JS displayed a broad-access prompt there. Existing legacy permission pre-gates are unchanged and require separate device assessment.

Evidence:

- `node --test scripts/android-photo-permissions.test.cjs`: baseline2RED, candidate2PASS.
- Offline installed Expo57 config/mod introspection using the candidate Android config: baseline active READ_MEDIA_IMAGES becomes tools:node="remove" for both image/video permissions, with no active broad declarations. Expo's withBlockedPermissions plugin emits those native manifest merger directives.
- Private script/JSON: `ustal-release-candidates/android-permissions-introspect-20261020.*` outside Git. Adapter reuses installed dependencies from the unchanged checkout; no package installation or native generation.
- Mobile124/124 and mobile typecheck run against existing dependency checkout; tracked mobile source byte-compared with candidate excluding the deliberately changed app.json. These tests do not certify native permissions.

No Gradle merged manifest, APK/AAB or Play review verified. Before submission, inspect release merged manifest/AAB to confirm removals and assess remaining legacy storage permissions/maxSdk limits; perform camera/gallery/upload/cancel tests on supported devices. No EAS paid build, store submission, production operation or profile helper change.

Policy source: https://support.google.com/googleplay/android-developer/answer/14115180 — infrequent photo/video needs should use system picker and remove broad permissions. SDK guidance: https://docs.expo.dev/versions/latest/sdk/imagepicker/ .
