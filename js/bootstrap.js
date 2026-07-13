// SPDX-License-Identifier: GPL-3.0-or-later

import { APP_VERSION } from "./domain/constants.js";
import { uiMessage } from "./domain/messages.js";

const versionElement = document.querySelector("#app-version");
if (!versionElement) throw new Error("Required element #app-version is missing.");
versionElement.textContent = APP_VERSION;

import("./app.js").catch((error) => {
  const status = /** @type {HTMLElement | null} */ (document.querySelector("#status-region"));
  if (status) {
    status.textContent = uiMessage.startupFailed(error.message || String(error));
    status.dataset.tone = "error";
  }
  throw error;
});
