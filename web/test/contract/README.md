# Contract tests

```
npm run test:contract
```

Do the external services still behave the way Hiro assumes?

These are deliberately **not** part of `npm test`. The unit suites are hermetic and
must stay that way — they run on every push, and a network blip must never fail a
PR. These go the other way: they make real calls, and their entire value is telling
you that an upstream service changed under you.

| Suite | Needs | Protects |
| --- | --- | --- |
| `ats-boards` | An internet connection | The Greenhouse / Lever / Ashby response shapes the ATS scraper parses |
| `expo-push` | An internet connection | Expo's push ticket format, including the `DeviceNotRegistered` code that clears dead tokens |
| `ai-providers` | A real API key (see below) | That a model's reply still parses into a score, a classification, and a document |

A suite that cannot run **skips loudly** and the runner counts skips separately, so
"everything passed" can never quietly mean "nothing ran".

## Why these specific things

Every failure mode here is silent, which is exactly why mocking cannot cover them:

* A boards API that renames `absolute_url` makes `scrape()` drop every job for want
  of a URL. The scan then reports "no listings matched" and the user concludes
  their search is too narrow.
* A model that starts wrapping its reply differently makes the score parser return
  its fallback, so good jobs are filed as below-threshold.
* If Expo renames `DeviceNotRegistered`, dead push tokens are never cleared and
  every later send wastes a slot on a phone that no longer exists.

This suite has already earned its place twice: it found that **Lever and Ashby job
descriptions were never HTML-decoded** (only Greenhouse was), so every career-board
description reached the model — and the Needs Attention page — full of `&amp;` and
`&nbsp;`. Both are now fixed, with unit assertions in `test/ats-boards.test.js`.

## Running the AI suites

Set whichever keys you have; only those providers run.

```bash
HIRO_TEST_CLAUDE_KEY=sk-ant-...    npm run test:contract
HIRO_TEST_OPENAI_KEY=sk-...        npm run test:contract
HIRO_TEST_DEEPSEEK_KEY=...         npm run test:contract
HIRO_TEST_GEMINI_KEY=...           npm run test:contract   # + HIRO_TEST_GEMINI_MODEL
```

Each run costs a few cents of real tokens. That is the other reason it is opt-in.

The assertions about model *quality* are deliberately loose — "a backend job scores
above a veterinary nursing job" — because the aim is to detect a broken parser, not
to grade the model. A parser that has silently broken returns the same fallback for
both, which is what that check catches.

## Reading a failure

A failure here usually means an upstream service changed, not that Hiro regressed.
Read the assertion, check the provider's docs, and fix the adapter. If a test board
has simply been renamed or made private the suite says so and skips it — pick
another long-lived public board in `ats-boards.contract.js`.
