// SPDX-License-Identifier: GPL-3.0-or-later

import { bytesToHex } from "./binary.js";

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}
