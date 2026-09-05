// Vitest setup: jsdom + testing-library cleanup between tests.
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => cleanup());

// The build stamps this in via vite `define`; tests need a value too.
globalThis.__APP_VERSION__ = globalThis.__APP_VERSION__ || 'test';
// jsdom has no layout: the modal scroll lock calls scrollTo on unlock.
window.scrollTo = () => {};
