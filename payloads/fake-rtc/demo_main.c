// SPDX-License-Identifier: GPL-3.0-or-later

#include "fake_rtc_menu.h"

int main(void) {
    SiiRtcInfo info;
    payload_probe();
    while (1) {
        payload_gettimedate(&info);
    }
    return 0;
}
