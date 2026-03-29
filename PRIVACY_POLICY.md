# Privacy Policy - Hayaku Translate

Last updated: 2026-03-29

## Overview

Hayaku Translate is a browser extension that provides translation powered by the Gemini API. This privacy policy explains how we handle your data.

## Data Collection

**We do not collect, store, or transmit any personal data to our servers.**

### Data processed locally on your device

- **API Key**: Your Gemini API key is stored locally in Chrome's `chrome.storage.sync` and is never sent to any server other than the Gemini API endpoint.
- **Translation Cache**: Translated text is cached locally using IndexedDB to improve performance. This data never leaves your device.
- **Settings**: Your preferences (language, model selection, etc.) are stored locally via `chrome.storage.sync`.

### Data sent to third-party services

- **Translation text**: When you translate text, it is sent to the Gemini API via Cloudflare AI Gateway (`gateway.ai.cloudflare.com`) for processing. This is required for the translation functionality.
- **API Key**: Your Gemini API key is sent to the Gemini API as authentication. It is transmitted securely over HTTPS.

We do not control how Google (Gemini API) or Cloudflare processes this data. Please refer to their respective privacy policies:
- [Google AI Privacy Policy](https://ai.google.dev/terms)
- [Cloudflare Privacy Policy](https://www.cloudflare.com/privacypolicy/)

## Data Storage

All data is stored locally on your device using Chrome's built-in storage APIs. No data is stored on external servers operated by us.

## Permissions

- **storage**: To save your API key, settings, and translation cache locally.
- **contextMenus**: To provide right-click "Translate" option.
- **activeTab**: To access selected text on the current page for translation.
- **Content Scripts (all URLs)**: To enable text selection translation and full-page translation on any webpage.
- **Host Permission (gateway.ai.cloudflare.com)**: To send translation requests to the Gemini API via Cloudflare AI Gateway.

## Changes

We may update this privacy policy from time to time. Changes will be posted in this document.

## Contact

If you have any questions, please open an issue at: https://github.com/nyanko3141592/Hayaku/issues
