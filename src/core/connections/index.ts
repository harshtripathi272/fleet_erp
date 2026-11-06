/**
 * Connections to outside services (#59): kinds, one adapter file per provider, secrets by name, signed
 * webhooks. Adding a provider is a file in ./providers that calls `registerProvider`, imported below, and a test.
 */
import './providers/messages.js';
import './providers/email.js';
import './providers/whatsapp.js';
import './providers/rates.js';
import './providers/routing.js';
import './providers/gps.js';
import './providers/storage.js';
import './providers/money.js';

export * from './registry.js';
export * from './types.js';
export * from './secretSetup.js';
