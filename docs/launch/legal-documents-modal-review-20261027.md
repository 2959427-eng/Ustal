# Legal-document modals — independent adaptation, 2026-10-27

PASS. Branch codex/legal-documents-modal-v7, base45aa23f257b5834a7ef06d3796a9d65cb90759bb.
Input patch SHA256 verified:66f14ada7e01f517ec962f844cd7858626bc1c025d6ac8efcfac93ffe15370e3. Patch originally targets53b2fe0.

Only legal modal/loader/parser and tests transferred. Old package-lock.json, package.json and jest.config.js excluded; required test dependencies/config already exist in v7. No dependency or native configuration changes. Existing draft session isolation, API session binding and prior navigation tests retained unchanged.

Adaptation: mount document contents only while open and key by page so previous text cannot flash on reopening; abort fetch on close/page switch; stale responses ignored. HTTPS page fetches omit credentials and authorization, disable cache, reject redirects, preserve existing timeout and fail with retry instead of local replacement text.

HTML is parsed into plain React Native Text blocks; no WebView/HTML execution. Scripts/forms/navigation stripped. Anchor destinations and HTML event attributes are never executed; link labels remain selectable text, including mail contact. In-document links are intentionally inert; document entry points open the modal. Tests cover javascript/external URLs and encoded HTML as inert text.

Verification:
- Vitest:35 files,225 tests PASS.
- Expo Router/Jest:4 suites,36 navigation tests PASS, including existing v7 suites.
- Mobile typecheck PASS; lint0 errors/8 existing warnings.
- All five documents fetched read-only from https://api.ustal.site: HTTP200, correct headings, body and server version2026-10-26 parsed. No production writes.
- All five entry points open inside app; cross, Close and Android onRequestClose tested; retries/fresh reopen/cancel/stale responses tested. Real registration name/phone/password/confirmation/checkboxes and real login fields preserved.
- Source diff proves package-lock/package.json/Jest config/session helpers/API client/app.json/eas.json unchanged from45aa23f. No API/worker/database/matching runtime edits.

No physical-device rendering claim: navigation uses actual screens, RN Modal and expo-router in jest-expo with mocked transport. No EAS Build/OTA/deploy/production change. Canonical release/main and other WIP untouched. Inherited canonical baseline guard is not rewritten for this isolated review branch/path; exact parent and PR diff identify this adaptation.
